// pitroom dash (a live page of the runs) and watch --brief (one card line per start and end).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

// fetch cannot set the Host header, and the host check is part of what is tested.
const get = (url, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('dash: a read-only page of the runs, on 127.0.0.1 only, reused and stopped on request', async () => {
  const s = sandbox();
  const first = s.run(['run', 'list the files']);
  assert.equal(first.status, 0, first.stderr);
  const id = RUN_ID.exec(first.stdout)[0];
  const start = s.run(['dash', '--detach', '--port', '0']);
  assert.equal(start.status, 0, start.stderr);
  const url = start.stdout.trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  try {
    // a second start finds the first one
    assert.equal(s.run(['dash', '--detach', '--port', '0']).stdout.trim(), url);

    const page = await get(url);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Pitroom<\/title>/);
    assert.match(page.body, /\/assets\/app\.js/, 'the React app is loaded as a file');
    const js = await get(`${url}assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.ok(js.body.length > 100_000, 'the bundle is served');
    assert.equal((await get(`${url}assets/app.css`)).status, 200);
    assert.equal((await get(`${url}assets/other.js`)).status, 404, 'only the two bundle files');
    assert.equal((await get(`${url}assets/..%2Fpitroom.mjs`)).status, 404, 'no path traversal');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);

    const state = JSON.parse((await get(`${url}api/state`)).body);
    assert.equal(state.running, 0);
    assert.equal(typeof state.price, 'string', 'the price the savings are estimated against');
    const run = state.runs.find((r) => r.id === id);
    assert.ok(run, 'the finished run is listed');
    assert.equal(run.state, 'done');
    assert.match(run.kind, /research/);
    assert.match(run.worker, /opencode/);
    assert.equal(JSON.parse((await get(`${url}api/state?group=nope`)).body).runs.length, 0, 'a group filter');

    const hist = JSON.parse((await get(`${url}api/history?q=list`)).body);
    assert.equal(hist.total, 1, 'the history is searchable through the API');
    assert.equal(hist.rows[0].id, id);
    assert.equal(JSON.parse((await get(`${url}api/history?q=zzzz`)).body).total, 0);
    const stats = JSON.parse((await get(`${url}api/stats`)).body);
    assert.equal(stats.totals.runs, 1);
    assert.equal(stats.byWorker[0].backend, 'opencode');

    const detail = JSON.parse((await get(`${url}api/run/${id}`)).body);
    assert.match(detail.report, /done/);
    assert.equal(detail.task, 'list the files', 'the task the agent gave the worker');
    assert.ok(Array.isArray(detail.steps), 'what the worker did, step by step');
    assert.deepEqual(detail.fileDiffs, [], 'research has no file diffs');
    assert.ok(detail.answer, 'the worker\'s answer');
    assert.equal(detail.info.worker, 'opencode');
    assert.equal(detail.card.id, id, 'the detail carries the card the #run-id link pins');
    assert.equal(detail.card.state, 'done');
    assert.match(detail.card.kind, /research/);
    assert.match(detail.card.worker, /opencode/);
    assert.equal(detail.card.task, 'list the files');

    assert.equal((await get(`${url}api/run/not-a-run`)).status, 404);
    assert.equal((await get(`${url}api/run/..%2F..%2Fetc`)).status, 404);
    assert.equal((await get(`${url}nothing`)).status, 404);
    assert.equal((await get(url, { method: 'POST' })).status, 405, 'it only reads');
    assert.equal((await get(url, { headers: { host: 'evil.example:80' } })).status, 403, 'a foreign Host is refused');
  } finally {
    const stop = s.run(['dash', '--stop']);
    assert.equal(stop.status, 0, stop.stderr);
  }
  let refused = false;
  for (let i = 0; i < 30 && !refused; i++) {
    await get(url).catch(() => (refused = true));
    if (!refused) await sleep(100);
  }
  assert.ok(refused, 'the server is gone after --stop');
  assert.equal(s.run(['dash', '--stop']).status, 2, 'stopping a dash that is not running is a usage error');
});

test('dash: a bad port is a usage error', () => {
  const s = sandbox();
  const r = s.run(['dash', '--port', 'abc']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--port takes a number/);
});

test('dash: per-file previews count the full patch and also survive archiving', async () => {
  const s = sandbox();
  const additions = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n');
  const run = s.run(['run', '-i', 'change two files'], { MOCK_ACTIONS: `append:app.txt:${additions};write:z-last.ts:export const last = true;answer:SUMMARY: done` });
  assert.equal(run.status, 0, run.stderr);
  const id = RUN_ID.exec(run.stdout)[0];
  const start = s.run(['dash', '--detach', '--port', '0']);
  assert.equal(start.status, 0, start.stderr);
  const url = start.stdout.trim();
  try {
    const detail = JSON.parse((await get(`${url}api/run/${id}`)).body);
    assert.equal(detail.fileDiffs.length, 2);
    const large = detail.fileDiffs.find((f) => f.path === 'app.txt');
    assert.equal(large.additions, 450);
    assert.equal(large.lines.length, 300);
    assert.ok(large.omittedLines > 0);
    assert.equal(large.incomplete, false);
    assert.equal(detail.fileDiffs.find((f) => f.path === 'z-last.ts').additions, 1);
    assert.match(detail.patch, /more lines/, 'the existing raw patch preview stays bounded');
    assert.equal(s.run(['discard', id]).status, 0);
    assert.equal(s.run(['clean', '--days', '0', '--yes']).status, 0);
    assert.equal(fs.existsSync(path.join(s.base, 'home', 'runs', id)), false, 'the run directory was actually removed');
    const archived = JSON.parse((await get(`${url}api/run/${id}`)).body);
    assert.deepEqual(archived.fileDiffs, detail.fileDiffs, 'the same previews load from history');
  } finally {
    assert.equal(s.run(['dash', '--stop']).status, 0);
  }
});

test('dash: raw patches take precedence over clipped history, and clipped archives show incomplete counts', async () => {
  const s = sandbox();
  const generate = `node -e "require('fs').writeFileSync('a-large.ts', ('export const text = ' + 'x'.repeat(2600) + '\\n').repeat(450))"`;
  const run = s.run(['run', '-i', 'create a large patch'], { MOCK_ACTIONS: `exec:${generate};write:z-last.ts:export const last = true;answer:SUMMARY: done` });
  assert.equal(run.status, 0, run.stderr);
  const id = RUN_ID.exec(run.stdout)[0];
  const start = s.run(['dash', '--detach', '--port', '0']);
  assert.equal(start.status, 0, start.stderr);
  const url = start.stdout.trim();
  try {
    const detail = JSON.parse((await get(`${url}api/run/${id}`)).body);
    assert.equal(detail.fileDiffs.find((f) => f.path === 'a-large.ts').additions, 450, 'the full file is used while it is on disk');
    assert.equal(detail.fileDiffs.find((f) => f.path === 'z-last.ts').additions, 1);
    assert.equal(s.run(['discard', id]).status, 0);
    assert.equal(s.run(['clean', '--days', '0', '--yes']).status, 0);
    assert.equal(fs.existsSync(path.join(s.base, 'home', 'runs', id)), false);
    const archived = JSON.parse((await get(`${url}api/run/${id}`)).body);
    const large = archived.fileDiffs.find((f) => f.path === 'a-large.ts');
    assert.equal(large.incomplete, true);
    assert.equal(large.additions, undefined, 'partial counts are not presented as totals');
    assert.equal(archived.fileDiffs.find((f) => f.path === 'z-last.ts').unavailable, true, 'files beyond the history limit remain visible');
  } finally {
    assert.equal(s.run(['dash', '--stop']).status, 0);
  }
});

test('watch --brief: one card line when a run starts, one when it ends, then a total', () => {
  const s = sandbox();
  const started = s.run(['run', '--bg', 'list the files']);
  const id = RUN_ID.exec(started.stdout)[0];
  const w = s.run(['watch', id, '--brief', '--interval', '0.2']);
  assert.equal(w.status, 0, w.stderr);
  const lines = w.stdout.trim().split('\n');
  assert.match(lines[0], /^🏁 Pitroom ▶ research on opencode · list the files/);
  assert.match(lines[1], /^🏁 Pitroom ✔ research done on opencode/);
  assert.match(lines.at(-1), /^🏁 Pitroom: 1 run finished \(1 ok\)/);
  assert.ok(!w.stdout.includes('{'), 'cards, not JSON');
});

test('dash and history: a run whose --verify failed is marked and needs attention', async () => {
  const s = sandbox();
  const ok = /\d{8}-\d{6}-[0-9a-f]{4}/.exec(s.run(['run', '--verify', 'true', 'fine'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' }).stdout)[0];
  const bad = /\d{8}-\d{6}-[0-9a-f]{4}/.exec(s.run(['run', '--verify', 'false', 'broken'], { MOCK_ACTIONS: 'answer:SUMMARY: looks good' }).stdout)[0];
  const url = s.run(['dash', '--detach', '--port', '0']).stdout.trim();
  try {
    const runs = JSON.parse((await get(`${url}api/state`)).body).runs;
    const b = runs.find((r) => r.id === bad);
    assert.equal(b.verifyFailed, true);
    assert.match(b.note, /^verify failed: false/, 'the card does not read as success');
    assert.equal(runs.find((r) => r.id === ok).verifyFailed, undefined);
  } finally {
    s.run(['dash', '--stop']);
  }
  const problem = JSON.parse(s.run(['history', '--state', 'problem', '--json']).stdout);
  assert.deepEqual(problem.rows.map((r) => r.id), [bad], 'needs attention: the failed verify only');
  assert.equal(problem.rows[0].verifyFailed, true);
  assert.match(s.run(['history']).stdout, new RegExp(`${bad}.*verify failed`));
});
