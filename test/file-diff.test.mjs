import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { root, sandbox } from './helpers.mjs';

const source = fs.readFileSync(path.join(root, 'src/core/file-diff.ts'), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { fileDiffs } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const diffOf = (s) => {
  const fields = s.git('diff', '--name-status', '--no-renames', '-z', 'HEAD').split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  return fileDiffs(s.git('diff', '--binary', '--full-index', '--no-renames', 'HEAD'), changes);
};

test('file diff: real Git hunks keep both line numbers, quoted UTF-8 paths and newline markers', () => {
  const s = sandbox();
  const lines = Array.from({ length: 30 }, (_, i) => `const value${i} = ${i};`);
  fs.writeFileSync(path.join(s.repo, 'source.ts'), lines.join('\n'));
  s.git('add', '.');
  s.git('commit', '-qm', 'fixture');
  lines[1] = '++counter;';
  lines[28] = '--counter;';
  fs.writeFileSync(path.join(s.repo, 'source.ts'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(s.repo, 'çizim\t new.ts'), 'export const added = true;\n');
  s.git('add', '.');
  const diffs = diffOf(s);
  assert.equal(diffs.length, 2);
  const source = diffs.find((f) => f.path === 'source.ts');
  assert.equal(source.status, 'M');
  assert.equal(source.incomplete, false);
  assert.equal(source.additions, 3);
  assert.equal(source.deletions, 3);
  assert.equal(source.lines.filter((l) => l.type === 'hunk').length, 2);
  assert.ok(source.lines.some((l) => l.type === 'added' && l.newLine === 2 && l.content === '++counter;'));
  assert.ok(source.lines.some((l) => l.type === 'removed' && l.oldLine === 29 && l.content === 'const value28 = 28;'));
  assert.ok(source.lines.some((l) => l.type === 'meta' && l.content === '\\ No newline at end of file'));
  const added = diffs.find((f) => f.path === 'çizim\t new.ts');
  assert.equal(added.status, 'A');
  assert.equal(added.additions, 1);
  assert.equal(added.lines.find((l) => l.type === 'added').newLine, 1);
});

test('file diff: a large file is bounded without hiding later files or undercounting changes', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, 'a-large.ts'), Array.from({ length: 450 }, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(s.repo, 'z-last.ts'), 'export const last = true;\n');
  s.git('add', '.');
  const diffs = diffOf(s);
  const large = diffs.find((f) => f.path === 'a-large.ts');
  assert.equal(large.lines.length, 300);
  assert.equal(large.additions, 450);
  assert.equal(large.omittedLines, 152);
  assert.equal(large.incomplete, false);
  assert.equal(diffs.find((f) => f.path === 'z-last.ts').additions, 1);
});

test('file diff: binary, deleted, empty and mode-only changes remain distinct', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(s.repo, 'deleted.ts'), 'export const gone = true;\n');
  fs.writeFileSync(path.join(s.repo, 'mode.sh'), 'echo hello\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(s.repo, 'binary.dat'), Buffer.from([0, 1, 4, 5]));
  fs.unlinkSync(path.join(s.repo, 'deleted.ts'));
  fs.writeFileSync(path.join(s.repo, 'empty.ts'), '');
  fs.chmodSync(path.join(s.repo, 'mode.sh'), 0o755);
  s.git('add', '.');
  const diffs = diffOf(s);
  const binary = diffs.find((f) => f.path === 'binary.dat');
  assert.equal(binary.binary, true);
  assert.equal(binary.additions, undefined);
  assert.equal(binary.lines.length, 0, 'binary payloads are not code rows');
  const deleted = diffs.find((f) => f.path === 'deleted.ts');
  assert.equal(deleted.status, 'D');
  assert.equal(deleted.deletions, 1);
  assert.equal(deleted.lines.find((l) => l.type === 'removed').oldLine, 1);
  assert.equal(diffs.find((f) => f.path === 'empty.ts').additions, 0);
  assert.ok(diffs.find((f) => f.path === 'mode.sh').lines.some((l) => l.content === 'new mode 100755'));
});

test('file diff: a clipped archive never claims complete counts and keeps missing files visible', () => {
  const patch = ['diff --git a/first.ts b/first.ts', '--- a/first.ts', '+++ b/first.ts', '@@ -1 +1,3 @@', '-old', '+new'].join('\n');
  const diffs = fileDiffs(patch, [{ path: 'first.ts', status: 'M' }, { path: 'later.ts', status: 'A' }], true);
  assert.equal(diffs[0].incomplete, true);
  assert.equal(diffs[0].additions, undefined);
  assert.equal(diffs[0].deletions, undefined);
  assert.equal(diffs[1].unavailable, true);
  assert.equal(diffs[1].incomplete, true);
  assert.equal(diffs[1].path, 'later.ts');
  assert.equal(fileDiffs(patch, [])[0].incomplete, true, 'incomplete hunks are detected even without archive metadata');
});
