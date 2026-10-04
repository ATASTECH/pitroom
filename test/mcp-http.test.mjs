// `pitroom mcp --http`: the MCP server over HTTP. A real server process on a free port, spoken to with fetch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { CLI, sandbox } from './helpers.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;

async function serve(s, extra = {}, args = ['--port', '0'], cwd = s.repo) {
  const proc = spawn(process.execPath, [CLI, 'mcp', '--http', ...args], { cwd, env: { ...s.env, PWD: cwd, PITROOM_MCP_TOKEN: TOKEN, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const lines = [];
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start (stderr: ${stderr})`)), 30_000);
    readline.createInterface({ input: proc.stdout }).on('line', (l) => {
      lines.push(l);
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(l);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', (code) => reject(new Error(`the server exited with ${code} (stderr: ${stderr})`)));
  });
  await new Promise((r) => setTimeout(r, 300)); // the lines after the first
  const base = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { ...base, ...headers }, body: JSON.stringify(body) });
  let n = 0;
  const open = async () => {
    const r = await post({ jsonrpc: '2.0', id: ++n, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    return { r, sid: r.headers.get('mcp-session-id'), body: await r.json() };
  };
  const rpc = async (sid, method, params) => (await post({ jsonrpc: '2.0', id: ++n, method, params }, { 'Mcp-Session-Id': sid })).json();
  const close = () => new Promise((resolve) => { proc.once('close', resolve); proc.kill('SIGTERM'); });
  return { url, lines, base, post, open, rpc, close, nextId: () => ++n, stderr: () => stderr };
}

test('mcp http: it says where it listens, with the command for Claude Code, and only 127.0.0.1', async () => {
  const s = sandbox();
  const h = await serve(s);
  try {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(h.lines.some((l) => /claude mcp add --transport http pitroom .*Bearer \$PITROOM_MCP_TOKEN/.test(l)), h.lines.join('\n'));
    assert.ok(!h.lines.join('\n').includes(TOKEN), 'the token itself is not printed');
    assert.ok(h.lines.some((l) => l.includes(`working in ${fs.realpathSync(s.repo)}`)), 'it says which project it works in');
    const busy = s.run(['mcp', '--http', '--port', new URL(h.url).port]);
    assert.equal(busy.status, 3);
    assert.match(busy.stderr, /port \d+ is in use/);
  } finally {
    await h.close();
  }
});

test('mcp http: a bearer token is needed, and only local hosts and origins are served', async () => {
  const s = sandbox();
  const h = await serve(s);
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    const without = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init) });
    assert.equal(without.status, 401);
    assert.equal(without.headers.get('www-authenticate'), 'Bearer');
    const wrong = await fetch(h.url, { method: 'POST', headers: { ...h.base, Authorization: 'Bearer nope' }, body: JSON.stringify(init) });
    assert.equal(wrong.status, 401);
    const origin = await fetch(h.url, { method: 'POST', headers: { ...h.base, Origin: 'https://evil.example' }, body: JSON.stringify(init) });
    assert.equal(origin.status, 403, 'a web page elsewhere cannot use it');
    const local = await fetch(h.url, { method: 'POST', headers: { ...h.base, Origin: 'http://localhost:3000' }, body: JSON.stringify(init) });
    assert.equal(local.status, 200, 'a local page can (with the token)');
    // a Host that is not local (DNS rebinding) cannot be sent through fetch; raw HTTP can
    const { status } = await new Promise((resolve, reject) => {
      const net = import('node:net').then(({ default: n }) => {
        const sock = n.connect(Number(new URL(h.url).port), '127.0.0.1', () => sock.write(`POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
        let text = '';
        sock.on('data', (d) => (text += d));
        sock.on('close', () => resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(text)?.[1]) }));
        sock.on('error', reject);
      });
      net.catch(reject);
    });
    assert.equal(status, 403, 'a foreign Host header is refused');
    assert.equal((await fetch(h.url.replace('/mcp', '/other'), { headers: h.base })).status, 404);
    assert.equal((await fetch(h.url, { method: 'GET', headers: h.base })).status, 400, 'a GET stream needs a session');
    assert.equal((await fetch(h.url, { method: 'GET', headers: { ...h.base, Accept: 'application/json' } })).status, 406, 'and asks for an event stream');
    assert.equal((await fetch(h.url, { method: 'PUT', headers: h.base })).status, 405);
    const big = await fetch(h.url, { method: 'POST', headers: h.base, body: 'x'.repeat(4_100_000) });
    assert.equal(big.status, 413, 'the answer reaches the client');
    assert.match((await big.json()).error.message, /at most 4000000 bytes/);
    const lower = await fetch(h.url, { method: 'POST', headers: { ...h.base, Authorization: `bearer ${TOKEN}` }, body: JSON.stringify(init) });
    assert.equal(lower.status, 200, 'the scheme is case-insensitive');
    await lower.text();
    assert.equal((await fetch(h.url, { method: 'POST', headers: h.base, body: 'not json' })).status, 400);
  } finally {
    await h.close();
  }
});

test('mcp http: initialize opens a session; every other request needs it; delete ends it', async () => {
  const s = sandbox();
  const h = await serve(s);
  try {
    const { r, sid, body } = await h.open();
    assert.equal(r.status, 200);
    assert.ok(sid && sid.length >= 16, 'a session id is issued');
    assert.equal(body.result.serverInfo.name, 'pitroom');
    assert.deepEqual(Object.keys(body.result.capabilities).sort(), ['prompts', 'resources', 'tools']);

    assert.equal((await h.post({ jsonrpc: '2.0', id: 50, method: 'tools/list' })).status, 400, 'no session id');
    assert.equal((await h.post({ jsonrpc: '2.0', id: 51, method: 'tools/list' }, { 'Mcp-Session-Id': 'nope' })).status, 404, 'an unknown one');
    const listed = await h.rpc(sid, 'tools/list', {});
    assert.equal(listed.result.tools.length, 10);
    assert.equal((await h.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': sid })).status, 202, 'a notification is accepted, with no body');
    const batch = await (await h.post([{ jsonrpc: '2.0', id: 60, method: 'ping' }, { jsonrpc: '2.0', id: 61, method: 'ping' }], { 'Mcp-Session-Id': sid })).json();
    assert.deepEqual(batch.map((m) => m.id), [60, 61]);
    assert.equal((await h.rpc(sid, 'prompts/list', {})).result.prompts.length, 4);

    assert.equal((await fetch(h.url, { method: 'DELETE', headers: { ...h.base, 'Mcp-Session-Id': sid } })).status, 204);
    assert.equal((await h.post({ jsonrpc: '2.0', id: 70, method: 'ping' }, { 'Mcp-Session-Id': sid })).status, 404, 'the session is gone');
  } finally {
    await h.close();
  }
});

test('mcp http: a tool call runs the CLI and answers; a call that asks for progress is answered as an event stream', async () => {
  const s = sandbox();
  const h = await serve(s, { MOCK_ACTIONS: 'sleep:4;answer:SUMMARY: app.txt holds line1 (app.txt:1)' });
  try {
    const { sid } = await h.open();
    const plain = await h.rpc(sid, 'tools/call', { name: 'pitroom_run', arguments: { task: 'where is app.txt?' } });
    assert.equal(plain.result.isError, false, JSON.stringify(plain));
    assert.match(plain.result.content[0].text, /refs: 1\/1 verified/);

    const res = await h.post({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/call', params: { name: 'pitroom_run', arguments: { task: 'again', waitSeconds: 60 }, _meta: { progressToken: 'p1' } } }, { 'Mcp-Session-Id': sid });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter(Boolean).map((e) => JSON.parse(/^data: (.*)$/m.exec(e)[1]));
    const progress = events.filter((m) => m.method === 'notifications/progress');
    assert.ok(progress.length >= 1 && progress.every((m) => m.params.progressToken === 'p1'), JSON.stringify(events));
    assert.deepEqual(progress.map((m) => m.params.progress), progress.map((_, i) => i + 1));
    assert.match(events.at(-1).result.content[0].text, /pitroom ✔ done/, 'the result is the last event');
  } finally {
    await h.close();
  }
});

test('mcp http: a cancel from the same session stops the run; another session\'s same request id is not touched', async () => {
  const s = sandbox();
  const h = await serve(s, { MOCK_ACTIONS: 'sleep:30;answer:late' });
  try {
    const a = await h.open();
    const b = await h.open();
    const call = (sid, id) => h.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pitroom_run', arguments: { task: `task of ${sid.slice(0, 4)}`, waitSeconds: 120 } } }, { 'Mcp-Session-Id': sid });
    const pendingA = call(a.sid, 4242);
    const pendingB = call(b.sid, 4242); // the same request id, from another client
    let ids = [];
    for (let i = 0; i < 60 && ids.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ids = [...new Set(s.run(['ls']).stdout.match(new RegExp(RUN_ID, 'g')) ?? [])];
    }
    assert.equal(ids.length, 2, 'both runs started');
    await h.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4242 } }, { 'Mcp-Session-Id': a.sid });
    const answerA = await pendingA;
    assert.equal(answerA.status, 202, 'the cancelled request is not answered');
    const states = ids.map((id) => s.run(['status', id]).stdout);
    for (let i = 0; i < 100 && !states.some((t) => /stopped/.test(t)); i++) {
      await new Promise((r) => setTimeout(r, 300));
      states.splice(0, 2, ...ids.map((id) => s.run(['status', id]).stdout));
    }
    assert.equal(states.filter((t) => /stopped/.test(t)).length, 1, 'only the cancelling session\'s run was stopped');
    assert.equal(states.filter((t) => /running/.test(t)).length, 1, 'the other one runs on');
    const running = ids.find((id) => /running/.test(s.run(['status', id]).stdout));
    await h.rpc(b.sid, 'tools/call', { name: 'pitroom_stop', arguments: { run: running } });
    assert.equal((await pendingB).status, 200);
  } finally {
    await h.close();
  }
});

test('mcp http: without PITROOM_MCP_TOKEN a token is made once, kept private, and reused', async () => {
  const s = sandbox();
  const first = await serve(s, { PITROOM_MCP_TOKEN: '' });
  let token;
  try {
    const file = path.join(s.base, 'home', 'mcp-token');
    token = fs.readFileSync(file, 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'only the owner can read it');
    assert.ok(first.lines.some((l) => l.includes(`$(cat "${file}")`)), first.lines.join('\n'));
    const r = await fetch(first.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    assert.equal(r.status, 200);
  } finally {
    await first.close();
  }
  const second = await serve(s, { PITROOM_MCP_TOKEN: '' });
  try {
    assert.equal(fs.readFileSync(path.join(s.base, 'home', 'mcp-token'), 'utf8').trim(), token, 'the same token after a restart');
  } finally {
    await second.close();
  }
});

test('mcp http: bad options are usage errors, and a short token is refused in one line', async () => {
  const s = sandbox();
  assert.equal(s.run(['mcp', '--http', '--port', 'abc']).status, 2);
  assert.equal(s.run(['mcp', '--http', '--port', '70000']).status, 2);
  const stdioPort = s.run(['mcp', '--port', '7000']);
  assert.equal(stdioPort.status, 2);
  assert.match(stdioPort.stderr, /--port goes with --http/);
  const noDir = s.run(['mcp', '-d', path.join(s.base, 'nope')]);
  assert.equal(noDir.status, 2);
  assert.match(noDir.stderr, /no such directory/);
  const short = s.run(['mcp', '--http', '--port', '0'], { PITROOM_MCP_TOKEN: 'short' });
  assert.equal(short.status, 3);
  assert.match(short.stderr, /PITROOM_MCP_TOKEN is too short/);
  assert.doesNotMatch(short.stderr, /\n\s+at /, 'one line, no stack trace');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('mcp http: -d starts it in another project, and the runs work there', async () => {
  const s = sandbox();
  const h = await serve(s, { MOCK_ACTIONS: 'answer:SUMMARY: ok' }, ['--port', '0', '-d', s.repo], s.base);
  try {
    assert.ok(h.lines.some((l) => l.includes(`working in ${fs.realpathSync(s.repo)}`)), h.lines.join('\n'));
    const { sid } = await h.open();
    const r = await h.rpc(sid, 'tools/call', { name: 'pitroom_run', arguments: { task: 'where is app.txt?' } });
    assert.equal(r.result.isError, false, JSON.stringify(r));
    const ran = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
    assert.equal(fs.realpathSync(ran.cwd), fs.realpathSync(s.repo), 'the worker ran in the -d project');
  } finally {
    await h.close();
  }
});

test('mcp http: a client starting over with its old id replaces its session, and the session unused longest makes room at 64', async () => {
  const s = sandbox();
  const h = await serve(s);
  const status = async (sid) => {
    const r = await h.post({ jsonrpc: '2.0', id: h.nextId(), method: 'ping' }, { 'Mcp-Session-Id': sid });
    await r.text();
    return r.status;
  };
  try {
    const first = await h.open();
    const again = await h.post({ jsonrpc: '2.0', id: h.nextId(), method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { 'Mcp-Session-Id': first.sid });
    await again.text();
    const replaced = again.headers.get('mcp-session-id');
    assert.ok(replaced && replaced !== first.sid, 'a new session');
    assert.equal(await status(first.sid), 404, 'the old one is gone');
    const sids = [replaced];
    for (let i = 0; i < 63; i++) sids.push((await h.open()).sid);
    const extra = await h.open();
    assert.equal(extra.r.status, 200, 'a 65th client still gets in');
    assert.equal(await status(sids[0]), 404, 'the session unused longest made room');
    assert.equal(await status(sids[63]), 200, 'the others are kept');
  } finally {
    await h.close();
  }
});

test('mcp http: stopping the server ends the waiting, not the runs', async () => {
  const s = sandbox();
  const h = await serve(s, { MOCK_ACTIONS: 'sleep:30;answer:late' });
  const { sid } = await h.open();
  const pending = h
    .post({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/call', params: { name: 'pitroom_run', arguments: { task: 'long one', waitSeconds: 120 } } }, { 'Mcp-Session-Id': sid })
    .then((r) => r.text())
    .catch(() => undefined);
  let id;
  for (let i = 0; i < 60 && !id; i++) {
    await sleep(250);
    id = RUN_ID.exec(s.run(['ls']).stdout)?.[0];
  }
  assert.ok(id, 'the run started');
  const t = Date.now();
  await h.close();
  assert.ok(Date.now() - t < 10_000, 'the server stopped promptly');
  await pending;
  assert.match(s.run(['status', id]).stdout, /running/, 'the run goes on');
  s.run(['stop', id]);
});

test('mcp http: a GET opens the session\'s event stream, where a subscribed run tells when it ends', async () => {
  const s = sandbox();
  const h = await serve(s, { MOCK_ACTIONS: 'sleep:4;answer:SUMMARY: done' });
  try {
    const { sid } = await h.open();
    const ctl = new AbortController();
    const stream = await fetch(h.url, { method: 'GET', headers: { ...h.base, Accept: 'text/event-stream', 'Mcp-Session-Id': sid }, signal: ctl.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    let text = '';
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
      } catch {
        // aborted at the end
      }
    })();
    const events = () => text.split('\n\n').map((e) => /^data: (.*)$/m.exec(e)?.[1]).filter(Boolean).map((d) => JSON.parse(d));
    const r = await h.rpc(sid, 'tools/call', { name: 'pitroom_run', arguments: { task: 'slow', waitSeconds: 1 } });
    const id = RUN_ID.exec(r.result.content[0].text)[0];
    const uri = `pitroom://run/${id}`;
    assert.deepEqual((await h.rpc(sid, 'resources/subscribe', { uri })).result, {});
    const until = async (f) => {
      for (let i = 0; i < 150 && !f(); i++) await sleep(200);
      return f();
    };
    assert.ok(await until(() => events().some((m) => m.method === 'notifications/resources/list_changed')), text);
    assert.ok(await until(() => events().some((m) => m.method === 'notifications/resources/updated' && m.params.uri === uri)), text);
    ctl.abort();
  } finally {
    await h.close();
  }
});

test('mcp http: a second GET replaces the first stream, and DELETE closes the open one', async () => {
  const s = sandbox();
  const h = await serve(s);
  try {
    const { sid } = await h.open();
    const get = () => fetch(h.url, { method: 'GET', headers: { ...h.base, Accept: '*/*', 'Mcp-Session-Id': sid } });
    const ended = async (res) => {
      const reader = res.body.getReader();
      try {
        for (;;) if ((await reader.read()).done) return true;
      } catch {
        return true;
      }
    };
    const first = await get();
    assert.equal(first.status, 200, 'Accept */* is fine');
    const firstEnded = ended(first);
    const second = await get();
    assert.equal(second.status, 200);
    assert.equal(await Promise.race([firstEnded, sleep(5000).then(() => false)]), true, 'the first stream ended');
    const secondEnded = ended(second);
    assert.equal((await fetch(h.url, { method: 'DELETE', headers: { ...h.base, 'Mcp-Session-Id': sid } })).status, 204);
    assert.equal(await Promise.race([secondEnded, sleep(5000).then(() => false)]), true, 'DELETE closed the open stream');
  } finally {
    await h.close();
  }
});
