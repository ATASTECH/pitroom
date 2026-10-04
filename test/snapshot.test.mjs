// Read snapshots: a read run in a directory with secret-looking files reads a clean snapshot of the project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const real = (p) => fs.realpathSync(p);
const snapshots = (s) => {
  const dir = path.join(s.base, 'home', 'snapshots');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !d.startsWith('.')) : [];
};
/** Where the last worker process ran. */
const ranIn = (s) => real(s.calls().filter((c) => c.argv[0] === 'run').at(-1).cwd);
const withSecrets = (s) => {
  fs.writeFileSync(path.join(s.repo, '.env'), 'TOKEN=hunter2\n');
  fs.mkdirSync(path.join(s.repo, 'config'));
  fs.writeFileSync(path.join(s.repo, 'config', 'prod.pem'), 'PRIVATE\n');
  fs.writeFileSync(path.join(s.repo, 'config', 'ok.json'), '{}\n');
  s.git('add', 'config/prod.pem', 'config/ok.json'); // a tracked secret
  s.git('commit', '-qm', 'config');
};
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('snapshot: with secret-looking files a read run reads a clean snapshot of the current state', () => {
  const s = sandbox();
  withSecrets(s);
  fs.writeFileSync(path.join(s.repo, 'prod.env'), 'A=1\n');
  fs.writeFileSync(path.join(s.repo, 'deploy.key'), 'KEY\n');
  fs.writeFileSync(path.join(s.repo, '.env.example'), 'TOKEN=\n');
  const r = s.run(['run', 'where is app.txt?']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = ranIn(s);
  assert.ok(!fs.existsSync(path.join(dir, 'prod.env')) && !fs.existsSync(path.join(dir, 'deploy.key')), 'prod.env and a .key file are secrets too');
  assert.ok(fs.existsSync(path.join(dir, '.env.example')), 'a template is not');
  assert.equal(path.dirname(dir), real(path.join(s.base, 'home', 'snapshots')), 'the worker ran in a snapshot');
  assert.notEqual(dir, real(s.repo));
  assert.ok(!fs.existsSync(path.join(dir, '.env')), 'the untracked .env is not there');
  assert.ok(!fs.existsSync(path.join(dir, 'config', 'prod.pem')), 'nor is a tracked secret');
  assert.ok(fs.existsSync(path.join(dir, 'config', 'ok.json')), 'the rest of the project is');
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'keep\nuser wip\n', 'the uncommitted edit is in it');
  assert.equal(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'draft\n', 'and the untracked file');
  assert.match(r.stdout, /warning: read in a clean snapshot of your project: the secret-looking files \(.*\.env/);
  assert.doesNotMatch(r.stdout, /nothing stops it/, 'not the "nothing stops it" warning: something does');
  assert.ok(fs.existsSync(path.join(s.repo, '.env')) && fs.existsSync(path.join(s.repo, 'config', 'prod.pem')), 'the project itself is untouched');
  // its files cannot be written, so a stray write cannot change what other workers read
  assert.equal(fs.statSync(path.join(dir, 'app.txt')).mode & 0o222, 0, 'files are read-only');
});

test('snapshot: one snapshot per project state, shared by every read run on it; a changed file makes a new one', () => {
  const s = sandbox();
  withSecrets(s);
  assert.equal(s.run(['run', 'one']).status, 0);
  const first = ranIn(s);
  assert.equal(s.run(['run', 'two']).status, 0);
  assert.equal(ranIn(s), first, 'the second run reads the same snapshot');
  assert.equal(snapshots(s).length, 1);
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'changed\n');
  assert.equal(s.run(['run', 'three']).status, 0);
  assert.notEqual(ranIn(s), first, 'a changed project is a new snapshot');
  assert.equal(snapshots(s).length, 2);
  assert.match(fs.readFileSync(path.join(ranIn(s), 'app.txt'), 'utf8'), /changed/);
});

test('snapshot: no secret-looking files means no snapshot; --in-place and readIn "project" read the directory', () => {
  const clean = sandbox();
  assert.equal(clean.run(['run', 'x']).status, 0);
  assert.equal(ranIn(clean), real(clean.repo), 'nothing to hide: the worker runs in place');
  assert.equal(snapshots(clean).length, 0);

  const s = sandbox();
  withSecrets(s);
  assert.equal(s.run(['run', '--in-place', 'x']).status, 0);
  assert.equal(ranIn(s), real(s.repo));
  assert.equal(snapshots(s).length, 0);
  s.config({ readIn: 'project' });
  const r = s.run(['run', 'y']);
  assert.equal(ranIn(s), real(s.repo));
  assert.match(r.stdout, /warning: secret-looking files sit in the directory the worker runs in/, 'the old heads-up still applies');
  assert.equal(clean.run(['run', 'z'], { PITROOM_READ_IN: 'snapshot' }).status, 0);
  assert.notEqual(ranIn(clean), real(clean.repo), '"snapshot" reads one even with nothing to hide');
});

test('snapshot: paths the worker cites are the project\'s, a follow-up stays in the snapshot, and a change makes no read snapshot', () => {
  const s = sandbox();
  withSecrets(s);
  assert.equal(s.run(['run', 'where is app.txt?']).status, 0);
  const dir = ranIn(s);
  // the worker can only know the snapshot's absolute paths
  const cited = s.run(['run', 'cite'], { MOCK_ACTIONS: `answer:SUMMARY: see ${dir}/app.txt:1` });
  assert.match(cited.stdout, new RegExp(`see ${escape(real(s.repo))}/app\\.txt:1`), 'the snapshot path is the project path in the report');
  assert.doesNotMatch(cited.stdout, /snapshots/);
  assert.match(cited.stdout, /refs: 1\/1 verified/);

  const id = /\d{8}-\d{6}-[0-9a-f]{4}/.exec(cited.stdout)[0];
  const follow = s.run(['run', '--continue', id, 'and more']);
  assert.equal(follow.status, 0, follow.stdout + follow.stderr);
  assert.equal(ranIn(s), dir, 'a follow-up reads the same snapshot');

  const change = s.run(['run', '--isolate', 'extend'], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: ok' });
  assert.equal(change.status, 0, change.stdout + change.stderr);
  assert.equal(snapshots(s).length, 1, 'an isolated change makes no read snapshot');
});

test('snapshot: `pitroom clean --yes` removes snapshots nobody uses', () => {
  const s = sandbox();
  withSecrets(s);
  assert.equal(s.run(['run', 'x']).status, 0);
  assert.equal(snapshots(s).length, 1);
  const out = s.run(['clean', '--yes']).stdout;
  assert.match(out, /read snapshot/);
  assert.equal(snapshots(s).length, 0);
});

test('snapshot: only the newest few are kept, however recent they are', () => {
  const s = sandbox();
  withSecrets(s);
  for (let i = 0; i < 9; i++) {
    fs.appendFileSync(path.join(s.repo, 'app.txt'), `edit ${i}\n`);
    assert.equal(s.run(['run', `read ${i}`]).status, 0);
  }
  // each run's own prune keeps 6 of the ones used over ten minutes ago; here all are fresh, so none went yet
  assert.equal(snapshots(s).length, 9);
  const dir = path.join(s.base, 'home', 'snapshots');
  const old = Date.now() / 1000 - 3600;
  for (const n of snapshots(s)) fs.utimesSync(path.join(dir, n), old, old); // used an hour ago
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'one more\n');
  assert.equal(s.run(['run', 'last']).status, 0);
  assert.equal(snapshots(s).length, 6, 'the newest six: the fresh one and five of the old ones');
});
