// The SQLite history: finished runs are recorded, their raw files compacted, and they outlive `clean`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const opts = { skip: !hasSqlite && 'node:sqlite needs Node.js 22.13+' };
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const runDir = (s, id) => path.join(s.base, 'home', 'runs', id);

test('history: a finished run is recorded, searchable, and its raw files are compacted', opts, () => {
  const s = sandbox();
  const r = s.run(['run', 'list the files in this project']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/ExperimentalWarning/.test(r.stderr), 'node:sqlite\'s experimental warning is not shown');
  const id = RUN_ID.exec(r.stdout)[0];

  const dir = runDir(s, id);
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl.gz')), 'the event stream is compressed after the run');
  assert.ok(!fs.existsSync(path.join(dir, 'events.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'stderr.log')) && !fs.existsSync(path.join(dir, 'stderr.log.gz')), 'a done run keeps no stderr');
  const events = s.run(['show', id, '--events']);
  assert.match(events.stdout, /^\{/, '--events reads the compressed stream');

  const list = JSON.parse(s.run(['history', '--json']).stdout);
  assert.equal(list.total, 1);
  assert.equal(list.rows[0].id, id);
  assert.equal(list.rows[0].state, 'done');
  assert.equal(list.rows[0].backend, 'opencode');
  assert.equal(JSON.parse(s.run(['history', 'zzzz', '--json']).stdout).total, 0, 'free-text search with no hit');
  assert.equal(JSON.parse(s.run(['history', 'list fil', '--json']).stdout).total, 1, 'words match by prefix');
  assert.equal(JSON.parse(s.run(['history', '--state', 'failed', '--json']).stdout).total, 0);

  const stats = s.run(['history', 'stats']);
  assert.match(stats.stdout, /1 runs · 1 ok/);
  assert.match(stats.stdout, /opencode/);
});

test('stats: saved is the ledger\'s figure, the same one `pitroom savings` and the Live page add up', opts, () => {
  const s = sandbox();
  assert.equal(s.run(['run', 'list the files']).status, 0);
  // a ledger entry whose run has no history row, as after a stop that raced with a crash report
  const ledger = path.join(s.base, 'home', 'ledger.jsonl');
  fs.appendFileSync(ledger, `${JSON.stringify({ id: '20260101-000000-abcd', at: new Date().toISOString(), mode: 'read', state: 'stopped', backend: 'opencode', model: 'mock/good-model', tokens: 1000, returned: 10, workerCost: 0, saved: 2.5, price: 'Claude Sonnet' })}\n`);
  const sum = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + JSON.parse(l).saved, 0);
  const stats = JSON.parse(s.run(['history', 'stats', '--json']).stdout);
  assert.ok(Math.abs(stats.totals.saved - sum) < 1e-9, `stats ${stats.totals.saved} equals the ledger ${sum}`);
  assert.ok(stats.totals.saved >= 2.5);
  // an old record (no backend, a model without its provider) joins its worker instead of becoming "unknown"
  fs.appendFileSync(ledger, `${JSON.stringify({ id: '20250101-000000-beef', at: new Date().toISOString(), mode: 'read', state: 'done', model: 'good-model', tokens: 10, returned: 1, workerCost: 0, saved: 1, price: 'Claude Sonnet' })}\n`);
  const old = JSON.parse(s.run(['history', 'stats', '--json']).stdout);
  assert.ok(!old.byWorker.some((w) => w.backend === 'unknown'));
  assert.ok(old.byWorker.find((w) => w.model === 'mock/good-model').saved > 1, 'the old record counts for mock/good-model');
  const sumWithOld = old.byWorker.reduce((a, w) => a + w.saved, 0);
  assert.ok(Math.abs(sumWithOld - old.totals.saved) < 1e-9, 'the rows still add up to the total');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').split('\n').filter((l) => l && !l.includes('20250101-000000-beef')).join('\n') + '\n');
  const worker = stats.byWorker.find((w) => w.model === 'mock/good-model');
  assert.ok(Math.abs(worker.saved - sum) < 1e-9, 'the per-worker figure comes from the same ledger');
  assert.doesNotMatch(s.run(['history', 'stats']).stdout, /NaN/, 'a worker the history lacks a run for prints a dash, not NaN');
  const fromStats = /~\$(\d+(?:\.\d+)?) sav/.exec(s.run(['history', 'stats']).stdout)[1];
  const fromSavings = /est\. saved\s+\$(\d+(?:\.\d+)?)/.exec(s.run(['savings', '--since', '7d']).stdout)[1];
  assert.equal(fromStats, fromSavings, 'the two commands print the same figure');
});

test('history: a failed run keeps its stderr, compressed', opts, () => {
  const s = sandbox();
  const r = s.run(['run', '--no-fallback', 'x'], { MOCK_FAIL_MODELS: 'default' });
  assert.equal(r.status, 1);
  const id = RUN_ID.exec(r.stdout)[0];
  const dir = runDir(s, id);
  assert.ok(fs.existsSync(path.join(dir, 'stderr.log.gz')) && !fs.existsSync(path.join(dir, 'stderr.log')));
  assert.equal(JSON.parse(s.run(['history', '--state', 'problem', '--json']).stdout).total, 1);
});

test('history: a run is still shown after `pitroom clean` removed its directory', opts, () => {
  const s = sandbox();
  const id = RUN_ID.exec(s.run(['run', 'list the files']).stdout)[0];
  const c = s.run(['clean', '--days', '0', '--yes']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /history and the savings ledger are kept/);
  assert.ok(!fs.existsSync(runDir(s, id)));
  const ls = s.run(['ls']);
  assert.match(ls.stdout + ls.stderr, /no runs yet/);
  const shown = s.run(['show', id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /done/);
  assert.match(shown.stdout, /SUMMARY/, 'the answer comes from the history');
  assert.equal(JSON.parse(s.run(['history', '--json']).stdout).total, 1);
  assert.equal(s.run(['show', id.slice(-4)]).status, 0, 'a short id resolves through the history too');
});

test('history: import takes in runs from before the history existed', opts, () => {
  const s = sandbox();
  const id = RUN_ID.exec(s.run(['run', 'list the files']).stdout)[0];
  for (const f of fs.readdirSync(path.join(s.base, 'home')).filter((x) => x.startsWith('history.db'))) fs.rmSync(path.join(s.base, 'home', f));
  const i = s.run(['history', 'import']);
  assert.match(i.stdout, /imported 1 run/);
  assert.equal(JSON.parse(s.run(['history', '--json']).stdout).rows[0].id, id);
  assert.match(s.run(['history', 'import']).stdout, /imported 0 run/, 'a second import finds nothing new');
});

test('stats: rate-limited runs are left out and shown apart, unless countRateLimits counts them', opts, () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a' });
  const limited = s.run(['run', 'where is app.txt?'], { MOCK_RATE_LIMIT_MODELS: 'mock/a' });
  assert.notEqual(limited.status, 0, 'no fallback: the run fails on the rate limit');
  const id = /run (\d{8}-\d{6}-[0-9a-f]{4})/.exec(limited.stdout)[1];
  assert.equal(JSON.parse(s.run(['show', id, '--json']).stdout).failureKind, 'rate-limited', 'the record says why');
  assert.equal(s.run(['run', 'what is in app.txt?']).status, 0);

  const left = JSON.parse(s.run(['history', 'stats', '--json']).stdout);
  assert.equal(left.rateLimits, 'excluded');
  assert.deepEqual([left.totals.runs, left.totals.ok, left.totals.failed, left.totals.limited], [1, 1, 0, 1]);
  // the history files both runs under the model the mock reports
  const [w] = left.byWorker;
  assert.deepEqual([w.runs, w.ok, w.limited], [1, 1, 1], 'the worker is judged on the run that reached it');
  assert.match(s.run(['history', 'stats']).stdout, /1 runs · 1 ok · 0 not ok · 1 rate-limited \(left out; "countRateLimits": true counts them\)/);

  s.config({ worker: 'opencode:mock/a', countRateLimits: true });
  const counted = JSON.parse(s.run(['history', 'stats', '--json']).stdout);
  assert.equal(counted.rateLimits, 'counted');
  assert.deepEqual([counted.totals.runs, counted.totals.ok, counted.totals.failed, counted.totals.limited], [2, 1, 1, 1]);
  assert.match(s.run(['history', 'stats']).stdout, /2 runs · 1 ok · 1 not ok · 1 rate-limited \(counted as not ok\)/);
});
