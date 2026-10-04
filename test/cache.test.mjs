// Answer cache: the same read question on the same code gets the earlier answer back, and no worker runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const ANSWER = { MOCK_ACTIONS: 'answer:SUMMARY: app.txt holds line1 (app.txt:1)' };
const workerRuns = (s) => s.calls().filter((c) => c.argv[0] === 'run').length;
const ask = (s, task, extra = [], env = ANSWER) => s.run(['run', ...extra, task], env);

test('cache: the same question on the same code is answered from the earlier run, with no worker', () => {
  const s = sandbox();
  const first = ask(s, 'where is app.txt?');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const id = RUN_ID.exec(first.stdout)[0];
  assert.equal(workerRuns(s), 1);

  const again = ask(s, '  where   is app.txt?\n'); // the same question, other whitespace
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(workerRuns(s), 1, 'no worker ran');
  assert.match(again.stdout, new RegExp(`pitroom ⟲ cached answer · the same question on the same code as run ${id} \\(\\d+ min ago\\) · no worker ran · --fresh asks one again`));
  assert.match(again.stdout, /SUMMARY: app\.txt holds line1/);
  const json = JSON.parse(ask(s, 'where is app.txt?', ['--bg', '--json']).stdout);
  assert.deepEqual([json.id, json.cached, json.state], [id, true, 'done'], 'in the background too, done at once');
  assert.equal(workerRuns(s), 1);

  assert.equal(ask(s, 'where is app.txt?', ['--fresh']).status, 0);
  assert.equal(workerRuns(s), 2, '--fresh asks a worker');
  assert.equal(ask(s, 'what is app.txt for?').status, 0);
  assert.equal(workerRuns(s), 3, 'another question is another run');
});

test('cache: any change to the project is new code, so a new run', () => {
  const s = sandbox();
  assert.equal(ask(s, 'q').status, 0);
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'edited\n');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 2, 'an uncommitted edit');
  fs.writeFileSync(path.join(s.repo, 'new.txt'), 'x\n');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 3, 'a new untracked file');
  s.git('add', '-A');
  s.git('commit', '-qm', 'same files, new commit');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 4, 'a new commit with the same files');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 4, 'and then the cache answers again');
  fs.mkdirSync(path.join(s.repo, 'sub'));
  fs.writeFileSync(path.join(s.repo, '.gitignore'), 'ignored.log\n');
  s.git('add', '-A');
  s.git('commit', '-qm', 'ignore');
  assert.equal(ask(s, 'q').status, 0);
  fs.writeFileSync(path.join(s.repo, 'ignored.log'), 'noise\n');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 5, 'an ignored file is not part of the code');
});

test('cache: only answers that held up are reused, and only for plain read questions', () => {
  const s = sandbox();
  // a reference that does not check out
  assert.equal(ask(s, 'bad refs', [], { MOCK_ACTIONS: 'answer:SUMMARY: see nope.txt:3' }).status, 0);
  assert.equal(ask(s, 'bad refs', [], { MOCK_ACTIONS: 'answer:SUMMARY: see nope.txt:3' }).status, 0);
  assert.equal(workerRuns(s), 2, 'an answer with an unverified reference is asked again');
  // a failed run
  ask(s, 'fails', [], { MOCK_ACTIONS: 'fail:boom' });
  const before = workerRuns(s);
  ask(s, 'fails', [], ANSWER);
  assert.ok(workerRuns(s) > before, 'a failed run is not an answer');
  // changes, follow-ups, explicit audits
  assert.equal(ask(s, 'change it', ['-i'], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: done' }).status, 0);
  const n = workerRuns(s);
  assert.equal(ask(s, 'change it', ['-i'], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: done' }).status, 0);
  assert.equal(workerRuns(s), n + 1, 'isolated changes are never cached');
  const id = RUN_ID.exec(ask(s, 'where is app.txt?').stdout)[0];
  const m = workerRuns(s);
  assert.equal(s.run(['run', '--continue', id, 'where is app.txt?'], ANSWER).status, 0);
  assert.equal(workerRuns(s), m + 1, 'a follow-up goes to its worker session');
});

test('cache: cacheDays sets how long an answer is reused, and 0 turns the cache off', () => {
  const s = sandbox();
  const id = RUN_ID.exec(ask(s, 'q').stdout)[0];
  const metaFile = path.join(s.base, 'home', 'runs', id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.ok(meta.cache?.key && meta.cache?.state, 'the run keeps its cache key');
  meta.endedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 2, 'an answer over 7 days old is not reused');
  s.config({ cacheDays: 30 });
  meta.endedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 2, 'the newer one is');
  s.config({ cacheDays: 0 });
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 3, 'off');
  s.config({});
  assert.equal(s.run(['run', 'q'], { ...ANSWER, PITROOM_CACHE_DAYS: '0' }).status, 0);
  assert.equal(workerRuns(s), 4, 'off from the environment too');
  assert.match(s.run(['config']).stdout, /cacheDays/);
});

test('cache: an answer read in a clean snapshot is not reused for a question read in place, where the worker sees more', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, '.env'), 'TOKEN=1\n');
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(ask(s, 'q', ['--in-place']).status, 0);
  assert.equal(workerRuns(s), 2);
  assert.equal(ask(s, 'q', ['--in-place']).status, 0);
  assert.equal(ask(s, 'q').status, 0);
  assert.equal(workerRuns(s), 2, 'each is reused where it was read');
});

test('cache: through MCP, a repeated question says it is a cached answer, and fresh asks a worker', async () => {
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const { CLI } = await import('./helpers.mjs');
  const s = sandbox();
  const proc = spawn(process.execPath, [CLI, 'mcp'], { cwd: s.repo, env: { ...s.env, PWD: s.repo, ...ANSWER }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const call = (args) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, (m) => resolve(m.result.content[0].text));
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pitroom_run', arguments: args } })}\n`);
    });
  try {
    const first = await call({ task: 'where is app.txt?' });
    assert.doesNotMatch(first, /Cached answer/);
    const again = await call({ task: 'where is app.txt?' });
    assert.match(again, /^Cached answer: the same question on the same code as run \d{8}-\d{6}-[0-9a-f]{4}; no worker ran/);
    assert.match(again, /SUMMARY: app\.txt holds line1/);
    assert.equal(workerRuns(s), 1);
    assert.doesNotMatch(await call({ task: 'where is app.txt?', fresh: true }), /Cached answer/);
    assert.equal(workerRuns(s), 2);
  } finally {
    await new Promise((resolve) => { proc.once('close', resolve); proc.stdin.end(); });
  }
});
