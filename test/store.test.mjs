// Run store + worker spawning (src/core/store.ts, src/core/process.ts via dist/lib.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  STOP_FILE,
  TERMINAL,
  freshMeta,
  home,
  isActive,
  isAlive,
  listRunIds,
  newRunId,
  readMeta,
  requestStop,
  resolveRun,
  runDir,
  runFile,
  runsDir,
  spawnWorker,
  writeMeta,
} from '../dist/lib.mjs';
import { scratchDir } from './helpers.mjs';

const ORIGINAL_HOME = process.env.PITROOM_HOME;
const DEAD_PID = 2 ** 22 - 1;

function useHome(t) {
  const h = scratchDir('pitroom-store-');
  process.env.PITROOM_HOME = h;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.PITROOM_HOME;
    else process.env.PITROOM_HOME = ORIGINAL_HOME;
  });
  return h;
}

const base = (id, over = {}) => ({
  id, state: 'queued', startedAt: new Date().toISOString(),
  warnings: [], files: [], link: [], worker: { backend: 'opencode' }, fallback: [],
  ...over,
});
const rawWrite = (h, id, obj) => {
  fs.mkdirSync(path.join(h, 'runs', id), { recursive: true });
  fs.writeFileSync(path.join(h, 'runs', id, 'meta.json'), JSON.stringify(obj));
};
const userError = (fn, re) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.constructor.name, 'UserError');
    assert.match(e.message, re);
    return;
  }
  assert.fail('expected a UserError');
};

test('newRunId: YYYYMMDD-HHMMSS-4hex, uses the given date, ids differ', () => {
  assert.match(newRunId(), /^\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.ok(newRunId(new Date(2024, 0, 2, 3, 4, 5)).startsWith('20240102-030405-'));
  assert.notEqual(newRunId(), newRunId());
});

test('paths live under home(), read from PITROOM_HOME on every call', (t) => {
  const h = useHome(t);
  assert.equal(home(), h);
  assert.equal(runsDir(), path.join(h, 'runs'));
  assert.equal(runDir('abc'), path.join(h, 'runs', 'abc'));
  assert.equal(runFile('abc', 'meta.json'), path.join(h, 'runs', 'abc', 'meta.json'));
});

test('writeMeta/readMeta round trip, no .tmp left behind', (t) => {
  useHome(t);
  const m = base('20260101-000000-aaaa', { state: 'done', task: 'q' });
  writeMeta(m);
  assert.deepEqual(readMeta(m.id), m);
  assert.ok(!fs.readdirSync(runDir(m.id)).some((f) => f.endsWith('.tmp')), 'atomic write leaves no .tmp');
  // useArchive is not exported from dist/lib.mjs, so the terminal-state archive hook cannot be wired up here.
});

test('readMeta backfills missing worker/fallback/warnings/files/link; legacy fallbackModels maps to fallback', (t) => {
  const h = useHome(t);
  rawWrite(h, 'old', { id: 'old', model: 'm1', fallbackModels: ['m2', 'm3'], state: 'done', task: 'q' });
  assert.deepEqual(readMeta('old').worker, { backend: 'opencode', model: 'm1' });
  assert.deepEqual(readMeta('old').fallback, [{ backend: 'opencode', model: 'm2' }, { backend: 'opencode', model: 'm3' }]);
  assert.deepEqual([readMeta('old').warnings, readMeta('old').files, readMeta('old').link], [[], [], []]);
  rawWrite(h, 'plain', { id: 'plain', state: 'done' });
  assert.deepEqual(readMeta('plain').worker, { backend: 'opencode' });
  assert.deepEqual(readMeta('plain').fallback, []);
});

test('listRunIds is sorted and ignores folders without meta.json', (t) => {
  const h = useHome(t);
  assert.deepEqual(listRunIds(), []);
  rawWrite(h, 'b', base('b'));
  rawWrite(h, 'a', base('a'));
  fs.mkdirSync(path.join(h, 'runs', 'empty'), { recursive: true });
  assert.deepEqual(listRunIds(), ['a', 'b']);
});

test('resolveRun: latest/last, full id, unique prefix/suffix, ambiguous, unknown, empty store', (t) => {
  useHome(t);
  userError(() => resolveRun(undefined), /no runs yet/);
  userError(() => resolveRun('latest'), /no runs yet/);
  for (const id of ['20260101-000000-aaaa', '20260101-000001-bbbb']) rawWrite(home(), id, base(id));
  assert.equal(resolveRun(undefined), '20260101-000001-bbbb');
  assert.equal(resolveRun('latest'), '20260101-000001-bbbb');
  assert.equal(resolveRun('last'), '20260101-000001-bbbb');
  assert.equal(resolveRun('20260101-000000-aaaa'), '20260101-000000-aaaa');
  assert.equal(resolveRun('20260101-000000'), '20260101-000000-aaaa');
  assert.equal(resolveRun('bbbb'), '20260101-000001-bbbb');
  userError(() => resolveRun('20260101'), /ambiguous run/);
  userError(() => resolveRun('zzz-nope'), /unknown run/);
});

test('isAlive: own pid true; undefined/0/a pid that cannot exist false', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(undefined), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(DEAD_PID), false);
});

test('isActive is the complement of TERMINAL', () => {
  assert.deepEqual(TERMINAL, ['done', 'failed', 'timeout', 'stopped']);
  assert.equal(isActive('queued'), true);
  assert.equal(isActive('running'), true);
  for (const s of TERMINAL) assert.equal(isActive(s), false);
});

test('freshMeta: dead pid fails, STOP_FILE stops, terminal is untouched, live pid keeps running', (t) => {
  useHome(t);
  writeMeta(base('crashed', { state: 'running', pid: DEAD_PID }));
  const failed = freshMeta('crashed');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'worker process exited unexpectedly');
  assert.ok(failed.endedAt, 'endedAt is set');
  assert.equal(readMeta('crashed').state, 'failed', 'persisted');

  writeMeta(base('asked', { state: 'running', pid: DEAD_PID }));
  requestStop('asked');
  assert.ok(fs.existsSync(runFile('asked', STOP_FILE)));
  const stopped = freshMeta('asked');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.error, undefined);

  const done = base('over', { state: 'done', pid: DEAD_PID, error: 'x' });
  writeMeta(done);
  assert.deepEqual(freshMeta('over'), done);

  writeMeta(base('live', { state: 'running', pid: process.pid }));
  const kept = freshMeta('live');
  assert.equal(kept.state, 'running');
  assert.equal(kept.endedAt, undefined);
});

test('spawnWorker: exit codes and stdout capture', async (t) => {
  const h = useHome(t);
  const out = (n) => ({ cwd: h, stdoutFile: path.join(h, `${n}.out`), stderrFile: path.join(h, `${n}.err`), timeoutSec: 30 });
  const ok = await spawnWorker({ command: process.execPath, args: ['-e', 'console.log(1)'], env: {} }, out('ok'));
  assert.deepEqual([ok.code, ok.timedOut, ok.spawnError], [0, false, undefined]);
  assert.match(fs.readFileSync(path.join(h, 'ok.out'), 'utf8'), /1/);
  const bad = await spawnWorker({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }, out('bad'));
  assert.equal(bad.code, 3);
});

test('spawnWorker: missing command and missing cwd', async (t) => {
  const h = useHome(t);
  const files = (n) => ({ cwd: h, stdoutFile: path.join(h, `${n}.out`), stderrFile: path.join(h, `${n}.err`), timeoutSec: 30 });
  const missing = await spawnWorker({ command: 'pitroom-definitely-missing-cmd', args: [], env: {} }, files('m'));
  assert.equal(missing.spawnError, 'pitroom-definitely-missing-cmd not found');
  const gone = path.join(h, 'no-such-dir');
  const badCwd = await spawnWorker({ command: process.execPath, args: ['-e', '1'], env: {} }, { ...files('c'), cwd: gone });
  assert.equal(badCwd.spawnError, `the working directory ${gone} does not exist`);
});

test('spawnWorker: timeoutSec kills a sleeper; PWD in the child equals cwd', async (t) => {
  const h = useHome(t);
  const cwd = path.join(h, 'work');
  fs.mkdirSync(cwd);
  const files = (n) => ({ cwd, stdoutFile: path.join(cwd, `${n}.out`), stderrFile: path.join(cwd, `${n}.err`), timeoutSec: 30 });
  const slow = await spawnWorker({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)'], env: {} }, { ...files('s'), timeoutSec: 1 });
  assert.equal(slow.timedOut, true);
  await spawnWorker({ command: process.execPath, args: ['-e', 'console.log(process.env.PWD)'], env: {} }, files('p'));
  assert.equal(fs.readFileSync(path.join(cwd, 'p.out'), 'utf8').trim(), cwd);
});
