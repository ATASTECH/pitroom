// The reference check: which file a `path:line` in an answer means when it is not written as the project has it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { extractRefs, verifyRefs } from '../dist/lib.mjs';
import { scratchDir } from './helpers.mjs';

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
function project(files) {
  const dir = scratchDir('pitroom-refs-');
  for (const [f, n] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), lines(n));
  }
  return dir;
}
const check = (dir, text) => verifyRefs(extractRefs(text), [dir]);

test('refs: a folder left out of the path still finds the file, when the folders written appear in order', () => {
  const dir = project({ 'packages/api-contracts/src/integrations.ts': 30 });
  assert.equal(check(dir, 'see api-contracts/integrations.ts:14').valid, 1);
  assert.equal(check(dir, 'see packages/integrations.ts:14').valid, 1);
  const reversed = check(dir, 'see src/api-contracts/integrations.ts:14');
  assert.deepEqual(reversed.invalid, [{ ref: 'src/api-contracts/integrations.ts:14', reason: 'file not found' }], 'folders out of order');
  assert.equal(check(dir, 'see contracts/integrations.ts:14').valid, 0, 'a folder name must match whole');
  assert.deepEqual(check(dir, 'see api-contracts/integrations.ts:99').invalid, [{ ref: 'api-contracts/integrations.ts:99', reason: 'file has 30 lines' }], 'and its lines are still checked');
});

test('refs: a file of a dependency or of the build output is found there, only when the project has none of that name', () => {
  const dep = 'node_modules/.pnpm/sdk@1.0.0/node_modules/sdk/dist/esm/client/streamableHttp.d.ts';
  const dir = project({ [dep]: 80, 'src/main.ts': 10, 'dist/main.js': 50 });
  assert.equal(check(dir, 'see streamableHttp.d.ts:73').valid, 1);
  assert.equal(check(dir, 'see dist/esm/client/streamableHttp.d.ts:73').valid, 1);
  assert.deepEqual(check(dir, 'see streamableHttp.d.ts:500').invalid, [{ ref: 'streamableHttp.d.ts:500', reason: 'file has 80 lines' }]);
  // the project's own main.ts is the one meant; its build output is not tried in its place
  assert.deepEqual(check(dir, 'see main.ts:40').invalid, [{ ref: 'main.ts:40', reason: 'file has 10 lines' }]);
  assert.equal(check(dir, 'see main.js:40').valid, 1, 'a name only the build output has is found there');
  assert.deepEqual(check(dir, 'see nowhere.ts:1').invalid, [{ ref: 'nowhere.ts:1', reason: 'file not found' }]);
  assert.equal(check(dir, 'see Schema.parse:432').total, 0, 'a method call that looks like a file is not a reference');
});
