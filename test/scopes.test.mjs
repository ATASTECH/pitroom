// `pitroom crew --over`: one task, once per part of the project, each worker kept to its own part.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expandScopes, scopedTask } from '../dist/lib.mjs';
import { sandbox, scratchDir } from './helpers.mjs';

function tree() {
  const dir = scratchDir('pitroom-scopes-');
  for (const d of ['src/auth', 'src/billing', 'src/uploads', 'src/.cache', 'docs']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '');
  return dir;
}

test('scopes: paths, comma lists and patterns, in order, hidden ones left out', () => {
  const dir = tree();
  assert.deepEqual(expandScopes(['src/auth,./src/billing/', 'docs'], dir), ['src/auth', 'src/billing', 'docs']);
  assert.deepEqual(expandScopes(['src/*'], dir), ['src/auth', 'src/billing', 'src/index.ts', 'src/uploads']);
  assert.deepEqual(expandScopes(['src/*/'], dir), ['src/auth', 'src/billing', 'src/uploads'], 'a trailing / keeps folders only');
  assert.deepEqual(expandScopes(['src/b*'], dir), ['src/billing']);
  assert.deepEqual(expandScopes(['.'], dir), ['.'], 'the whole project is one part');
});

test('scopes: parts that overlap, repeat, are missing or lie outside are refused', () => {
  const dir = tree();
  assert.throws(() => expandScopes(['src', 'src/auth'], dir), /src\/auth is inside src, so two workers would read the same files/);
  assert.throws(() => expandScopes(['src/*/', 'src/auth'], dir), /src\/auth twice/);
  assert.throws(() => expandScopes(['.', 'docs'], dir), /docs is inside \./);
  assert.throws(() => expandScopes(['src/nope'], dir), /no such file or folder/);
  assert.throws(() => expandScopes(['src/z*'], dir), /matches nothing/);
  assert.throws(() => expandScopes(['*/auth'], dir), /only the last part/);
  assert.throws(() => expandScopes(['..'], dir), /outside/);
  assert.throws(() => expandScopes([' , '], dir), /--over needs the parts/);
});

test('scopes: the task names its part and keeps the worker to it', () => {
  const read = scopedTask('Find unvalidated input in {scope}. file:line for each.', 'src/auth', 'read');
  assert.match(read, /^Find unvalidated input in src\/auth\. file:line for each\./);
  assert.match(read, /Your part of the project: src\/auth\. Read only inside it/);
  const edit = scopedTask('Fix the lint errors', 'src/billing', 'isolate');
  assert.match(edit, /Your part of the project: src\/billing\. Change only files inside it/);
});

test('crew --over starts one worker per part, with the part in its task', () => {
  const s = sandbox();
  const r = s.run(['crew', '--json', '-g', 'parts', '--over', 'app.txt,other.txt', 'Summarize {scope} [[mock:answer:SUMMARY: ok]]']);
  assert.equal(r.status, 0, r.stderr);
  const { runs } = JSON.parse(r.stdout);
  assert.deepEqual(runs.map((x) => x.task.split('\n')[0]), ['Summarize app.txt [[mock:answer:SUMMARY: ok]]', 'Summarize other.txt [[mock:answer:SUMMARY: ok]]']);
  assert.equal(s.run(['wait', '-g', 'parts', '--timeout', '30']).status, 0);
  const two = s.run(['crew', '--over', 'app.txt,other.txt', 'one', 'two']);
  assert.equal(two.status, 2);
  assert.match(two.stderr, /--over takes one task/);
  const overlap = s.run(['crew', '--over', '.,app.txt', 'x']);
  assert.equal(overlap.status, 2);
  assert.match(overlap.stderr, /app\.txt is inside \./);
});
