import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  acquireWriteLock,
  releaseSlot,
  releaseWriteLock,
  slotHolders,
  tryAcquireSlot,
} from '../dist/lib.mjs';
import { scratchDir } from './helpers.mjs';

const DEAD_PID = 2 ** 22 - 1;

const ORIGINAL_HOME = process.env.PITROOM_HOME;

function useHome(t) {
  const home = scratchDir('pitroom-slots-');
  process.env.PITROOM_HOME = home;
  // always back to what the process started with, however many homes a test makes
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.PITROOM_HOME;
    else process.env.PITROOM_HOME = ORIGINAL_HOME;
  });
  return home;
}

function writeMeta(home, id, { state = 'running', pid, startedAt } = {}) {
  const dir = path.join(home, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    state,
    startedAt: startedAt ?? new Date().toISOString(),
    warnings: [],
    files: [],
    link: [],
    worker: { backend: 'opencode' },
    fallback: [],
  };
  if (pid !== undefined) meta.pid = pid;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

const live = (home, id) => writeMeta(home, id, { state: 'running', pid: process.pid });

test('slots: distinct files up to maxParallel, then undefined; same run is re-entrant', (t) => {
  const home = useHome(t);
  live(home, 'run-a');
  live(home, 'run-b');
  const a = tryAcquireSlot('run-a', 2);
  const b = tryAcquireSlot('run-b', 2);
  assert.ok(a && b && a !== b);
  assert.equal(tryAcquireSlot('run-c', 2), undefined);
  assert.equal(tryAcquireSlot('run-a', 2), a);
});

test('releaseSlot: only the owner is removed, others are a no-op, missing is ignored', (t) => {
  const home = useHome(t);
  live(home, 'run-a');
  const file = tryAcquireSlot('run-a', 1);
  releaseSlot(file, 'run-other');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'run-a');
  releaseSlot(file, 'run-a');
  assert.ok(!fs.existsSync(file));
  releaseSlot(file, 'run-a');
  releaseSlot(undefined, 'run-a');
});

test('stale slots are taken over: terminal state, dead pid, missing meta; grace protects recent pid-less runs', (t) => {
  let home = useHome(t);
  writeMeta(home, 'old', { state: 'done', pid: process.pid });
  assert.ok(tryAcquireSlot('new', 1)?.endsWith('slot-0'));
  assert.equal(fs.readFileSync(path.join(home, 'slots', 'slot-0'), 'utf8'), 'new');

  home = useHome(t);
  writeMeta(home, 'dead', { state: 'running', pid: DEAD_PID });
  assert.ok(tryAcquireSlot('new', 1));
  assert.equal(fs.readFileSync(path.join(home, 'slots', 'slot-0'), 'utf8'), 'new');

  home = useHome(t);
  tryAcquireSlot('ghost', 1);
  fs.rmSync(path.join(home, 'runs'), { recursive: true, force: true });
  assert.ok(tryAcquireSlot('new', 1), 'missing meta.json is treated as stale and taken over');
  assert.equal(fs.readFileSync(path.join(home, 'slots', 'slot-0'), 'utf8'), 'new');

  home = useHome(t);
  writeMeta(home, 'starting', { state: 'running' });
  tryAcquireSlot('starting', 1);
  assert.equal(tryAcquireSlot('new', 1), undefined, 'no pid + recent start is within the 30 s grace');
  writeMeta(home, 'starting', { state: 'running', startedAt: new Date(Date.now() - 60_000).toISOString() });
  assert.ok(tryAcquireSlot('new', 1), 'no pid + old start is stale');

  home = useHome(t);
  live(home, 'busy');
  tryAcquireSlot('busy', 1);
  assert.equal(tryAcquireSlot('new', 1), undefined, 'live holder (own pid, running) is not taken over');
});

test('slotHolders lists only live holders', (t) => {
  const home = useHome(t);
  live(home, 'live');
  writeMeta(home, 'term', { state: 'failed', pid: process.pid });
  tryAcquireSlot('live', 3);
  tryAcquireSlot('term', 3);
  tryAcquireSlot('ghost', 3);
  assert.deepEqual(slotHolders().sort(), ['live']);
});

test('write lock: live holder blocks with --isolate error, release frees it, dead taken over, repos independent', (t) => {
  const home = useHome(t);
  const repoA = path.join(home, 'repo-a');
  const repoB = path.join(home, 'repo-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  live(home, 'holder');
  acquireWriteLock(repoA, 'holder');
  assert.throws(() => acquireWriteLock(repoA, 'other'), /--isolate/);
  acquireWriteLock(repoB, 'other');
  releaseWriteLock(repoA, 'holder');
  acquireWriteLock(repoA, 'other');
  releaseWriteLock(repoA, 'other');

  const home2 = useHome(t);
  const repo = path.join(home2, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  writeMeta(home2, 'crashed', { state: 'running', pid: DEAD_PID });
  acquireWriteLock(repo, 'crashed');
  assert.doesNotThrow(() => acquireWriteLock(repo, 'next'));
});
