// Plan work end to end: run --plan --step, reviews of plan tasks, plan status and notes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const runId = (r) => /run (\S+)/.exec(r.stdout)?.[1];
const meta = (s, id) => JSON.parse(s.run(['show', id, '--json']).stdout);
const lastPrompt = (s) => s.calls().filter((c) => c.argv[0] === 'run').at(-1).argv.at(-1);
const APPROVED = 'answer:SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0';

const PLAN = `# Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use pitroom-driven-development.

**Goal:** Two more lines in app.txt.

## Global Constraints

- Keep app.txt lines lowercase

---

### Task 1: First line

**Worker:** cheap

Append "one" to app.txt. [[mock:append:app.txt:one;answer:STATUS: DONE\\nSUMMARY: added one]]

### Task 2: Second line

Append "two" to app.txt. [[mock:answer:STATUS: BLOCKED\\nSUMMARY: cannot]]
`;

function planSandbox() {
  const s = sandbox();
  const plan = path.join(s.base, 'demo-plan.md');
  fs.writeFileSync(plan, PLAN);
  return { ...s, plan };
}

test('run --plan --step: one task, the constraints and the implementer rules, on the task tier', () => {
  const s = planSandbox();
  s.config({ tiers: { cheap: 'opencode:mock/cheap' } });
  const r = s.run(['run', '-i', '--plan', s.plan, '--step', '1', 'Use the helper from task 0.']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const prompt = lastPrompt(s);
  assert.match(prompt, /You are implementing Task 1: First line/);
  assert.match(prompt, /Keep app\.txt lines lowercase/);
  assert.match(prompt, /Append "one"/);
  assert.doesNotMatch(prompt, /Append "two"/);
  assert.match(prompt, /Use the helper from task 0\./);
  assert.match(prompt, /You never commit/);
  const call = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'mock/cheap', '**Worker:** cheap picks the tier');
  assert.match(r.stdout, /plan: demo-plan · Task 1: First line · STATUS DONE/);
  const id = runId(r);
  const m = meta(s, id);
  assert.deepEqual(m.plan, { file: fs.realpathSync(s.plan), step: 1, title: 'First line' });
  assert.equal(m.group, 'demo-plan');
  assert.equal(m.taskStatus, 'DONE');
  assert.match(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'brief.md'), 'utf8'), /### Task 1: First line/);
});

test('plan runs: read mode, unknown tasks and --plan without --step are refused; follow-ups keep the plan', () => {
  const s = planSandbox();
  assert.match(s.run(['run', '--plan', s.plan, '--step', '1']).stderr, /add -i/);
  const miss = s.run(['run', '-i', '--plan', s.plan, '--step', '3']);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr, /no Task 3 in .*; it has Task 1, Task 2/);
  assert.equal(s.run(['run', '-i', '--plan', path.join(s.base, 'nope.md'), '--step', '1']).status, 2);
  assert.match(s.run(['run', '-i', '--plan', s.plan]).stderr, /--plan and --step go together/);
  assert.match(s.run(['crew', '-i', '--plan', s.plan, 'x']).stderr, /pitroom run -i --plan/);
  const b = s.run(['run', '-i', '--plan', s.plan, '--step', '2']);
  assert.match(b.stdout, /STATUS BLOCKED/);
  const c = s.run(['run', '--continue', runId(b), 'Here is the context you need.'], {
    MOCK_ACTIONS: 'append:app.txt:two;answer:STATUS: DONE\\nSUMMARY: added two',
  });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /plan: demo-plan · Task 2: Second line · STATUS DONE/);
  assert.match(s.run(['run', '--continue', runId(b), '--plan', s.plan, '--step', '2', 'x']).stderr, /drop --plan\/--step/);
});

test("a plan task's review gets the plan brief and stays with the task", () => {
  const s = planSandbox();
  const impl = runId(s.run(['run', '-i', '--plan', s.plan, '--step', '1']));
  const r = s.run(['review', impl], { MOCK_ACTIONS: APPROVED });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rid = runId(r);
  const pkg = fs.readFileSync(path.join(s.base, 'home', 'runs', rid, 'package.md'), 'utf8');
  assert.match(pkg, /^# Review package · Task 1: First line/);
  assert.match(pkg, /## BRIEF\n\n# Demo Implementation Plan[\s\S]*Keep app\.txt lines lowercase[\s\S]*### Task 1: First line/);
  assert.equal(meta(s, rid).plan.step, 1);
  assert.equal(meta(s, rid).group, 'demo-plan');
});

test('plan status rebuilds progress from runs and notes; notes stay outside the project', () => {
  const s = planSandbox();
  const impl = runId(s.run(['run', '-i', '--plan', s.plan, '--step', '1']));
  s.run(['review', impl], { MOCK_ACTIONS: 'answer:SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=1' });
  assert.equal(s.run(['apply', impl]).status, 0);
  assert.equal(s.run(['plan', 'note', s.plan, 'Task 1: complete (aaaaaaa..bbbbbbb)']).status, 0);
  assert.equal(s.run(['plan', 'note', s.plan, 'Task 2: Ruling: skip the renderer — out of scope — costs a follow-up']).status, 0);
  const st = s.run(['plan', 'status', s.plan]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^1\s+done\s+DONE\s+pass\/approved \(c0 i0 m1\)\s+0\s+yes\s+First line\s+Task 1: complete/m);
  assert.match(st.stdout, /^2\s+-\s+-\s+-\s+-\s+-\s+Second line/m);
  assert.match(st.stdout, /Rulings:\n\s+\d{4}-\d\d-\d\d \d\d:\d\d Task 2: Ruling: skip the renderer/);
  const j = JSON.parse(s.run(['plan', 'status', s.plan, '--json']).stdout);
  assert.equal(j.tasks[0].applied, true);
  assert.equal(j.tasks[0].review.verdict.minor, 1);
  assert.equal(j.tasks[1].runs, 0);
  assert.ok(j.notesFile.startsWith(path.join(s.base, 'home')), 'notes live in the Pitroom home, not the project');
  assert.equal(s.run(['plan', 'status']).status, 2);
  assert.equal(s.run(['plan', 'frob', s.plan]).status, 2);
});

test('review --range --plan adds the plan and the notes from execution', () => {
  const s = planSandbox();
  s.git('add', '-A');
  s.git('commit', '-qm', 'wip');
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'one\n');
  s.git('commit', '-qam', 'feat: one');
  s.run(['plan', 'note', s.plan, 'Task 1: minor (deferred): name the constant']);
  const r = s.run(['review', '--range', 'HEAD~1..HEAD', '--plan', s.plan], { MOCK_ACTIONS: APPROVED });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pkg = fs.readFileSync(path.join(s.base, 'home', 'runs', runId(r), 'package.md'), 'utf8');
  assert.match(pkg, /## WHAT WAS IMPLEMENTED\n\nDemo Implementation Plan/);
  assert.match(pkg, /Keep app\.txt lines lowercase/);
  assert.match(pkg, /- Task 2: Second line/);
  assert.match(pkg, /## NOTES FROM EXECUTION\n\n- Task 1: minor \(deferred\): name the constant/);
  assert.match(s.run(['review', 'latest', '--plan', s.plan]).stderr, /--plan goes with --range/);
});
