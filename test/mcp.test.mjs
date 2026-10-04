// `pitroom mcp`: Pitroom as an MCP server on stdio. The tools run the CLI, so these tests speak the protocol
// to a real server process and check the results against what the CLI does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import readline from 'node:readline';
import { CLI, sandbox } from './helpers.mjs';

/** A client for one server process. */
function connect(s, extra = {}) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { cwd: s.repo, env: { ...s.env, PWD: s.repo, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const waiting = new Map();
  const lines = [];
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    lines.push(l);
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      w(m);
    }
  });
  let n = 0;
  const raw = (text) => proc.stdin.write(`${text}\n`);
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} (stderr: ${stderr})`)), 90_000);
      waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  const call = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    assert.ok(m.result, `tools/call ${name}: ${JSON.stringify(m.error)}`);
    return { text: m.result.content.map((c) => c.text).join('\n'), isError: m.result.isError };
  };
  const close = () => new Promise((resolve) => { proc.once('close', resolve); proc.stdin.end(); });
  return { proc, raw, rpc, call, close, lines, stderr: () => stderr };
}
const handshake = (c) => c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;

test('mcp: the handshake negotiates a version, tools are listed with schemas and hints, and the protocol errors are the standard ones', async () => {
  const s = sandbox();
  const c = connect(s);
  try {
    const init = await handshake(c);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'pitroom');
    assert.match(init.result.instructions, /pitroom_run/);
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal((await c.rpc('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05', 'an older version it knows');
    assert.equal((await c.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'an unknown one gets the latest');

    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual((await c.rpc('ping', {})).result, {});

    const { tools } = (await c.rpc('tools/list', {})).result;
    assert.deepEqual(tools.map((t) => t.name), ['pitroom_run', 'pitroom_wait', 'pitroom_status', 'pitroom_show', 'pitroom_review', 'pitroom_audit', 'pitroom_apply', 'pitroom_discard', 'pitroom_stop']);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.ok(t.description.length > 20 && t.title, t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    }
    const run = tools.find((t) => t.name === 'pitroom_run');
    assert.deepEqual(run.inputSchema.required, ['task']);
    assert.deepEqual(run.inputSchema.properties.mode.enum, ['read', 'isolate', 'write']);
    assert.equal(tools.find((t) => t.name === 'pitroom_apply').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'pitroom_status').annotations.readOnlyHint, true);

    assert.equal((await c.rpc('no/such/method', {})).error.code, -32601);
    assert.equal((await c.rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    // a message that is not JSON, and a batch
    const before = c.lines.length;
    c.raw('this is not json');
    await new Promise((r) => setTimeout(r, 300));
    const bad = JSON.parse(c.lines[before]);
    assert.deepEqual([bad.id, bad.error.code], [null, -32700]);
    c.raw(JSON.stringify([{ jsonrpc: '2.0', id: 901, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 902, method: 'ping' }]));
    await new Promise((r) => setTimeout(r, 300));
    const batch = JSON.parse(c.lines.at(-1));
    assert.deepEqual(batch.map((m) => m.id), [901, 902], 'one reply per request, none for the notification');
    // nothing but JSON ever reaches stdout
    for (const l of c.lines) JSON.parse(l);
  } finally {
    await c.close();
  }
});

test('mcp: pitroom_run reads, answers with a receipt, and its run is the CLI\'s run', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: app.txt holds line1 (app.txt:1)' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { task: 'where is app.txt?' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /pitroom ✔ done · read/);
    assert.match(r.text, /SUMMARY: app\.txt holds line1/);
    assert.match(r.text, /refs: 1\/1 verified/);
    assert.match(r.text, /receipt: worker processed/);
    assert.doesNotMatch(r.text, /\x1b/, 'no colour codes');
    const id = RUN_ID.exec(r.text)[0];
    assert.match((await c.call('pitroom_status', { run: id })).text, /done/);
    assert.match((await c.call('pitroom_show', { run: id })).text, /SUMMARY: app\.txt holds line1/);
    assert.match(s.run(['status', id]).stdout, /done/, 'the CLI sees the same run');
  } finally {
    await c.close();
  }
});

test('mcp: a task that starts with a dash is a task, and bad arguments are tool errors, not crashes', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  try {
    await handshake(c);
    const dash = await c.call('pitroom_run', { task: '--help me with this' });
    assert.equal(dash.isError, false, dash.text);
    assert.match(dash.text, /pitroom ✔ done/);
    const run = s.calls().filter((x) => x.argv[0] === 'run').at(-1);
    assert.match(run.argv.at(-1), /--help me with this/, 'the worker got the task text');
    for (const [args, message] of [
      [{}, /"task" is required/],
      [{ task: 'x', mode: 'banana' }, /"mode" must be one of: read, isolate, write/],
      [{ task: 'x', files: 'a.txt' }, /"files" must be a list of strings/],
      [{ task: 'x', waitSeconds: 0 }, /"waitSeconds" must be a number/],
    ]) {
      const r = await c.call('pitroom_run', args);
      assert.equal(r.isError, true);
      assert.match(r.text, message);
    }
    const refused = await c.call('pitroom_review', { run: 'last', range: 'a..b' });
    assert.match(refused.text, /exactly one of "run" or "range"/);
    assert.equal((await c.call('pitroom_show', { run: '19990101-000000-0000' })).isError, true, 'an unknown run is an error');
  } finally {
    await c.close();
  }
});

test('mcp: an isolated change is shown as a patch and applied on request', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'append:app.txt:from the worker;answer:SUMMARY: extended app.txt' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { task: 'extend app.txt', mode: 'isolate' });
    assert.match(r.text, /pitroom ✔ done · isolate/);
    assert.match(r.text, /changes \(in the isolated copy, NOT applied yet\)/);
    const id = RUN_ID.exec(r.text)[0];
    assert.match((await c.call('pitroom_show', { run: id, patch: true })).text, /\+from the worker/);
    assert.ok(!fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8').includes('from the worker'), 'not applied yet');
    const applied = await c.call('pitroom_apply', { run: id });
    assert.equal(applied.isError, false, applied.text);
    assert.match(applied.text, /applied 1 file/);
    assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /from the worker/);
    assert.equal((await c.call('pitroom_apply', { run: id })).isError, true, 'twice is refused');
    assert.match((await c.call('pitroom_discard', { run: id })).text, /discard|already|not an isolated|gone/i);
  } finally {
    await c.close();
  }
});

test('mcp: a run that takes longer than waitSeconds comes back "still running", and pitroom_wait collects it; pitroom_stop ends one', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:4;answer:SUMMARY: slow but done' });
  try {
    await handshake(c);
    const first = await c.call('pitroom_run', { task: 'slow one', waitSeconds: 1 });
    assert.equal(first.isError, false);
    assert.match(first.text, /Not finished yet: call pitroom_wait with \{"runs": \["\d{8}-\d{6}-[0-9a-f]{4}"\]\}/);
    const id = RUN_ID.exec(first.text)[0];
    const done = await c.call('pitroom_wait', { runs: [id], waitSeconds: 60 });
    assert.match(done.text, /pitroom ✔ done/);
    assert.match(done.text, /SUMMARY: slow but done/);
    assert.equal((await c.call('pitroom_wait', {})).isError, true, 'wait needs runs or a group');

    const c2 = connect(s, { MOCK_ACTIONS: 'sleep:30;answer:late' });
    try {
      await handshake(c2);
      const running = await c2.call('pitroom_run', { task: 'long one', waitSeconds: 1 });
      const rid = RUN_ID.exec(running.text)[0];
      assert.match((await c2.call('pitroom_stop', { run: rid })).text, /stopping/);
      assert.match((await c2.call('pitroom_wait', { runs: [rid], waitSeconds: 30 })).text, /pitroom ■ stopped/);
    } finally {
      await c2.close();
    }
  } finally {
    await c.close();
  }
});

test('mcp: pitroom_audit re-checks a read run with another worker, and a review reads an isolated change', async () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a' });
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: app.txt holds line1\nAUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { task: 'what is in app.txt?' });
    const id = RUN_ID.exec(r.text)[0];
    const a = await c.call('pitroom_audit', { run: id, worker: 'opencode:mock/b', waitSeconds: 60 });
    assert.equal(a.isError, false, a.text);
    assert.match(a.text, /── audit of \d{8}-\d{6}-[0-9a-f]{4}: AGREE/);
    assert.match((await c.call('pitroom_show', { run: id })).text, /── audit \(run .*\): AGREE/);
  } finally {
    await c.close();
  }
  const s2 = sandbox();
  const c2 = connect(s2, { MOCK_ACTIONS: 'append:app.txt:more;answer:SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0' });
  try {
    await handshake(c2);
    const change = await c2.call('pitroom_run', { task: 'extend', mode: 'isolate' });
    const id = RUN_ID.exec(change.text)[0];
    const rev = await c2.call('pitroom_review', { run: id, waitSeconds: 60 });
    assert.equal(rev.isError, false, rev.text);
    assert.match(rev.text, /review of /);
    assert.match(rev.text, /SPEC PASS/);
  } finally {
    await c2.close();
  }
});
