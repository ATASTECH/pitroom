// --race N: the same change by N workers side by side; when all have ended the best one wins and the others' copies go.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
const GOOD = `node -e "process.exit(require('fs').readFileSync('app.txt', 'utf8').includes('good') ? 0 : 1)"`;
const BY_MODEL = {
  MOCK_ACTIONS_BY_MODEL: JSON.stringify({
    // a bigger change that passes the check beats a smaller one that does not
    'mock/a': 'append:app.txt:good;append:app.txt:extra;answer:SUMMARY: good change',
    'mock/b': 'append:app.txt:bad;answer:SUMMARY: small change',
  }),
  MOCK_FAIL_MODELS: 'mock/c',
};
const RACE = /pitroom race "(race-\d{6})": 3 workers, winner (\d{8}-\d{6}-[0-9a-f]{4}) \(opencode \(a\)\)/;

test('race: the racer whose check passed wins over a smaller diff and a failure; the losers\' copies go, their patches stay', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a', fallback: ['opencode:mock/b', 'opencode:mock/c'] });
  const r = s.run(['run', '-i', '--race', '3', '--no-fallback', '--verify', GOOD, '--verify-fix', '0', 'make app.txt good'], BY_MODEL);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [, group, winner] = RACE.exec(r.stdout) ?? assert.fail(r.stdout);
  assert.match(r.stderr, /3 workers make the same change, each in an isolated copy/);
  const rows = r.stdout.split('\n').filter((l) => /^ {3}\d\. /.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], new RegExp(`1\\. ${winner}  opencode \\(a\\) · verify passed · \\+2 −0 · free  ← winner`));
  assert.match(rows[1], /2\. \S+  opencode \(b\) · verify failed \(exit 1\) · \+1 −0 · free  \(copy discarded; the patch stays\)/);
  assert.match(rows[2], /3\. \S+  opencode \(c\) · failed: .*Model not found/);
  assert.match(r.stdout, new RegExp(`apply: {3}pitroom apply ${winner}`));
  assert.match(r.stdout, /pitroom ✔ done · isolate/, "the winner's report follows");

  const ids = rows.map((l) => /\d{8}-\d{6}-[0-9a-f]{4}/.exec(l)[0]);
  const [w, second, third] = ids.map((id) => meta(s, id));
  assert.deepEqual([w.racePlace, second.racePlace, third.racePlace], [1, 2, 3]);
  assert.ok(ids.every((id) => meta(s, id).group === group && meta(s, id).race === 3));
  assert.ok(!w.discarded && fs.existsSync(w.worktree));
  assert.ok(second.discarded && !fs.existsSync(second.worktree));
  assert.ok(third.discarded);
  assert.match(fs.readFileSync(path.join(s.base, 'home', 'runs', second.id, 'changes.patch'), 'utf8'), /\+bad/);
  assert.equal(s.status().includes('app.txt'), false, 'nothing reached the tree');

  // waiting on the group again names the same places, without settling twice
  const again = s.run(['wait', '-g', group]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, new RegExp(`winner ${winner}`));

  const applied = s.run(['apply', winner]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), /good\nextra/);
});

test('race: --bg starts the racers (-W races one worker against itself) and wait -g names the winner', async () => {
  const s = sandbox();
  const r = s.run(['run', '-i', '--race', '2', '--bg', '-W', 'opencode:mock/a', 'make app.txt good'], BY_MODEL);
  assert.equal(r.status, 0, r.stderr);
  const group = /pitroom race "(race-\d{6})"/.exec(r.stdout)[1];
  assert.match(r.stdout, new RegExp(`results: pitroom wait -g ${group} {3}\\(names the winner\\)`));
  const w = s.run(['wait', '-g', group]);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /2 workers, winner \S+ \(opencode \(a\)\)/);
  assert.equal(s.calls().filter((c) => c.argv[0] === 'run' && c.argv.includes('mock/a')).length, 2);
});

test('race: with no racer ending in a change there is no winner and nothing is discarded', () => {
  const s = sandbox();
  const r = s.run(['run', '-i', '--race', '2', '--no-fallback', '-W', 'opencode:mock/c', 'make app.txt good'], BY_MODEL);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /2 workers, no winner: no worker ended with a change/);
  for (const id of fs.readdirSync(path.join(s.base, 'home', 'runs'))) assert.equal(meta(s, id).discarded, undefined);
});

test('race: 2 to 5 workers, and only isolated changes race', () => {
  const s = sandbox();
  for (const [args, msg] of [
    [['-i', '--race', '1'], /--race takes how many workers race, 2 to 5, not "1"/],
    [['-i', '--race', '9'], /not "9"/],
    [['--race', '2'], /--race runs one change side by side in isolated copies: add -i/],
  ]) {
    const r = s.run(['run', ...args, 'task']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, msg);
  }
  assert.equal(s.calls().length, 0);
});
