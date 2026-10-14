// Read snapshots: a read run in a directory with secret-looking files reads a clean snapshot of the project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'app.txt')).mode & 0o222, 0, 'files are read-only');
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

const AGY_MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity', 'mock', 'agy.mjs');

const agyCalls = (s) => s.calls().filter((c) => c.backend === 'antigravity' && c.argv[0] === '-p');
const SNAPSHOTS = (s) => real(path.join(s.base, 'home', 'snapshots'));

test('snapshot: a worker that may write in a read run (Antigravity) reads a snapshot of its own, never the project or a shared one', () => {
  const s = sandbox();
  const before = s.status();
  // agy writes in a read run despite --mode plan; its stream reports no edit, so only the snapshot shows it
  const r = s.run(['run', '--json', '-W', 'antigravity', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_AGY_WRITE: 'stray.txt' });
  const meta = JSON.parse(r.stdout);
  const call = agyCalls(s).at(-1);
  assert.ok(call, r.stdout + r.stderr);
  assert.equal(path.dirname(real(call.cwd)), SNAPSHOTS(s), 'the worker ran in a snapshot');
  assert.ok(path.basename(call.cwd).endsWith(`-${meta.id}`), 'of its own');
  assert.equal(meta.snapshot.private, true);
  assert.ok(!fs.existsSync(path.join(s.repo, 'stray.txt')), 'the project itself is untouched');
  assert.equal(s.status(), before);
  // only what it wrote: the snapshot's other files, all "added" to a checkout without a commit, are not blamed
  assert.ok(meta.warnings.some((w) => /^READ-ONLY VIOLATION: Antigravity CLI wrote in its read-only snapshot [^:]*: stray\.txt$/.test(w)), meta.warnings.join('\n'));
  // another worker reading a snapshot of the same state does not see the stray file
  s.run(['run', 'where is app.txt?'], { PITROOM_READ_IN: 'snapshot' });
  const shared = ranIn(s);
  assert.equal(path.dirname(shared), SNAPSHOTS(s));
  assert.notEqual(shared, real(call.cwd));
  assert.ok(!fs.existsSync(path.join(shared, 'stray.txt')));
  // a follow-up continues in the same snapshot of its own, and is not blamed for what its parent wrote there
  const follow = JSON.parse(s.run(['run', '--json', '--continue', meta.id, 'and sub?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK }).stdout);
  assert.equal(real(agyCalls(s).at(-1).cwd), real(call.cwd));
  assert.ok(!follow.warnings.some((w) => w.startsWith('READ-ONLY VIOLATION')), follow.warnings.join('\n'));
});

test('snapshot: a worker after Antigravity in the chain never reads what it wrote; a second Antigravity attempt gets a fresh snapshot', () => {
  const s = sandbox();
  // agy writes, then fails (no answer): the next worker reads the project as planned, not agy's snapshot
  s.config({ worker: 'antigravity', fallback: ['opencode:mock/good-model'] });
  const r = s.run(['run', '--json', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_AGY_WRITE: 'stray.txt', MOCK_AGY_FIXTURE: 'failures/quota.stdout.jsonl' });
  const meta = JSON.parse(r.stdout);
  assert.equal(meta.ran.backend, 'opencode', r.stdout);
  assert.equal(ranIn(s), real(s.repo), 'opencode reads the project, where it would have read without agy');
  assert.equal(meta.snapshot, undefined);
  assert.ok(!fs.existsSync(path.join(s.repo, 'stray.txt')));
  // two Antigravity targets: the second does not read the first one's writes
  s.config({ worker: 'antigravity:model-a', fallback: ['antigravity:model-b'] });
  s.run(['run', 'where is sub?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_AGY_WRITE: 'stray.txt', MOCK_AGY_FIXTURE: 'failures/quota.stdout.jsonl' });
  const [first, second] = agyCalls(s).slice(-2);
  assert.notEqual(real(first.cwd), real(second.cwd));
});

test('snapshot: Antigravity as a fallback costs nothing until it runs, then reads a snapshot of its own', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model', fallback: ['antigravity'] });
  s.run(['run', 'where is app.txt?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK });
  assert.equal(ranIn(s), real(s.repo), 'the first worker answered in place: no snapshot made for a fallback that never ran');
  assert.ok(!fs.existsSync(path.join(s.base, 'home', 'snapshots')) || !fs.readdirSync(path.join(s.base, 'home', 'snapshots')).length);
  s.config({ worker: 'opencode:mock/limited', fallback: ['antigravity'] });
  const r = s.run(['run', '--json', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_RATE_LIMIT_MODELS: 'mock/limited' });
  const meta = JSON.parse(r.stdout);
  assert.equal(meta.ran.backend, 'antigravity', r.stdout);
  assert.equal(path.dirname(real(agyCalls(s).at(-1).cwd)), SNAPSHOTS(s));
  assert.equal(meta.cache, undefined, 'read in a snapshot, not where the cache key expected (the project): not cached under it');
});

test('snapshot: Antigravity does not run when its snapshot cannot be made; --in-place reads the project, with a warning', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.base, 'home'), { recursive: true });
  fs.writeFileSync(path.join(s.base, 'home', 'snapshots'), 'not a folder\n');
  const r = s.run(['run', '--json', '-W', 'antigravity', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_AGY_WRITE: 'stray.txt' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /could not make a snapshot for Antigravity CLI/);
  assert.equal(JSON.parse(r.stdout).noAttempt, true, 'not counted against the worker in its record');
  assert.equal(agyCalls(s).length, 0, 'agy never started');
  assert.ok(!fs.existsSync(path.join(s.repo, 'stray.txt')));
  const inPlace = s.run(['run', '--in-place', '-W', 'antigravity', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK });
  assert.equal(real(agyCalls(s).at(-1).cwd), real(s.repo));
  assert.match(inPlace.stdout, /not in a snapshot, and Antigravity CLI does not reliably stay read-only/);
});

test('snapshot: an Antigravity answer is cached under "snapshot", and the doctor probe runs it outside the project', () => {
  const s = sandbox();
  const meta = JSON.parse(s.run(['run', '--json', '-W', 'antigravity', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK }).stdout);
  assert.equal(meta.cache?.where, 'snapshot');
  s.run(['doctor', '--probe'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, PITROOM_WORKER: 'antigravity' });
  const probe = agyCalls(s).at(-1);
  assert.ok(probe.argv[1].includes('PONG'), 'the probe ran');
  assert.match(path.basename(probe.cwd), /^pitroom-probe-/, 'an empty folder of its own, not the project');
  assert.ok(!fs.existsSync(probe.cwd), 'removed afterwards');
});

test('snapshot: runs\' own snapshots keep their own quota when pruning, so they do not push out the shared ones', () => {
  const s = sandbox();
  const dir = path.join(s.base, 'home', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const old = (Date.now() - 3_600_000) / 1000;
  const make = (name) => {
    fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true });
    fs.utimesSync(path.join(dir, name), old, old);
  };
  make('a'.repeat(40));
  for (let i = 0; i < 8; i++) make(`${'b'.repeat(40)}-20261014-12000${i}-abcd`);
  // making a snapshot prunes the others
  assert.equal(s.run(['run', 'where is app.txt?'], { PITROOM_READ_IN: 'snapshot' }).status, 0);
  const left = fs.readdirSync(dir);
  assert.ok(left.includes('a'.repeat(40)), 'an older shared snapshot stays');
  assert.equal(left.filter((n) => n.includes('-')).length, 6, 'the newest few own snapshots stay');
});

test('snapshot: Antigravity after another worker in between still gets a fresh snapshot; a pruned own snapshot is made again for a follow-up', () => {
  const s = sandbox();
  s.config({ worker: 'antigravity:model-a', fallback: ['opencode:mock/limited', 'antigravity:model-b'] });
  const env = { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_AGY_WRITE: 'stray.txt', MOCK_AGY_FIXTURE: 'failures/quota.stdout.jsonl', MOCK_RATE_LIMIT_MODELS: 'mock/limited' };
  s.run(['run', 'where is sub?'], env);
  const [a, b] = agyCalls(s).slice(-2);
  assert.notEqual(real(a.cwd), real(b.cwd), 'model-b does not read what model-a wrote');
  // a follow-up whose own snapshot was pruned gets it made again
  const meta = JSON.parse(s.run(['run', '--json', '-W', 'antigravity', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK }).stdout);
  fs.chmodSync(meta.snapshot.dir, 0o755);
  for (const f of fs.readdirSync(meta.snapshot.dir)) if (f !== '.git') fs.chmodSync(path.join(meta.snapshot.dir, f), 0o644);
  fs.rmSync(meta.snapshot.dir, { recursive: true, force: true });
  const r = s.run(['run', '--json', '--continue', meta.id, 'and sub?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK });
  const follow = JSON.parse(r.stdout);
  assert.equal(follow.state, 'done', r.stdout + r.stderr);
  assert.ok(follow.warnings.some((w) => /was cleaned up and has been made again/.test(w)));
  assert.ok(fs.existsSync(path.join(meta.snapshot.dir, 'app.txt')));
});

test('snapshot: when Antigravity cannot run after a rate-limited worker, the run is that worker\'s rate limit, not a new failure', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.base, 'home'), { recursive: true });
  fs.writeFileSync(path.join(s.base, 'home', 'snapshots'), 'not a folder\n');
  s.config({ worker: 'opencode:mock/limited', fallback: ['antigravity'] });
  const meta = JSON.parse(s.run(['run', '--json', 'where is add?'], { PITROOM_ANTIGRAVITY_BIN: AGY_MOCK, MOCK_RATE_LIMIT_MODELS: 'mock/limited' }).stdout);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.failureKind, 'rate-limited');
  assert.equal(meta.noAttempt, undefined);
  assert.match(meta.error, /then could not make a snapshot for Antigravity CLI/);
});
