// --verify: a command run after the worker; a failure is never shown as plain success.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

// verifyFix: a change whose check fails goes back to its worker, in its own session, with the check's output.
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
const runFile = (s, id, f) => fs.readFileSync(path.join(s.base, 'home', 'runs', id, f), 'utf8');
const workerCalls = (s) => s.calls().filter((c) => c.argv[0] === 'run');
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
// passes once app.txt holds two "fix" lines: the mock adds one per turn
const TWO_FIXES = `node -e "const n = require('fs').readFileSync('app.txt', 'utf8').split('fix').length - 1; console.log('fix lines: ' + n); process.exit(n >= 2 ? 0 : 1)"`;
const APPEND = { MOCK_ACTIONS: 'append:app.txt:fix;answer:SUMMARY: added a fix line', MOCK_COST: '0.5' };

test('verify fix: a failed check goes back to the worker in its session, and a fix that passes makes the run done', () => {
  const s = sandbox();
  const r = s.run(['run', '-i', '--verify', TWO_FIXES, 'add a fix line to app.txt'], APPEND);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pitroom ✔ done/);
  assert.match(r.stdout, /── verify: .* ✔ passed after 1 fix round \(it failed first: exit 1\)/);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.verifyFix, 1);
  assert.equal(m.verifyRounds.length, 1);
  assert.equal(m.verifyRounds[0].code, 1);
  assert.match(m.verifyRounds[0].tail, /fix lines: 1/);

  // the fix round continues the worker's session, told what failed and how
  const [first, fix] = workerCalls(s);
  assert.ok(!first.argv.includes('--session'));
  assert.equal(fix.argv[fix.argv.indexOf('--session') + 1], 'ses_mock123');
  const prompt = fix.argv.at(-1);
  assert.match(prompt, /Pitroom ran the check the primary agent asked for, `node -e .*`, on your changes, and it failed \(exit 1\)/);
  assert.match(prompt, /fix lines: 1/);
  assert.match(prompt, /Do not weaken, skip or delete tests or the check itself/);
  assert.doesNotMatch(prompt, /You are a worker agent/);

  // one patch with both turns' edits; both turns' cost; both answers, and the steps of both
  assert.equal((fs.readFileSync(path.join(m.worktree, 'app.txt'), 'utf8').match(/fix/g) ?? []).length, 2);
  assert.match(runFile(s, m.id, 'changes.patch'), /\+fix\n\+fix/);
  assert.ok(m.priorUsage.steps > 0);
  assert.ok(m.usage.steps > m.priorUsage.steps);
  assert.ok(Math.abs(m.usage.cost - 0.5 * m.usage.steps) < 1e-9, `cost ${m.usage.cost} for ${m.usage.steps} steps`);
  assert.match(runFile(s, m.id, 'summary.md'), /SUMMARY: added a fix line\n\n── fix 1, after the check failed \(exit 1\):\n\nSUMMARY: added a fix line/);
  assert.ok(fs.existsSync(path.join(s.base, 'home', 'runs', m.id, 'verify.round-1.log')));
  // the history keeps the steps of every turn, with where the check sent the worker back
  assert.match(s.run(['history', 'went back to the worker']).stdout, new RegExp(m.id));
});

test('verify fix: rounds are capped; a check that never passes leaves the run "verify failed" after all of them', () => {
  const s = sandbox();
  const r = s.run(['run', '-i', '--verify', 'node -e "process.exit(3)"', '--verify-fix', '2', 'change app.txt'], APPEND);
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stdout, /pitroom ⚠ done · verify failed/);
  assert.match(r.stdout, /── verify: .* ✘ failed \(exit 3\), also after 2 fix rounds/);
  assert.equal(workerCalls(s).length, 3);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.deepEqual(m.verifyRounds.map((v) => v.code), [3, 3]);
  assert.match(workerCalls(s)[2].argv.at(-1), /\(no output\)/);
});

test('verify fix: none for a read run, with --verify-fix 0 or verifyFix 0, or when the check cannot run', () => {
  const s = sandbox();
  assert.equal(s.run(['run', '--verify', 'node -e "process.exit(1)"', 'q'], ANSWER).status, 6);
  assert.equal(s.run(['run', '-i', '--verify', 'node -e "process.exit(1)"', '--verify-fix', '0', 'change it'], APPEND).status, 6);
  s.config({ verifyFix: 0 });
  assert.equal(s.run(['run', '-i', '--verify', 'node -e "process.exit(1)"', 'change it'], APPEND).status, 6);
  s.config({});
  assert.equal(s.run(['run', '-i', '--verify', 'no-such-command-xyz', 'change it'], APPEND).status, 6);
  assert.equal(workerCalls(s).length, 4, 'one worker turn each');
  for (const id of fs.readdirSync(path.join(s.base, 'home', 'runs'))) assert.equal(meta(s, id).verifyRounds, undefined);
});

test('verify fix: a fix round that does not end well leaves the work before it, with a warning and the check run again', () => {
  const s = sandbox();
  const r = s.run(['run', '-i', '--verify', TWO_FIXES, 'add a fix line [[mock:append:app.txt:fix;answer:SUMMARY: one fix line]]'], { MOCK_ACTIONS: 'fail:provider exploded' });
  assert.equal(r.status, 6, r.stdout + r.stderr);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.state, 'done');
  assert.equal(m.error, undefined);
  assert.match(m.verifyRounds[0].fixFailed, /provider exploded/);
  assert.ok(m.warnings.some((w) => /^fix 1 after the failed check did not end well \(.*provider exploded.*\); the files hold what it changed before it stopped/.test(w)), m.warnings.join('\n'));
  assert.equal(m.verifyResult.ok, false);
  assert.match(runFile(s, m.id, 'summary.md'), /SUMMARY: one fix line\n\n── fix 1, after the check failed \(exit 1\):\n\n\(no written answer\)/);
  assert.deepEqual(m.changes.map((c) => c.path), ['app.txt']);
});

test('verify fix: --verify-fix takes 0 to 3 rounds and goes with --verify', () => {
  const s = sandbox();
  const lone = s.run(['run', '-i', '--verify-fix', '1', 'change it'], APPEND);
  assert.equal(lone.status, 2);
  assert.match(lone.stderr, /--verify-fix goes with --verify CMD/);
  const many = s.run(['run', '-i', '--verify', 'true', '--verify-fix', '9', 'change it'], APPEND);
  assert.equal(many.status, 2);
  assert.match(many.stderr, /--verify-fix takes a number of rounds from 0 to 3, not "9"/);
  assert.equal(workerCalls(s).length, 0);
});

test('a change to a file that runs commands by itself is named in the report; an ordinary change is not', () => {
  const s = sandbox();
  const hook = s.run(['run', '-i', 'add an MCP server'], { MOCK_ACTIONS: 'write:.mcp.json:{};write:lefthook.yml:x;answer:SUMMARY: added' });
  assert.equal(hook.status, 0, hook.stdout + hook.stderr);
  assert.match(hook.stdout, /the change touches configuration that runs commands by itself \(\.mcp\.json, lefthook\.yml\): check it before applying it/);
  const plain = s.run(['run', '-i', 'change app.txt'], { MOCK_ACTIONS: 'write:app.txt:x;answer:SUMMARY: changed' });
  assert.doesNotMatch(plain.stdout, /runs commands by itself/);
});
