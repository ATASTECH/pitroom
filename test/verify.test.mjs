// --verify: a command run after the worker; a failure is never shown as plain success.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const ANSWER = { MOCK_ACTIONS: 'answer:SUMMARY: ok' };

test('verify: a failing command makes the run "⚠ done · verify failed" with exit 6; a missing one says so', () => {
  const s = sandbox();
  const ok = s.run(['run', '--verify', 'true', 'q1'], ANSWER);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /pitroom ✔ done/);
  assert.match(ok.stdout, /── verify: `true` ✔ passed/);
  const bad = s.run(['run', '--verify', 'false', 'q2'], ANSWER);
  assert.equal(bad.status, 6);
  assert.match(bad.stdout, /pitroom ⚠ done · verify failed/);
  assert.match(bad.stdout, /── verify: `false` ✘ failed \(exit 1\)/);
  const missing = s.run(['run', '--verify', 'no-such-command-xyz', 'q3'], ANSWER);
  assert.equal(missing.status, 6);
  assert.match(missing.stdout, /✘ could not run \(exit 127: command not found\)/);
  assert.match(missing.stdout, /not on the PATH Pitroom runs with/);
});

test('verify: with a bare PATH (as an app may start Pitroom) node and npm next to the running Node are still found', () => {
  const s = sandbox();
  const r = s.run(['run', '--verify', 'node -e "process.exit(0)" && npm --version', 'q'], { ...ANSWER, PATH: '/usr/bin:/bin' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /── verify: .* ✔ passed/);
});
