// Implementation plans: tasks by heading, context, constraints, tiers and briefs (via dist/lib.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { brief, loadPlan, parsePlan, planName, planTask } from '../dist/lib.mjs';
import { scratchDir } from './helpers.mjs';

const PLAN = `# Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use pitroom-driven-development.

**Goal:** Add widgets.

**Spec:** docs/pitroom/specs/widgets.md

## Global Constraints

- Node 18+
- No new dependencies

---

### Task 1: Parser

**Worker:** cheap

\`\`\`\`markdown
### Task 7: inside a four-backtick fence
\`\`\`js
### Task 8: inside a nested fence
\`\`\`
\`\`\`\`

- [ ] **Step 1: Write the failing test**

### Task 2: Renderer

**Worker:** Capable

Body of two.

---

### Task 10: Docs

Ten.

## Final notes

Not part of task 10.
`;

test('plan: tasks by heading, ignoring headings inside fences', () => {
  const plan = parsePlan(PLAN, '/p/widgets.md');
  assert.equal(plan.title, 'Widget Implementation Plan');
  assert.deepEqual(plan.tasks.map((t) => [t.step, t.title]), [[1, 'Parser'], [2, 'Renderer'], [10, 'Docs']]);
  assert.match(planTask(plan, 1).text, /Task 7: inside a four-backtick fence/);
  assert.match(planTask(plan, 1).text, /Step 1: Write the failing test/);
  assert.doesNotMatch(planTask(plan, 1).text, /Body of two/);
  assert.doesNotMatch(planTask(plan, 2).text, /^---$/m, 'a trailing rule is not part of the task');
  assert.equal(planTask(plan, 10).text, '### Task 10: Docs\n\nTen.');
});

test('plan: header, global constraints and worker tiers', () => {
  const plan = parsePlan(PLAN, '/p/widgets.md');
  assert.match(plan.header, /\*\*Goal:\*\* Add widgets\./);
  assert.match(plan.header, /\*\*Spec:\*\* docs\/pitroom\/specs\/widgets\.md/);
  assert.doesNotMatch(plan.header, /For agentic workers/);
  assert.equal(plan.constraints, '- Node 18+\n- No new dependencies');
  assert.deepEqual(plan.tasks.map((t) => t.tier), ['cheap', 'capable', undefined]);
});

test('plan: Task 1 is not Task 10; a missing task lists the ones that exist', () => {
  const plan = parsePlan(PLAN, '/p/widgets.md');
  assert.equal(planTask(plan, 1).title, 'Parser');
  assert.throws(() => planTask(plan, 3), /no Task 3 in \/p\/widgets\.md; it has Task 1, Task 2, Task 10/);
});

test('plan: the brief carries the context, the constraints and exactly one task', () => {
  const plan = parsePlan(PLAN, '/p/widgets.md');
  const b = brief(plan, planTask(plan, 2));
  assert.match(b, /^# Widget Implementation Plan\n/);
  assert.match(b, /\*\*Goal:\*\* Add widgets\./);
  assert.match(b, /## Global Constraints\n\n- Node 18\+\n- No new dependencies/);
  assert.match(b, /### Task 2: Renderer/);
  assert.doesNotMatch(b, /Task 1: Parser|Task 10: Docs/);
  const bare = parsePlan('# Tiny\n\n### Task 1: Only\n\nDo it.\n', '/p/tiny.md');
  assert.match(brief(bare, planTask(bare, 1)), /## Global Constraints\n\n\(none stated in the plan\)/);
  assert.equal(planName('/p/2026-09-30-widgets.md'), '2026-09-30-widgets');
});

test('plan: a Worker line inside a fence is an example, not the task tier', () => {
  const plan = parsePlan([
    '# P', '', '### Task 1: A', '', '```markdown', '**Worker:** capable', '```', '', '**Worker:** cheap', '',
    '### Task 2: B', '', '````', '**Worker:** capable', '````', '',
  ].join('\n'));
  assert.equal(planTask(plan, 1).tier, 'cheap');
  assert.equal(planTask(plan, 2).tier, undefined);
});

test('loadPlan: the real path, a missing file and a plan without tasks', () => {
  const dir = scratchDir('pitroom-plan-');
  try {
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, PLAN);
    fs.symlinkSync(file, path.join(dir, 'link.md'));
    assert.equal(loadPlan(path.join(dir, 'link.md')).file, fs.realpathSync(file));
    assert.throws(() => loadPlan(path.join(dir, 'nope.md')), /plan not found/);
    fs.writeFileSync(path.join(dir, 'empty.md'), '# Nothing\n\nNo tasks here.\n');
    assert.throws(() => loadPlan(path.join(dir, 'empty.md')), /has no "Task N" headings/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
