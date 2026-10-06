// `pitroom mcp`: Pitroom as an MCP server on stdio. The tools run the CLI, so these tests speak the protocol
// to a real server process and check the results against what the CLI does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import readline from 'node:readline';
import { CLI, root, sandbox } from './helpers.mjs';

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
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: false } });
    assert.equal((await c.rpc('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05', 'an older version it knows');
    assert.equal((await c.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'an unknown one gets the latest');

    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual((await c.rpc('ping', {})).result, {});

    const { tools } = (await c.rpc('tools/list', {})).result;
    assert.deepEqual(tools.map((t) => t.name), ['pitroom_run', 'pitroom_wait', 'pitroom_show', 'pitroom_info', 'pitroom_review', 'pitroom_audit', 'pitroom_apply', 'pitroom_discard', 'pitroom_revert', 'pitroom_stop']);
    assert.ok(JSON.stringify(tools).length < 8000, `the definitions stay small (they sit in the client's context): ${JSON.stringify(tools).length} characters`);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.ok(t.description.length > 20 && t.title, t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    }
    const run = tools.find((t) => t.name === 'pitroom_run');
    assert.equal(run.inputSchema.required, undefined, 'task or tasks');
    assert.equal(run.inputSchema.properties.tasks.type, 'array');
    assert.deepEqual(run.inputSchema.properties.mode.enum, ['read', 'isolate', 'write']);
    assert.equal(tools.find((t) => t.name === 'pitroom_apply').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'pitroom_info').annotations.readOnlyHint, true);

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
    assert.match((await c.call('pitroom_show', {})).text, /done/, 'the latest run by default');
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
      [{}, /give "task" \(or "tasks"/],
      [{ task: 'x', tasks: ['y'] }, /not both/],
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

test('mcp: a run that is still going starts the dashboard and says where it is, for the agent\'s own browser pane; short runs and mcpDash off do not', async () => {
  const s = sandbox();
  const registry = path.join(s.base, 'home', 'dash.json');
  // a short run: finished within the wait, so no dashboard and no line
  const quick = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: quick', PITROOM_MCP_DASH: '1' });
  try {
    await handshake(quick);
    const done = await quick.call('pitroom_run', { task: 'quick one', waitSeconds: 30 });
    assert.match(done.text, /pitroom ✔ done/);
    assert.doesNotMatch(done.text, /Live view/);
    await new Promise((r) => setTimeout(r, 3500)); // past the delay after which a still-going run would start it
    assert.ok(!fs.existsSync(registry), 'a run that finished started no dashboard');
  } finally {
    await quick.close();
  }
  // a long run: the answer carries the address, the dashboard answers, and pitroom_wait repeats the line
  const c = connect(s, { MOCK_ACTIONS: 'sleep:30;answer:late', PITROOM_MCP_DASH: '1' });
  let id;
  try {
    const init = await handshake(c);
    assert.match(init.result.instructions, /built-in browser pane/, 'the server tells the agent what to do with the address');
    const first = await c.call('pitroom_run', { task: 'long one', waitSeconds: 5 });
    const url = /Live view of every run: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(first.text)?.[1];
    assert.ok(url, first.text);
    assert.match(first.text, /built-in browser pane \(the Claude Code and Codex apps do\)/);
    id = RUN_ID.exec(first.text)[0];
    const state = await (await fetch(`${url}api/state`)).json();
    assert.ok(state.runs.some((r) => r.id === id), 'the dashboard lists the run');
    const again = await c.call('pitroom_wait', { runs: [id], waitSeconds: 1 });
    assert.match(again.text, new RegExp(`Live view of every run: ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the same address, from the dashboard that is already up');
    await c.call('pitroom_stop', { run: id });
  } finally {
    await c.close();
    s.run(['dash', '--stop']);
  }
  assert.ok(!fs.existsSync(registry), 'the dashboard is stopped');
  // mcpDash off (the default of these tests, and PITROOM_MCP_DASH=0): neither the line nor a dashboard
  const off = connect(s, { MOCK_ACTIONS: 'sleep:30;answer:late', PITROOM_MCP_DASH: '0' });
  try {
    await handshake(off);
    const r = await off.call('pitroom_run', { task: 'long two', waitSeconds: 5 });
    assert.match(r.text, /Not finished yet/);
    assert.doesNotMatch(r.text, /Live view/);
    assert.ok(!fs.existsSync(registry), 'no dashboard');
    await off.call('pitroom_stop', { run: RUN_ID.exec(r.text)[0] });
  } finally {
    await off.close();
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
  const c2 = connect(s2, { MOCK_ACTIONS: 'answer:SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0' });
  try {
    await handshake(c2);
    // the change's own actions ride in its task, so the reviewer only answers
    const change = await c2.call('pitroom_run', { task: 'extend [[mock:append:app.txt:more;answer:SUMMARY: extended]]', mode: 'isolate' });
    const id = RUN_ID.exec(change.text)[0];
    const rev = await c2.call('pitroom_review', { run: id, waitSeconds: 60 });
    assert.equal(rev.isError, false, rev.text);
    assert.match(rev.text, /review of /);
    assert.match(rev.text, /SPEC PASS/);
  } finally {
    await c2.close();
  }
});

const progressOf = (c, token) => c.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'notifications/progress' && m.params.progressToken === token);

test('mcp: a client that asks for progress gets it while a run is waited for, increasing, and one that does not gets none', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:4;answer:SUMMARY: slow but done' });
  try {
    await handshake(c);
    const m = await c.rpc('tools/call', { name: 'pitroom_run', arguments: { task: 'slow one', waitSeconds: 60 }, _meta: { progressToken: 'tok-1' } });
    assert.match(m.result.content[0].text, /pitroom ✔ done/);
    const seen = progressOf(c, 'tok-1');
    assert.ok(seen.length >= 1, 'at least one progress notification');
    assert.deepEqual(seen.map((n) => n.params.progress), seen.map((_, i) => i + 1), 'progress only goes up');
    assert.match(seen[0].params.message, /running|queued/);
    assert.match(seen[0].params.message, /run \d{8}-\d{6}-[0-9a-f]{4}/);
    const before = c.lines.length;
    await c.call('pitroom_run', { task: 'second', waitSeconds: 60 });
    assert.ok(!c.lines.slice(before).some((l) => JSON.parse(l).method === 'notifications/progress'), 'no token, no progress');
  } finally {
    await c.close();
  }
});

test('mcp: cancelling a request stops the run it started and sends no answer', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:30;answer:late' });
  try {
    await handshake(c);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 777, method: 'tools/call', params: { name: 'pitroom_run', arguments: { task: 'long one', waitSeconds: 120 } } }));
    let id;
    for (let i = 0; i < 50 && !id; i++) {
      await new Promise((r) => setTimeout(r, 200));
      id = RUN_ID.exec(s.run(['ls']).stdout)?.[0];
    }
    assert.ok(id, 'the run started');
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 777, reason: 'user' } }));
    let state = '';
    for (let i = 0; i < 100 && !/stopped/.test(state); i++) {
      await new Promise((r) => setTimeout(r, 300));
      state = s.run(['status', id]).stdout;
    }
    assert.match(state, /stopped/, 'the cancelled request\'s run was stopped');
    assert.ok(!c.lines.some((l) => JSON.parse(l).id === 777), 'a cancelled request is not answered');
    assert.deepEqual((await c.rpc('ping', {})).result, {}, 'the server goes on');
  } finally {
    await c.close();
  }
});

test('mcp: runs are resources (report and patch), with templates, and a bad uri is the protocol\'s "not found"', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'append:app.txt:from the worker;answer:SUMMARY: extended app.txt' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { task: 'extend app.txt', mode: 'isolate' });
    const id = RUN_ID.exec(r.text)[0];
    const { resources } = (await c.rpc('resources/list', {})).result;
    const uris = resources.map((x) => x.uri);
    assert.ok(uris.includes(`pitroom://run/${id}`) && uris.includes(`pitroom://run/${id}/patch`), uris.join(' '));
    const report = (await c.rpc('resources/read', { uri: `pitroom://run/${id}` })).result.contents[0];
    assert.match(report.text, /SUMMARY: extended app\.txt/);
    assert.equal(report.mimeType, 'text/plain');
    const patch = (await c.rpc('resources/read', { uri: `pitroom://run/${id}/patch` })).result.contents[0];
    assert.match(patch.text, /\+from the worker/);
    assert.equal(patch.mimeType, 'text/x-diff');
    const { resourceTemplates } = (await c.rpc('resources/templates/list', {})).result;
    assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ['pitroom://run/{id}', 'pitroom://run/{id}/patch']);
    assert.equal((await c.rpc('resources/read', { uri: 'file:///etc/passwd' })).error.code, -32002, 'only runs are resources');
    assert.equal((await c.rpc('resources/read', { uri: 'pitroom://run/19990101-000000-0000' })).error.code, -32002);
    assert.equal((await c.rpc('resources/read', {})).error.code, -32602);
  } finally {
    await c.close();
  }
});

test('mcp: prompts say how to use Pitroom, with their arguments checked', async () => {
  const s = sandbox();
  const c = connect(s);
  try {
    await handshake(c);
    const { prompts } = (await c.rpc('prompts/list', {})).result;
    assert.deepEqual(prompts.slice(0, 4).map((p) => p.name), ['research', 'implement', 'review', 'crew']);
    const skillNames = fs.readdirSync(path.join(root, 'skills')).filter((d) => fs.existsSync(path.join(root, 'skills', d, 'SKILL.md'))).sort();
    assert.deepEqual(prompts.slice(4).map((p) => p.name), skillNames, 'every skill is a prompt too');
    const using = prompts.find((p) => p.name === 'using-pitroom');
    assert.match(using.description, /^Skill: /);
    const skill = (await c.rpc('prompts/get', { name: 'pitroom-research', arguments: { task: 'where is login handled?' } })).result.messages[0].content.text;
    assert.match(skill, /^Through this MCP server the `pitroom` commands below are tools: `pitroom run` is pitroom_run/);
    assert.match(skill, /# Research with a Pitroom worker/);
    assert.match(skill, /The task: where is login handled\?$/);
    assert.doesNotMatch(skill, /^---\nname:/m, 'without the front matter');
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.match(init.result.instructions, /skills \(using-pitroom, pitroom-research/);
    const research = (await c.rpc('prompts/get', { name: 'research', arguments: { question: 'where is login handled?' } })).result;
    assert.equal(research.messages[0].role, 'user');
    assert.match(research.messages[0].content.text, /pitroom_run[\s\S]*where is login handled\?/);
    assert.match((await c.rpc('prompts/get', { name: 'review', arguments: { range: 'main..HEAD' } })).result.messages[0].content.text, /range "main\.\.HEAD"/);
    assert.match((await c.rpc('prompts/get', { name: 'review' })).result.messages[0].content.text, /run "last"/, 'an optional argument');
    assert.equal((await c.rpc('prompts/get', { name: 'research' })).error.code, -32602, 'a required argument is missing');
    assert.equal((await c.rpc('prompts/get', { name: 'nope' })).error.code, -32602);
  } finally {
    await c.close();
  }
});

test('mcp: pitroom_run with tasks runs them in parallel as one group and returns every report', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: done here' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { tasks: ['first job', 'second job'], group: 'pair', waitSeconds: 90 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text.match(/pitroom ✔ done/g).length, 2, r.text);
    assert.equal(s.run(['ls', '-g', 'pair']).stdout.match(/\d{8}-\d{6}-[0-9a-f]{4}/g).length, 2, 'both runs are in the group');
    assert.equal((await c.call('pitroom_run', { tasks: [] })).isError, true);
    assert.match((await c.call('pitroom_run', { tasks: ['x'], continue: 'last' })).text, /follows up one run/);
    assert.equal((await c.call('pitroom_run', { tasks: ['x'], mode: 'write' })).isError, true, 'parallel workers never write in place');
  } finally {
    await c.close();
  }
});

test('mcp: pitroom_info shows what the CLI shows, a follow-up continues a run, and a written change is reverted', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: app.txt holds line1' });
  try {
    await handshake(c);
    const id = RUN_ID.exec((await c.call('pitroom_run', { task: 'where is app.txt?' })).text)[0];
    const info = (args) => c.call('pitroom_info', args);
    assert.match((await info({ topic: 'runs' })).text, new RegExp(id));
    assert.equal((await info({ topic: 'runs', running: true })).text, 'nothing is running');
    assert.match((await info({ topic: 'history', text: 'app.txt' })).text, new RegExp(id));
    assert.match((await info({ topic: 'stats' })).text, /1 runs/);
    assert.equal((await info({ topic: 'stats', since: 'last week' })).isError, true);
    assert.match((await info({ topic: 'history', limit: 0 })).text, /"limit" must be/);
    assert.equal((await info({ topic: 'savings' })).isError, false);
    assert.equal((await info({ topic: 'savings', since: '30d', perModel: true })).isError, false);
    assert.equal((await info({ topic: 'models' })).isError, false);
    assert.equal((await info({ topic: 'models', worker: 'opencode', all: true })).isError, false);
    assert.match((await info({ topic: 'history', state: 'done', since: '7d' })).text, new RegExp(id));
    assert.match((await info({ topic: 'history', state: 'failed' })).text, /no matching runs/);
    assert.match((await info({ topic: 'runs', group: 'nope' })).text, /no runs in group "nope"/);
    assert.match((await info({ topic: '' })).text, /"topic" is required/);
    assert.match((await info({ topic: 'doctor', since: '7d', all: true })).text, /"since", "all" do not go with topic "doctor" \(it takes no options\)/);
    assert.match((await info({ topic: 'cooldown' })).text, /no model is cooling down/);
    assert.match((await info({ topic: 'config' })).text, /worker/);
    assert.ok((await info({ topic: 'doctor' })).text.length > 0);
    assert.match((await info({})).text, /"topic" is required/);
    assert.match((await info({ topic: 'weather' })).text, /"topic" must be one of/);
    assert.match((await info({ topic: 'stats', text: 'x' })).text, /"text" does not go with topic "stats" \(it takes since\)/);
    assert.match((await c.call('pitroom_stop', { cooldowns: true })).text, /no cooldowns/);
    assert.equal((await c.call('pitroom_stop', { cooldowns: true, run: 'last' })).isError, true);

    const follow = await c.call('pitroom_run', { task: 'and the second line?', continue: id });
    assert.equal(follow.isError, false, follow.text);
    assert.match(s.calls().filter((x) => x.argv[0] === 'run').at(-1).argv.join(' '), /--session|resume|-s/, 'the worker session was resumed');
  } finally {
    await c.close();
  }
  const s2 = sandbox();
  const c2 = connect(s2, { MOCK_ACTIONS: 'append:app.txt:written in place;answer:SUMMARY: wrote' });
  try {
    await handshake(c2);
    const w = await c2.call('pitroom_run', { task: 'write it', mode: 'write' });
    assert.equal(w.isError, false, w.text);
    const id = RUN_ID.exec(w.text)[0];
    assert.match(fs.readFileSync(path.join(s2.repo, 'app.txt'), 'utf8'), /written in place/);
    const back = await c2.call('pitroom_revert', { run: id });
    assert.equal(back.isError, false, back.text);
    assert.match(back.text, /reverted 1 file/);
    assert.doesNotMatch(fs.readFileSync(path.join(s2.repo, 'app.txt'), 'utf8'), /written in place/);
    assert.equal((await c2.call('pitroom_revert', { run: id })).isError, true, 'twice is refused');
  } finally {
    await c2.close();
  }
});

test('mcp: cancelling a pitroom_wait only stops the waiting, the run goes on', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:20;answer:late' });
  try {
    await handshake(c);
    const first = await c.call('pitroom_run', { task: 'long one', waitSeconds: 1 });
    const id = RUN_ID.exec(first.text)[0];
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 888, method: 'tools/call', params: { name: 'pitroom_wait', arguments: { runs: [id], waitSeconds: 120 } } }));
    await new Promise((r) => setTimeout(r, 1500));
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 888 } }));
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual((await c.rpc('ping', {})).result, {});
    assert.ok(!c.lines.some((l) => JSON.parse(l).id === 888), 'no answer to the cancelled wait');
    assert.match(s.run(['status', id]).stdout, /running/, 'the run was not stopped');
    await c.call('pitroom_stop', { run: id });
  } finally {
    await c.close();
  }
});

test('mcp: pitroom_apply with a group applies the patches in order and stops at the first that no longer fits', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'append:app.txt:from a worker;answer:SUMMARY: extended' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { tasks: ['one', 'two'], mode: 'isolate', group: 'edits', waitSeconds: 90 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text.match(/pitroom ✔ done · isolate/g).length, 2, r.text);
    const applied = await c.call('pitroom_apply', { group: 'edits' });
    assert.match(applied.text, /applied 1 file/, 'the first patch landed');
    assert.match(applied.text, /✘/, 'the second no longer fits the changed file');
    assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /from a worker/);
    assert.equal((await c.call('pitroom_apply', { group: 'edits', run: 'last' })).isError, true, 'run and group together are refused');
    assert.equal((await c.call('pitroom_stop', { group: 'edits', run: 'last' })).isError, true);
  } finally {
    await c.close();
  }
});

const until = async (f, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (f()) return true;
  return false;
};

test('mcp: a new run is announced, a subscribed run tells when it ends, and unsubscribing stops that', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:4;answer:SUMMARY: done' });
  const notes = (method) => c.lines.map((l) => JSON.parse(l)).filter((m) => m.method === method);
  try {
    await handshake(c);
    const first = await c.call('pitroom_run', { task: 'slow', waitSeconds: 1 });
    const id = RUN_ID.exec(first.text)[0];
    assert.ok(await until(() => notes('notifications/resources/list_changed').length >= 1), 'the new run was announced');
    const uri = `pitroom://run/${id}`;
    assert.deepEqual((await c.rpc('resources/subscribe', { uri })).result, {});
    assert.ok(await until(() => notes('notifications/resources/updated').some((n) => n.params.uri === uri)), 'told when it changed');
    assert.ok(await until(() => /done/.test(s.run(['status', id]).stdout), 10_000));

    // a second run, subscribed and then unsubscribed: nothing more about it
    const second = RUN_ID.exec((await c.call('pitroom_run', { task: 'slow two', waitSeconds: 1 })).text)[0];
    const uri2 = `pitroom://run/${second}/patch`;
    await c.rpc('resources/subscribe', { uri: uri2 });
    await c.rpc('resources/unsubscribe', { uri: uri2 });
    await until(() => /done/.test(s.run(['status', second]).stdout), 20_000);
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!notes('notifications/resources/updated').some((n) => n.params.uri === uri2), 'not after unsubscribing');

    assert.equal((await c.rpc('resources/subscribe', { uri: 'file:///etc/passwd' })).error.code, -32602);
    assert.equal((await c.rpc('resources/subscribe', { uri: 'pitroom://run/19990101-000000-0000' })).error.code, -32002);
    assert.equal((await c.rpc('resources/subscribe', {})).error.code, -32602);
  } finally {
    await c.close();
  }
});

test('mcp: a run whose --verify failed is an error result, not a plain success', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  try {
    await handshake(c);
    const r = await c.call('pitroom_run', { task: 'check', verify: 'false' });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /pitroom ⚠ done · verify failed/);
    assert.equal((await c.call('pitroom_run', { task: 'check again', verify: 'true' })).isError, false);
  } finally {
    await c.close();
  }
});
