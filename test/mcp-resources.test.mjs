// Resources/subscribe edge cases, patch notifications, list_changed coalescing,
// and prompts/get validation: what test/mcp.test.mjs does not cover.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import readline from 'node:readline';
import { CLI, sandbox } from './helpers.mjs';

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
    if (Array.isArray(m)) return;
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
  return { proc, raw, rpc, call, close, lines };
}
const handshake = (c) => c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const until = async (f, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (f()) return true;
  return false;
};

test('mcp-resources: subscribe/unsubscribe edge cases and a bad resource uri', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  try {
    await handshake(c);
    const id = RUN_ID.exec((await c.call('pitroom_run', { task: 'hello' })).text)[0];
    const uri = `pitroom://run/${id}`;
    assert.deepEqual((await c.rpc('resources/subscribe', { uri })).result, {});
    assert.deepEqual((await c.rpc('resources/subscribe', { uri })).result, {}, 're-subscribing is not an error');
    // 101 distinct subscriptions would need 101 real runs (the cap check in
    // mcp-watch.ts runs before the existence check, but filling 100 slots still
    // needs 100 successful subscribes): too slow, so the cap itself is skipped here.
    assert.equal((await c.rpc('resources/subscribe', { uri: 'pitroom://run/abc' })).error.code, -32602);
    assert.equal((await c.rpc('resources/subscribe', { uri: `pitroom://run/${id}/other` })).error.code, -32602);
    assert.equal((await c.rpc('resources/subscribe', { uri: 'pitroom://run/19990101-000000-0000' })).error.code, -32002);
    assert.deepEqual((await c.rpc('resources/unsubscribe', { uri })).result, {});
    assert.deepEqual((await c.rpc('resources/unsubscribe', { uri })).result, {}, 'unsubscribing what was never subscribed is not an error');
    assert.equal((await c.rpc('resources/unsubscribe', {})).error.code, -32602);
    assert.equal((await c.rpc('resources/unsubscribe', { uri: 42 })).error.code, -32602);
    assert.equal((await c.rpc('resources/read', { uri: `pitroom://run/${id}/other` })).error.code, -32002);
  } finally {
    await c.close();
  }
});

test('mcp-resources: the patch resource of an isolate run notifies when its state changes', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'sleep:4;append:app.txt:from the worker;answer:SUMMARY: extended' });
  const notes = (method) => c.lines.map((l) => JSON.parse(l)).filter((m) => m.method === method);
  try {
    await handshake(c);
    const first = await c.call('pitroom_run', { task: 'extend app.txt', mode: 'isolate', waitSeconds: 1 });
    assert.match(first.text, /Not finished yet/);
    const id = RUN_ID.exec(first.text)[0];
    const patch = `pitroom://run/${id}/patch`;
    assert.deepEqual((await c.rpc('resources/subscribe', { uri: patch })).result, {});
    assert.ok(await until(() => notes('notifications/resources/updated').some((n) => n.params.uri === patch), 30_000), 'told when the run finished');
    assert.ok(await until(() => /done/.test(s.run(['status', id]).stdout), 10_000));
  } finally {
    await c.close();
  }
});

test('mcp-resources: several runs starting in one window give one list_changed', async () => {
  const s = sandbox();
  const c = connect(s, { MOCK_ACTIONS: 'answer:SUMMARY: done here' });
  const notes = (method) => c.lines.map((l) => JSON.parse(l)).filter((m) => m.method === method);
  try {
    await handshake(c);
    assert.equal(notes('notifications/resources/list_changed').length, 0);
    const r = await c.call('pitroom_run', { tasks: ['one', 'two', 'three'], group: 'trio', waitSeconds: 90 });
    assert.equal(r.isError, false, r.text);
    assert.ok(await until(() => notes('notifications/resources/list_changed').length >= 1), 'the new runs were announced');
    await new Promise((r2) => setTimeout(r2, 2500)); // past one more 2 s tick: a second announcement would arrive here
    // The three runs are made within a few tens of ms, and the server looks every 2 s: normally one announcement. A look that falls
    // between the first and the last run makes two, never three; asserting "exactly one" would fail about one run in twenty.
    const announced = notes('notifications/resources/list_changed').length;
    assert.ok(announced >= 1 && announced <= 2, `three runs in one window are one or two notifications, not three (got ${announced})`);
  } finally {
    await c.close();
  }
});

test('mcp-resources: prompts/get checks arguments and skills work without a task', async () => {
  const s = sandbox();
  const c = connect(s);
  try {
    await handshake(c);
    assert.equal((await c.rpc('prompts/get', { name: 'implement' })).error.code, -32602);
    assert.equal((await c.rpc('prompts/get', { name: 'crew' })).error.code, -32602);
    const impl = (await c.rpc('prompts/get', { name: 'implement', arguments: { task: 'add a retry flag' } })).result;
    assert.equal(impl.messages[0].role, 'user');
    assert.match(impl.messages[0].content.text, /add a retry flag/);
    const crew = (await c.rpc('prompts/get', { name: 'crew', arguments: { tasks: 'job one\njob two' } })).result;
    assert.equal(crew.messages[0].role, 'user');
    assert.match(crew.messages[0].content.text, /job one\njob two/);
    const { prompts } = (await c.rpc('prompts/list', {})).result;
    const skillName = prompts.map((p) => p.name).find((n) => n.startsWith('pitroom-'));
    assert.ok(skillName, 'a pitroom- skill prompt is listed');
    const skill = (await c.rpc('prompts/get', { name: skillName })).result.messages[0].content.text;
    assert.ok(skill.length > 100, 'the skill body comes back with no arguments');
    assert.doesNotMatch(skill, /The task:/, 'no task line without arguments');
  } finally {
    await c.close();
  }
});
