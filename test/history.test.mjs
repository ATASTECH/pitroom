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
