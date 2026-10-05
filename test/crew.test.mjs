// Parallel workers: groups, waiting, live watching, the queue, the write lock
// and applying a group's patches. Each task carries its own mock script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { posixOnly, sandbox } from './helpers.mjs';

const task = (script, words = 'task') => `${words} [[mock:${script}]]`;

test('crew starts a group in background and wait -g collects every report', () => {
  const s = sandbox();
  const r = s.run(['crew', '-g', 'g1', task('sleep:1;answer:SUMMARY: one'), task('answer:SUMMARY: two'), task('answer:SUMMARY: three')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pitroom crew "g1": 3 read workers started/);
  const w = s.run(['wait', '-g', 'g1', '--timeout', '30']);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  for (const n of ['one', 'two', 'three']) assert.match(w.stdout, new RegExp(`SUMMARY: ${n}`));
  const brief = s.run(['wait', '-g', 'g1', '--brief']);
  assert.equal(brief.stdout.trim().split('\n').length, 3);
  assert.match(brief.stdout, /pitroom done · \S+ · two/);
  assert.match(s.run(['status', '-g', 'g1']).stdout, /RUN\s+STATE\s+MODE/);
});

test('wait --any returns at the first finished worker', () => {
  const s = sandbox();
  s.run(['crew', '-g', 'g2', task('answer:SUMMARY: fast'), task('sleep:6;answer:SUMMARY: slow')]);
  const t0 = Date.now();
  const w = s.run(['wait', '-g', 'g2', '--any', '--timeout', '30']);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the slow one');
  assert.match(w.stdout, /SUMMARY: fast/);
  assert.match(w.stdout, /1 still active/);
  s.run(['stop', '-g', 'g2']);
});

test('maxParallel queues extra workers', () => {
  const s = sandbox();
  const env = { PITROOM_MAX_PARALLEL: '1' };
  const t0 = Date.now();
  s.run(['crew', '-g', 'q', task('sleep:1.5;answer:SUMMARY: a'), task('sleep:1.5;answer:SUMMARY: b'), task('sleep:1.5;answer:SUMMARY: c')], env);
  const ls = s.run(['ls', '-g', 'q'], env);
  assert.match(ls.stdout, /queued/, ls.stdout);
  const w = s.run(['wait', '-g', 'q', '--timeout', '60'], env);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.ok(Date.now() - t0 >= 4000, `ran one at a time (${Date.now() - t0}ms)`);
});

test('only one --write run per repository; --isolate for parallel changes', () => {
  const s = sandbox();
  const first = s.run(['run', '--write', '--bg', task('sleep:3;append:app.txt:first;answer:SUMMARY: first')]);
  assert.equal(first.status, 0, first.stderr);
  const second = s.run(['run', '--write', task('answer:SUMMARY: second')]);
  assert.equal(second.status, 3);
  assert.match(second.stderr, /another --write run \(\S+\) is active in this repo; use --isolate/);
  assert.equal(s.run(['wait', '--timeout', '30']).status, 0);
  assert.equal(s.run(['run', '--write', task('answer:SUMMARY: third')]).status, 0, 'lock released after the run');
  const crew = s.run(['crew', '--write', task('answer:x'), task('answer:y')]);
  assert.equal(crew.status, 2);
  assert.match(crew.stderr, /use --isolate/);
});

test('watch --json emits one line per change and ends with all-done', () => {
  const s = sandbox();
  s.run(['crew', '-g', 'w', task('sleep:1;answer:SUMMARY: left'), task('answer:SUMMARY: right')]);
  const r = s.run(['watch', '-g', 'w', '--json', '--interval', '0.3', '--timeout', '30']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.at(-1).event, 'all-done');
  assert.equal(events.at(-1).ok, 2);
  const done = events.filter((e) => e.event === 'done');
  assert.deepEqual(done.map((e) => e.summary).sort(), ['left', 'right']);
  for (const e of events.slice(0, -1)) assert.ok(e.run, 'every event names its run');
});

test('apply -g applies isolate patches in order and stops at a conflict', () => {
  const s = sandbox();
  s.run(['crew', '-i', '-g', 'ok', task('append:app.txt:from-a;answer:SUMMARY: a'), task('append:other.txt:from-b;answer:SUMMARY: b')]);
  assert.equal(s.run(['wait', '-g', 'ok', '--timeout', '30']).status, 0);
  const a = s.run(['apply', '-g', 'ok']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /from-a/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8'), 'keep\nuser wip\nfrom-b\n');

  s.run(['crew', '-i', '-g', 'clash', task('write:app.txt:version-1;answer:SUMMARY: 1'), task('write:app.txt:version-2;answer:SUMMARY: 2')]);
  assert.equal(s.run(['wait', '-g', 'clash', '--timeout', '30']).status, 0);
  const c = s.run(['apply', '-g', 'clash']);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /✘ \S+: patch does not apply cleanly/);
  assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /^version-[12]\n$/, 'first patch applied, second refused');
});

test('stop -g cancels running and queued workers', () => {
  const s = sandbox();
  const env = { PITROOM_MAX_PARALLEL: '1' };
  s.run(['crew', '-g', 's', task('sleep:20;answer:late'), task('sleep:20;answer:late')], env);
  const deadline = Date.now() + 10_000;
  while (!/running/.test(s.run(['ls', '-g', 's'], env).stdout) && Date.now() < deadline);
  const stop = s.run(['stop', '-g', 's'], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /stopping \S+ \(running\)/);
  assert.match(stop.stdout, /stopping \S+ \(queued\)/);
  const w = s.run(['wait', '-g', 's', '--brief', '--timeout', '30'], env);
  assert.equal((w.stdout.match(/pitroom stopped/g) ?? []).length, 2, w.stdout);
});

test('apply refuses a patch that deletes files until --allow-delete', { skip: posixOnly }, () => {
  const s = sandbox();
  const gone = path.join(s.repo, 'other.txt');
  assert.ok(fs.existsSync(gone));
  s.run(['crew', '-i', '-g', 'del', task('exec:rm other.txt;append:app.txt:kept;answer:SUMMARY: removed a file')]);
  assert.equal(s.run(['wait', '-g', 'del', '--timeout', '30']).status, 0);
  const id = /run (\S+)/.exec(s.run(['status', '-g', 'del']).stdout)?.[1] ?? s.run(['ls', '-g', 'del']).stdout.match(/\d{8}-\d{6}-[0-9a-f]{4}/)[0];

  const refused = s.run(['apply', '-g', 'del']);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /deletes 1 file/);
  assert.match(refused.stdout, /other\.txt/);
  assert.match(refused.stdout, /--allow-delete/);
  assert.ok(fs.existsSync(gone), 'nothing was applied, the file is still there');
  assert.doesNotMatch(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /kept/, 'the rest of the patch was not applied either');

  const single = s.run(['apply', id]);
  assert.equal(single.status, 3, single.stdout + single.stderr);
  assert.match(single.stderr, /deletes 1 file.*other\.txt/s);
  assert.ok(fs.existsSync(gone));

  const allowed = s.run(['apply', '--allow-delete', id]);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.ok(!fs.existsSync(gone), 'deleted only with the flag');
  assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /kept/);
});

test('maxParallel defaults to 20 and no setting goes above 30', () => {
  const s = sandbox();
  const value = (env) => JSON.parse(s.run(['config', '--json'], env).stdout ?? '{}');
  assert.match(s.run(['config']).stdout, /maxParallel\s+20\s+\(default\)/);
  assert.match(s.run(['config'], { PITROOM_MAX_PARALLEL: '99' }).stdout, /maxParallel\s+30\s+\(env\)/);
  assert.match(s.run(['config'], { PITROOM_MAX_PARALLEL: '12' }).stdout, /maxParallel\s+12\s+\(env\)/);
  void value;
});

test('stop: a worker process that dies on the signal before it can answer is stopped, not "exited unexpectedly"', () => {
  const s = sandbox();
  const fake = (id, extra) => {
    const dir = path.join(s.base, 'home', 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id, version: '0', mode: 'read', task: 'x', dir: s.repo, cwd: s.repo, worker: { backend: 'opencode' }, fallback: [], files: [], link: [],
      timeoutSec: 60, state: 'queued', pid: 2 ** 22 + 7, startedAt: new Date().toISOString(), warnings: [], ...extra,
    }));
  };
  fake('20260101-000001-aaaa', { stopRequested: true }); // asked to stop, and its process is gone
  fake('20260101-000002-bbbb', {}); // gone without anyone asking: a crash
  assert.match(s.run(['status', '20260101-000001-aaaa']).stdout, /stopped/);
  assert.doesNotMatch(s.run(['status', '20260101-000001-aaaa']).stdout, /exited unexpectedly/);
  assert.match(s.run(['status', '20260101-000002-bbbb']).stdout, /exited unexpectedly/);
});
