// `pitroom review`: the package, the reviewer's backend, scoped re-reviews, ranges, refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { root, sandbox } from './helpers.mjs';

const runId = (r) => /run (\S+)/.exec(r.stdout)?.[1];
const pkgOf = (s, id) => fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'package.md'), 'utf8');
const meta = (s, id) => JSON.parse(s.run(['show', id, '--json']).stdout);
const lastPrompt = (s) => s.calls().filter((c) => c.argv[0] === 'run').at(-1).argv.at(-1);
const verdict = (spec, quality, c, i, m) => `answer:SUMMARY: SPEC: ${spec} · QUALITY: ${quality} · ISSUES: critical=${c} important=${i} minor=${m}`;
const CLAUDE = path.join(root, 'test', 'fixtures', 'claude', 'mock', 'claude.mjs');

test('review <run>: one package (brief, report, diff) for a read-only reviewer on another worker', () => {
  const s = sandbox();
  s.config({ tiers: { standard: 'claude' }, fallback: ['opencode:mock/alive'] });
  const impl = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const r = s.run(['review', impl], {
    PITROOM_CLAUDE_BIN: CLAUDE,
    MOCK_ACTIONS: `${verdict('PASS', 'NEEDS_FIXES', 0, 1, 2)}\nDETAILS: app.txt:2 needs a test`,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const claude = s.calls().filter((c) => c.backend === 'claude');
  assert.equal(claude.length, 1, 'the reviewer was tried on Claude Code first: another backend than the implementer');
  const tools = claude[0].argv[claude[0].argv.indexOf('--tools') + 1];
  assert.deepEqual(tools.split(',').sort(), ['Glob', 'Grep', 'Read'], 'read-only tools');
  const oc = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
  assert.equal(oc.argv[oc.argv.indexOf('--agent') + 1], 'pitroom-read');
  const prompt = oc.argv.at(-1);
  assert.match(prompt, /You are reviewing one task's implementation/);
  const copy = /(\S+\/\.git\/pitroom\/review-[0-9a-f]+\.md)/.exec(prompt)?.[1];
  assert.ok(copy, 'the prompt names the package file');
  assert.ok(!fs.existsSync(copy), 'the package copy is removed when the review ends');
  assert.equal(fs.realpathSync(oc.cwd), fs.realpathSync(meta(s, impl).cwd), 'the reviewer works in the isolated copy');
  const rid = runId(r);
  const pkg = pkgOf(s, rid);
  assert.match(pkg, /## BRIEF\n\nadd one/);
  assert.match(pkg, /## REPORT\n\nSUMMARY: added one/);
  assert.match(pkg, /## DIFF\n\n[\s\S]*^\+one$/m);
  assert.match(r.stdout, new RegExp(`review of ${impl} \\(task\\) · SPEC PASS · QUALITY NEEDS-FIXES · critical 0 · important 1 · minor 2`));
  assert.deepEqual(meta(s, rid).verdict, { spec: 'pass', quality: 'needs-fixes', critical: 0, important: 1, minor: 2 });
  assert.equal(meta(s, rid).reviewKind, 'task');
  assert.match(s.run(['show', impl]).stdout, new RegExp(`review:\\s+pitroom review ${impl}`));
});

test('review warns when the reviewer falls back to the implementer backend', () => {
  const s = sandbox();
  s.config({ tiers: { standard: 'opencode:mock/a', capable: 'opencode:mock/b' }, fallback: ['opencode:mock/c'] });
  const impl = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const r = s.run(['review', impl], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 0) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /reviewer runs on the same backend as the implementer \(opencode\); configure tiers "standard" or "capable" for a second model/);
  const named = s.run(['review', impl, '-W', 'opencode:mock/a'], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 0) });
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.doesNotMatch(named.stdout, /reviewer runs on the same backend/);
});

test('review of a follow-up is a scoped re-review: previous findings, fix report, only the fix diff', () => {
  const s = sandbox();
  const impl = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const first = s.run(['review', impl], { MOCK_ACTIONS: `${verdict('FAIL', 'NEEDS_FIXES', 0, 1, 0)}\nDETAILS: FINDING-XYZ two is missing` });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const fix = runId(s.run(['run', '--continue', impl, 'FINDING-XYZ'], { MOCK_ACTIONS: 'append:app.txt:two;answer:SUMMARY: added two' }));
  const re = s.run(['review', fix], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 0) });
  assert.equal(re.status, 0, re.stdout + re.stderr);
  assert.match(lastPrompt(s), /You are re-reviewing one task's fix round/);
  const pkg = pkgOf(s, runId(re));
  assert.match(pkg, /## PREVIOUS FINDINGS\n\n[\s\S]*FINDING-XYZ/);
  assert.match(pkg, /## FIX REPORT\n\nSUMMARY: added two/);
  const fixDiff = pkg.split('## FIX DIFF')[1];
  assert.match(fixDiff, /^\+two$/m);
  assert.doesNotMatch(fixDiff, /^\+one$/m, 'only this round, not the whole task');
  assert.match(re.stdout, new RegExp(`review of ${fix} \\(fix\\) · SPEC PASS · QUALITY APPROVED`));
});

test('review of a second follow-up shows every round since the reviewed one', () => {
  const s = sandbox();
  const impl = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const first = s.run(['review', impl], { MOCK_ACTIONS: `${verdict('FAIL', 'NEEDS_FIXES', 0, 1, 0)}\nDETAILS: FINDING-XYZ two and three are missing` });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // The intermediate round is deliberately not reviewed.
  const mid = runId(s.run(['run', '--continue', impl, 'add two'], { MOCK_ACTIONS: 'append:app.txt:two;answer:SUMMARY: added two' }));
  const fix = runId(s.run(['run', '--continue', mid, 'add three'], { MOCK_ACTIONS: 'append:app.txt:three;answer:SUMMARY: added three' }));
  const re = s.run(['review', fix], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 0) });
  assert.equal(re.status, 0, re.stdout + re.stderr);
  assert.match(lastPrompt(s), /You are re-reviewing one task's fix round/);
  const pkg = pkgOf(s, runId(re));
  assert.match(pkg, /## PREVIOUS FINDINGS\n\n[\s\S]*FINDING-XYZ/);
  const fixDiff = pkg.split('## FIX DIFF')[1];
  assert.match(fixDiff, /^\+two$/m, 'the skipped round is still shown');
  assert.match(fixDiff, /^\+three$/m);
  assert.doesNotMatch(fixDiff, /^\+one$/m, 'nothing from before the reviewed run');
  assert.match(re.stdout, new RegExp(`review of ${fix} \\(fix\\) · SPEC PASS · QUALITY APPROVED`));
});

test('review --range: commits, stat and diff for the whole-branch rubric', () => {
  const s = sandbox();
  s.git('add', '-A');
  s.git('commit', '-qm', 'wip');
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'line2\n');
  s.git('commit', '-qam', 'feat: line2');
  const r = s.run(['review', '--range', 'HEAD~1..HEAD'], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 1) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pkg = pkgOf(s, runId(r));
  assert.match(pkg, /## COMMITS\n\n\w+ feat: line2/);
  assert.doesNotMatch(pkg, /\bwip\b/);
  assert.match(pkg, /^\+line2$/m);
  assert.match(lastPrompt(s), /You are a senior code reviewer/);
  assert.match(r.stdout, /review of HEAD~1\.\.HEAD \(range\) · SPEC PASS · QUALITY APPROVED · critical 0 · important 0 · minor 1/);
});

test('review refuses what it cannot review', () => {
  const s = sandbox();
  const read = runId(s.run(['run', 'just a question']));
  assert.match(s.run(['review', read]).stderr, /was read-only; there is no change to review/);
  const none = runId(s.run(['run', '-i', 'change nothing [[mock:answer:SUMMARY: nothing to do]]']));
  const n = s.run(['review', none]);
  assert.equal(n.status, 2);
  assert.match(n.stderr, /made no changes/);
  assert.equal(s.run(['review', '--range', 'nope..HEAD']).status, 2);
  assert.equal(s.run(['review', '--range', 'HEAD']).status, 2);
  assert.equal(s.run(['review', '-i', none]).status, 2);
  const bg = runId(s.run(['run', '-i', '--bg', 'slow [[mock:sleep:5;append:app.txt:x;answer:SUMMARY: late]]']));
  const busy = s.run(['review', bg]);
  assert.equal(busy.status, 3);
  assert.match(busy.stderr, /still (queued|running); pitroom wait/);
  s.run(['stop', bg]);
});

test('a configured review tier picks the reviewer of a run and needs no same-backend warning', () => {
  const s = sandbox();
  s.config({ tiers: { review: 'opencode:mock/reviewer' } });
  const id = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const r = s.run(['review', id], { MOCK_ACTIONS: verdict('PASS', 'APPROVED', 0, 0, 0) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const last = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
  assert.equal(last.argv[last.argv.indexOf('--model') + 1], 'mock/reviewer');
  assert.doesNotMatch(r.stdout, /same backend as the implementer/, 'a review tier is the user\'s own choice');
});
