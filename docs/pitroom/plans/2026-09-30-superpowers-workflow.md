# Pitroom Workflow Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use pitroom-driven-development to implement this plan task-by-task (each task runs as `pitroom run -i --plan <this file> --step N` once Task 5 has landed). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pitroom ships the superpowers workflow as `pitroom-*` skills whose subagents are Pitroom workers, plus the CLI that makes it cheap: tiers, `run --plan --step`, `review`, `plan status|note`.

**Architecture:** Thin CLI additions in `src/core` (tiers in the worker chain, prompt templates stored in the skills, a plan parser, a review packager, plan status from run records) wired into the existing `run` lifecycle; then the skill pack, adapted from the vendored superpowers 6.3.0 sources, and the docs.

**Tech Stack:** TypeScript (strict, NodeNext), esbuild single-file bundle, `node:test` end-to-end tests against the built CLI with fake worker CLIs.

**Spec:** docs/pitroom/specs/2026-09-30-superpowers-workflow-design.md

## Global Constraints

- Node 18+ runtime, no new runtime dependencies; `dist/pitroom.mjs` stays one bundle built by `npm run build`.
- Run tests with a Node 18+ first on PATH (this machine's default `node` is v12): `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`; typecheck with `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck`.
- `npm test` rebuilds `dist/`; leave the rebuilt files in your change. Never hand-edit `dist/`.
- Match the surrounding code: 2-space indent, single quotes, `node:` imports, comments that say why, `UserError` for expected failures (exit 2 usage, exit 3 refused/setup).
- Workers never commit, push or touch git history. Never add flags or instructions that weaken a worker's safety.
- Skills: `skills/<name>/SKILL.md`, frontmatter `name` equals the folder, names are `pitroom-*` (plus `using-pitroom`), `description` starts with "Use". No `superpowers:`, `docs/superpowers` or `.superpowers/` text anywhere under `skills/`. No license or attribution notices in skill or template files (the README's Credits section is the only place).
- Specs live in `docs/pitroom/specs/`, plans in `docs/pitroom/plans/`.
- The SessionStart hook's injected context stays under 8192 characters.
- The superpowers sources to adapt are vendored read-only at `vendor/superpowers-skills/` (removed in Task 12).

## Setup (controller, before Task 1)

1. Branch: `git checkout -b feat/workflow-skills`.
2. Review diffs without the bundle: `printf 'dist/** -diff linguist-generated=true\n' > .gitattributes`, commit `chore: mark dist as generated`.
3. Vendor the sources: `cp -R ~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills vendor/superpowers-skills && cp ~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/LICENSE vendor/superpowers-skills/`, commit `chore: vendor superpowers 6.3.0 skills for adaptation`.
4. Workers need the build tools: start implementers with `--link node_modules` and `--verify "PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test"`.
5. Until Task 5 lands there is no `--plan`: extract a task with `awk -v n=N '/^```/{f=!f} !f && /^#+[ \t]+Task[ \t]+[0-9]+/{t=($0 ~ ("^#+[ \t]+Task[ \t]+" n "([^0-9]|$)"))} t' PLAN > "$TMPDIR/task-N.md"`, prepend the Global Constraints, and start it with `pitroom run -i --task-file`. Until Task 3 lands there is no `pitroom review`: copy the run's patch into `.git/pitroom/` and ask a read-only worker on another backend to review it.
6. After Task 1 lands, add tiers to the user config (`~/.config/pitroom/config.json`): `"tiers": {"cheap": "opencode", "standard": "codex", "capable": "claude"}`.

Tasks 1-6 share files and run in order. Tasks 8-11 touch disjoint skill folders and may run in parallel after Task 7. Task 12 runs last.

---

### Task 1: Worker tiers

**Worker:** cheap

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/chain.ts` (whole file)
- Modify: `src/core/run.ts` (`RunOptions`, `prepareRun`)
- Modify: `src/cli/args.ts`
- Modify: `src/core/doctor.ts`
- Modify: `src/cli.ts` (HELP)
- Test: `test/pitroom.test.mjs` (append)

**Interfaces:**
- Produces: config key `tiers: Record<string, string>`; `effective().tiers`; `resolveChain({ worker?, model?, tier?, noFallback? })`; `RunOptions.tier?: string`; CLI flag `--tier NAME`.

- [ ] **Step 1: Write the failing test** (append to `test/pitroom.test.mjs`)

```js
test('config "tiers" names workers: --tier picks one, -W wins, unknown tiers warn', () => {
  const s = sandbox();
  s.config({ tiers: { cheap: 'opencode:mock/cheap', capable: 'opencode:mock/capable' } });
  const modelOf = () => {
    const c = s.calls().filter((x) => x.argv[0] === 'run').at(-1);
    return c.argv.includes('--model') ? c.argv[c.argv.indexOf('--model') + 1] : 'default';
  };
  assert.equal(s.run(['run', '--tier', 'capable', 'x']).status, 0);
  assert.equal(modelOf(), 'mock/capable');
  assert.equal(s.run(['run', '--tier', 'capable', '-W', 'opencode:mock/explicit', 'y']).status, 0);
  assert.equal(modelOf(), 'mock/explicit', '-W wins over --tier');
  const r = s.run(['run', '--tier', 'nope', 'z']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(modelOf(), 'default');
  assert.match(r.stdout, /warning: tier "nope" is not configured/);
  assert.match(s.run(['config']).stdout, /tiers\s+cheap=opencode:mock\/cheap, capable=opencode:mock\/capable\s+\(config\)/);
  assert.match(s.run(['doctor']).stdout, /tiers: cheap=opencode:mock\/cheap, capable=opencode:mock\/capable/);
  const id = /run (\S+)/.exec(r.stdout)[1];
  const c = s.run(['run', '--continue', id, '--tier', 'cheap', 'more']);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /drop --worker\/--tier/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test --test-name-pattern='tiers' test/pitroom.test.mjs`
Expected: FAIL (`unknown option --tier`).

- [ ] **Step 3: Config key** — in `src/core/config.ts`:

After the `models?: Record<string, string>;` member of `PitroomConfig` add:

```ts
  /** Worker targets by tier, for --tier and plan tasks: {"cheap": "opencode", "capable": "claude"}. */
  tiers?: Record<string, string>;
```

In `SCHEMA` add `tiers: 'record',` after `models: 'record',`. In `effective()` add after the `models` line:

```ts
    tiers: setting<Record<string, string>>(undefined, undefined, c.tiers, {}),
```

- [ ] **Step 4: Tiers in the chain** — replace `src/core/chain.ts` with:

```ts
// The worker chain for a run: the preferred worker, then the fallbacks.
// The preferred worker is -W, else the config's tier named by --tier (config
// `tiers`, e.g. {"cheap": "opencode", "capable": "claude"}), else the config's
// `worker`. A target without a model gets the per-worker default from the
// config's `models` map (e.g. {"codex": "gpt-5.6-sol"}), else the worker CLI's
// own default. Shared by `run` (and so `review`) and `doctor`.
import { DEFAULT_BACKEND, getBackend } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { effective } from './config.js';
import { parseTarget } from './target.js';

export interface Chain {
  worker: Target;
  fallback: Target[];
  warnings: string[];
}

export function resolveChain(flags: { worker?: string; model?: string; tier?: string; noFallback?: boolean } = {}): Chain {
  const warnings: string[] = [];
  let spec = flags.worker;
  if (!spec && flags.tier) {
    spec = effective().tiers.value[flags.tier];
    if (!spec) warnings.push(`tier "${flags.tier}" is not configured (config "tiers"); using the default worker`);
  }
  const eff = effective({ worker: spec, model: flags.model });
  const models = eff.models.value;
  const withDefault = (t: Target): Target => (t.model || !models[t.backend] ? t : { ...t, model: models[t.backend] });

  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);

  const fallback: Target[] = [];
  if (!flags.noFallback) {
    for (const s of eff.fallback.value) {
      const t = withDefault(parseTarget(s, worker.backend));
      try {
        getBackend(t.backend);
        fallback.push(t);
      } catch (e) {
        warnings.push(`fallback ${s} skipped: ${(e as Error).message}`);
      }
    }
  }
  return { worker, fallback, warnings };
}
```

- [ ] **Step 5: Run options** — in `src/core/run.ts`, in `RunOptions` after `model?: string;` add:

```ts
  /** A worker from the config's "tiers"; -W wins. */
  tier?: string;
```

In `prepareRun`, replace

```ts
    if (o.worker) throw new UserError('a follow-up runs on the same worker as its parent; drop --worker');
```

with

```ts
    if (o.worker || o.tier) throw new UserError('a follow-up runs on the same worker as its parent; drop --worker/--tier');
```

and replace `resolveChain({ worker: o.worker, model: o.model, noFallback: o.noFallback })` with `resolveChain({ worker: o.worker, model: o.model, tier: o.tier, noFallback: o.noFallback })`.

In `src/cli/args.ts`: add `'--tier': 'tier',` to `VALUE_FLAGS` right after `'--worker': 'worker',`, and in `runOptions` add `tier: flag(p, 'tier'),` right after `model: flag(p, 'model'),`.

- [ ] **Step 6: Doctor checks the tier workers** — in `src/core/doctor.ts` change the config import to `import { configPath, effective, loadConfig } from './config.js';` and replace

```ts
  if (chain.length) add('ok', `worker chain: ${chain.map(describeTarget).join(' → ')}`);
  const byBackend = new Map<string, (string | undefined)[]>();
  for (const t of chain) byBackend.set(t.backend, [...(byBackend.get(t.backend) ?? []), t.model]);
```

with

```ts
  if (chain.length) add('ok', `worker chain: ${chain.map(describeTarget).join(' → ')}`);
  // Tier workers (config "tiers") are checked like the chain's.
  const tiers = Object.keys(effective().tiers.value);
  const tierTargets = tiers.map((name) => resolveChain({ tier: name, noFallback: true }).worker);
  if (tiers.length) add('ok', `tiers: ${tiers.map((name, i) => `${name}=${describeTarget(tierTargets[i]!)}`).join(', ')}`);
  const byBackend = new Map<string, (string | undefined)[]>();
  for (const t of [...chain, ...tierTargets]) byBackend.set(t.backend, [...(byBackend.get(t.backend) ?? []), t.model]);
```

- [ ] **Step 7: Help** — in `src/cli.ts` HELP, after the `-m, --model M` line add

```text
      --tier NAME       a worker from the config's "tiers" (e.g. cheap, standard, capable); -W wins
```

and change the last line to `Config: ~/.config/pitroom/config.json (worker, fallback, models, tiers, timeout, primary, price, link, web, maxParallel)`.

- [ ] **Step 8: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 9: Commit** (controller, after review)

```bash
git add src test dist && git commit -m "feat(config): worker tiers and --tier"
```

### Task 2: Prompt templates and answer lines

**Worker:** cheap

**Files:**
- Create: `src/core/templates.ts`, `src/core/answers.ts`
- Create: `skills/pitroom-driven-development/implementer-prompt.md`, `skills/pitroom-driven-development/task-reviewer-prompt.md`, `skills/pitroom-driven-development/re-review-prompt.md`, `skills/pitroom-review/code-reviewer.md`
- Modify: `src/lib.ts`
- Test: `test/templates.test.mjs`

**Interfaces:**
- Produces: `type TemplateName = 'implementer' | 'task-reviewer' | 're-review' | 'code-reviewer'`; `loadTemplate(name: TemplateName, root?: string): string`; `fill(template: string, values: Record<string, string>): string`; `type TaskStatus`; `parseStatus(text: string): TaskStatus`; `interface Verdict { spec: 'pass'|'fail'|'unknown'; quality: 'approved'|'needs-fixes'|'unknown'; critical: number; important: number; minor: number }`; `parseVerdict(text: string): Verdict`. Placeholders: implementer `{{PLAN_FILE}} {{STEP}} {{TITLE}} {{BRIEF}} {{NOTES}}`; the three reviewer templates `{{PACKAGE_FILE}}`.

- [ ] **Step 1: Write the failing test** — create `test/templates.test.mjs`:

```js
// Prompt templates shipped in the skills, and the structured lines of worker answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fill, loadTemplate, parseStatus, parseVerdict } from '../dist/lib.mjs';

const KEYS = {
  implementer: ['BRIEF', 'NOTES', 'PLAN_FILE', 'STEP', 'TITLE'],
  'task-reviewer': ['PACKAGE_FILE'],
  're-review': ['PACKAGE_FILE'],
  'code-reviewer': ['PACKAGE_FILE'],
};

test('templates: shipped in the skills, human header stripped, exactly the documented placeholders', () => {
  for (const [name, keys] of Object.entries(KEYS)) {
    const t = loadTemplate(name);
    assert.doesNotMatch(t, /^\s*<!--/, `${name}: header comment stripped`);
    assert.deepEqual([...new Set([...t.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort(), keys, name);
    assert.doesNotMatch(fill(t, Object.fromEntries(keys.map((k) => [k, `<${k}>`]))), /\{\{/, name);
  }
  assert.match(loadTemplate('implementer'), /STATUS: DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED/);
  for (const name of ['task-reviewer', 're-review', 'code-reviewer']) {
    assert.match(loadTemplate(name), /SUMMARY: SPEC: PASS\|FAIL · QUALITY: APPROVED\|NEEDS_FIXES · ISSUES: critical=N important=N minor=N/, name);
  }
});

test('fill: values are inserted literally and missing values are an error', () => {
  assert.equal(fill('a {{X}} b', { X: '$& {{Y}} $1' }), 'a $& {{Y}} $1 b');
  assert.throws(() => fill('{{X}} {{Y}}', { X: '1' }), /no value for template placeholder\(s\): Y/);
});

test('answers: STATUS line and review verdicts', () => {
  assert.equal(parseStatus('STATUS: DONE_WITH_CONCERNS\nSUMMARY: x'), 'DONE_WITH_CONCERNS');
  assert.equal(parseStatus('status: blocked'), 'BLOCKED');
  assert.equal(parseStatus('SUMMARY: done, no status line'), 'unknown');
  assert.equal(parseStatus('STATUS: FINISHED'), 'unknown');
  assert.deepEqual(parseVerdict('SUMMARY: SPEC: FAIL · QUALITY: NEEDS_FIXES · ISSUES: critical=1 important=2 minor=3'), {
    spec: 'fail', quality: 'needs-fixes', critical: 1, important: 2, minor: 3,
  });
  assert.deepEqual(parseVerdict('SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0'), {
    spec: 'pass', quality: 'approved', critical: 0, important: 0, minor: 0,
  });
  assert.deepEqual(parseVerdict('looks fine'), { spec: 'unknown', quality: 'unknown', critical: 0, important: 0, minor: 0 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/templates.test.mjs`
Expected: FAIL (`fill` is not exported).

- [ ] **Step 3: `src/core/answers.ts`**

```ts
// Structured lines in worker answers for plan work (see the templates in
// skills/pitroom-driven-development and skills/pitroom-review).

export const TASK_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number] | 'unknown';

/** The implementer's `STATUS:` line. */
export function parseStatus(text: string): TaskStatus {
  const value = /^\s*STATUS:\s*([A-Za-z_]+)/im.exec(text)?.[1]?.toUpperCase() ?? '';
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : 'unknown';
}

export interface Verdict {
  spec: 'pass' | 'fail' | 'unknown';
  quality: 'approved' | 'needs-fixes' | 'unknown';
  critical: number;
  important: number;
  minor: number;
}

/** A reviewer's `SPEC: … · QUALITY: … · ISSUES: …` summary line. */
export function parseVerdict(text: string): Verdict {
  const spec = /\bSPEC:\s*(PASS|FAIL)\b/i.exec(text)?.[1]?.toLowerCase();
  const quality = /\bQUALITY:\s*(APPROVED|NEEDS[_ -]?FIXES)\b/i.exec(text)?.[1]?.toUpperCase();
  const count = (k: string) => Number(new RegExp(`\\b${k}=(\\d+)`, 'i').exec(text)?.[1] ?? 0);
  return {
    spec: spec === 'pass' || spec === 'fail' ? spec : 'unknown',
    quality: quality === 'APPROVED' ? 'approved' : quality ? 'needs-fixes' : 'unknown',
    critical: count('critical'),
    important: count('important'),
    minor: count('minor'),
  };
}
```

- [ ] **Step 4: `src/core/templates.ts`**

```ts
// Prompt templates for plan work live inside the skills, so agents and the CLI
// read the same text: skills/<skill>/<name>.md with `{{NAME}}` placeholders and
// an optional leading <!-- comment --> for humans that is not sent to workers.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { packageRoot } from './install.js';

export type TemplateName = 'implementer' | 'task-reviewer' | 're-review' | 'code-reviewer';

const FILES: Record<TemplateName, string> = {
  implementer: 'pitroom-driven-development/implementer-prompt.md',
  'task-reviewer': 'pitroom-driven-development/task-reviewer-prompt.md',
  're-review': 'pitroom-driven-development/re-review-prompt.md',
  'code-reviewer': 'pitroom-review/code-reviewer.md',
};

export function loadTemplate(name: TemplateName, root = packageRoot()): string {
  const file = path.join(root, 'skills', FILES[name]);
  if (!fs.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs.readFileSync(file, 'utf8').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
}

/** Fills every `{{KEY}}`; values are inserted literally and never re-scanned. */
export function fill(template: string, values: Record<string, string>): string {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!).filter((k) => !(k in values));
  if (missing.length) throw new Error(`no value for template placeholder(s): ${[...new Set(missing)].join(', ')}`);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key]!);
}
```

- [ ] **Step 5: Export them** — append to `src/lib.ts`:

```ts
export { fill, loadTemplate } from './core/templates.js';
export { parseStatus, parseVerdict } from './core/answers.js';
```

- [ ] **Step 6: `skills/pitroom-driven-development/implementer-prompt.md`**

```markdown
<!--
Implementer brief for `pitroom run -i --plan PLAN --step N`. Pitroom fills the
placeholders and wraps the result in its worker contract (rules + answer format).
-->
You are implementing Task {{STEP}}: {{TITLE}} of the plan {{PLAN_FILE}}.

## Your brief

This is your requirements document, with the exact values to use verbatim. Other workers handle the plan's other tasks; do only this one.

<brief>
{{BRIEF}}
</brief>

## Notes from the primary agent

{{NOTES}}

## Your job

1. Implement exactly what the task specifies: nothing more (YAGNI), nothing less.
2. Write the tests the task specifies. When the task says to use TDD: write the failing test, run it and watch it fail for the expected reason, write the minimal code, run it and watch it pass.
3. While iterating, run the focused test for what you are changing; run the full relevant suite once before you answer.
4. Self-review (below), fix what you find, then answer.

The brief may contain commit steps. You never commit: skip them. The primary agent reviews your diff, applies it and commits.

## You work alone

Do all of this task's work yourself. Never delegate, never start other agents or `pitroom`, and never ask for a review: a reviewer on another model is already scheduled for your diff.

## Code organization

- Follow the file structure defined in the plan. Each file has one clear responsibility and a well-defined interface.
- If a file you create grows beyond the plan's intent, stop and answer DONE_WITH_CONCERNS; do not split files on your own.
- In existing code, follow the established patterns. Improve code you touch the way a good developer would; do not restructure anything outside your task.

## When you are in over your head

It is always fine to stop and say "this is too hard for me". Bad work is worse than no work. Answer BLOCKED or NEEDS_CONTEXT when:
- the task needs an architectural decision with several valid approaches,
- you need to understand code beyond what was provided and cannot find clarity,
- you are unsure your approach is correct,
- the task means restructuring code in ways the plan did not anticipate,
- you keep reading file after file without making progress.

Say specifically what you are stuck on, what you tried and what would unblock you. The primary agent can add context, give the task to a more capable worker, or split it.

## Self-review before answering

- Completeness: every requirement in the brief implemented? Edge cases?
- Quality: clear names (what things do, not how), clean and maintainable?
- Discipline: only what was requested, following the codebase's patterns?
- Testing: do the tests verify real behaviour, not mocks? Is the test output pristine (no warnings or noise)?

Fix what you find before answering.

## Answer

Start your answer with one status line:

STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

Then the usual answer format. In VERIFICATION give the commands you ran and their results; when the task required TDD add TDD EVIDENCE: the RED command with the relevant failing output (and why that failure was expected), then the GREEN command with the passing output. Put doubts about correctness (DONE_WITH_CONCERNS) and the specifics of BLOCKED or NEEDS_CONTEXT in OPEN ISSUES. Never silently hand over work you are unsure about.

## If you are resumed with review findings

Fix them, re-run the tests that cover the changed code, and answer again in the same format with a FIX REPORT in DETAILS: each finding, what you changed (file:line), the covering tests, the command and its output. Reviewers do not re-run tests; your answer is the evidence.
```

- [ ] **Step 7: `skills/pitroom-driven-development/task-reviewer-prompt.md`**

```markdown
<!--
Task review for `pitroom review <run>`. Pitroom writes the review package, fills
{{PACKAGE_FILE}} and runs this read-only, by default on another worker.
-->
You are reviewing one task's implementation: first whether it matches its requirements, then whether it is well built. This is a task-scoped gate, not a merge review; a whole-branch review happens after all tasks.

## What to read

One file holds everything; read it once: {{PACKAGE_FILE}}
It contains, in order:
1. BRIEF: what was requested (for a plan task: the plan's context, its global constraints and the task).
2. REPORT: what the implementer claims it built, with its test evidence.
3. DIFF: the change under review, with 10 lines of context.

Your working directory contains the code after this change. The diff's context lines are your view of the changed files: open a changed file only when a hunk you must judge is cut off mid-function, and say so. Do not crawl the codebase: look outside the diff only to check a concrete risk you can name (a changed contract, lock order, shared mutable state: then check its call sites), one focused check per named risk, and name both the risk and the check.

You are read-only: do not change files, the index, HEAD or branches.

## You work alone

Do the whole review yourself. Never delegate or start other agents. If the diff is large, review it in passes and say so.

## Do not trust the report

The report is unverified claims: verify them against the diff. Design rationales in the report ("kept it simple per YAGNI") are the implementer grading its own work; judge the code on its merits. A stated rationale never lowers a finding's severity.

## Tests

The implementer ran the tests and reported the results. Do not re-run the suite to confirm them. Run a test only when the code raises a specific doubt that no existing run answers, and then only a focused test. Warnings or noise in the reported test output are findings. If the evidence is missing or garbled in the package, report that as a gap; do not regenerate it.

## Part 1: Spec compliance

Compare the diff with the brief:
- Missing: requirements skipped, or claimed without being implemented.
- Extra: features that were not requested, over-engineering.
- Misunderstood: the right feature built the wrong way, or the wrong problem solved.

If the brief lists several files each with its own change, check that every listed file has its hunk; a listed file the diff never touches is Missing. A requirement you cannot verify from this diff (it lives in unchanged code or spans tasks) is a CANNOT VERIFY item, not a reason to search wider.

## Part 2: Code quality

- Separation of concerns, error handling, DRY without premature abstraction, edge cases.
- Tests verify real behaviour (not mocks) and cover the task's edge cases.
- Each file has one clear responsibility; the plan's file structure is followed; the change does not create files that are already large or grow existing files much (pre-existing size is not a finding).

Cite file:line for every finding, and for every check you would otherwise answer with a bare "yes".

## Calibration

Critical: breaks behaviour, loses data, security. Important: the task cannot be trusted until it is fixed (incorrect or fragile behaviour, a missed requirement, verbatim duplication of logic, swallowed errors, tests that assert nothing). Coverage that could be broader and polish are Minor. If the plan explicitly mandates something this rubric calls a defect, report it as Important and label it plan-mandated: the human decides. Say what was done well before listing issues.

## Answer

Your SUMMARY is exactly one line:
SUMMARY: SPEC: PASS|FAIL · QUALITY: APPROVED|NEEDS_FIXES · ISSUES: critical=N important=N minor=N

SPEC is FAIL when anything is Missing, Extra or Misunderstood. QUALITY is NEEDS_FIXES when there is any Critical or Important issue.

In DETAILS, in this order: SPEC FINDINGS (or "none"), CANNOT VERIFY (what the primary should check, or "none"), STRENGTHS, then CRITICAL, IMPORTANT and MINOR issues, each with file:line, what is wrong, why it matters and how to fix it if not obvious. No preamble and no closing summary.
```

- [ ] **Step 8: `skills/pitroom-driven-development/re-review-prompt.md`**

```markdown
<!--
Scoped re-review for `pitroom review <fix run>` (a follow-up of a run that was
already reviewed). Pitroom writes the package and fills {{PACKAGE_FILE}}.
-->
You are re-reviewing one task's fix round. A previous review produced findings; the implementer has attempted to fix them. Your job is a verdict on each finding and an inspection of the fix diff, nothing else.

## What to read

One file holds everything; read it once: {{PACKAGE_FILE}}
It contains, in order:
1. BRIEF: the task that was requested.
2. PREVIOUS FINDINGS: the previous review; its Critical and Important findings and spec gaps are under verification.
3. FIX REPORT: what the implementer says it changed, with the tests it re-ran.
4. FIX DIFF: only this fix round's changes, with 10 lines of context.

Your working directory contains the code after the fix. You are read-only: do not change files, the index, HEAD or branches.

## You work alone

Do the whole re-review yourself. Never delegate or start other agents.

## Scope

Your scope is the previous findings and the fix diff. Give a verdict on every Critical and Important finding and every spec gap. Inspect the fix diff for problems the fix itself introduced. Do not re-review code the fix did not touch: an issue entirely outside the fix diff goes under OUT OF SCOPE and does not block the task; a whole-branch review happens after all tasks.

## Tests

The fix report is unverified claims: check that it names the covering tests and shows their output, and verify its claims against the diff. Do not re-run the suite. Run a focused test only when the code raises a specific doubt that no existing run answers.

## Answer

Your SUMMARY is exactly one line:
SUMMARY: SPEC: PASS|FAIL · QUALITY: APPROVED|NEEDS_FIXES · ISSUES: critical=N important=N minor=N

SPEC is PASS only when every finding under verification is ADDRESSED. QUALITY is NEEDS_FIXES when the fix diff introduced any Critical or Important problem. ISSUES counts the findings still open plus the new problems, by severity.

In DETAILS, in this order:
- FINDING VERDICTS: for each finding, in order, the finding in one line, then ADDRESSED or NOT ADDRESSED with file:line evidence. "Attempted" is not addressed: the specific defect must no longer exist.
- NEW BREAKAGE: problems the fix introduced, with severity and file:line, or "none".
- OUT OF SCOPE: issues entirely outside the fix diff, or "none".
No preamble and no closing summary.
```

- [ ] **Step 9: `skills/pitroom-review/code-reviewer.md`**

```markdown
<!--
Whole-branch review for `pitroom review --range A..B [--plan PLAN]`. Pitroom
writes the package and fills {{PACKAGE_FILE}}.
-->
You are a senior code reviewer. Review completed work against its plan or requirements and find the issues before they cascade.

## What to read

One file holds everything; read it once: {{PACKAGE_FILE}}
It contains WHAT WAS IMPLEMENTED, REQUIREMENTS (the plan's goal, global constraints and tasks when there is a plan), NOTES FROM EXECUTION (rulings and deferred findings, when there are any), then the COMMITS, the FILES CHANGED and the DIFF with 10 lines of context.

The diff is your view of the change. Open other files in your working directory only to check a concrete risk you can name, and say what you checked. You are read-only: do not change files, the index, HEAD or branches, and do not check out other revisions.

## You work alone

Do the whole review yourself. Never delegate or start other agents. If the diff is large, review it in passes and say so.

## What to check

- Plan alignment: does the implementation match the plan or requirements? Are deviations justified improvements or problematic departures? Is all planned functionality present?
- Code quality: separation of concerns, error handling, type safety, DRY without premature abstraction, edge cases.
- Architecture: sound design, reasonable performance, security, clean integration with the surrounding code.
- Testing: tests verify real behaviour (not mocks), edge cases are covered, integration tests where they matter.
- Production readiness: migrations and backward compatibility where relevant, documentation, no obvious bugs.
- Notes from execution: for each deferred minor or parked finding, say whether it must be fixed before merge.

## Calibration

Critical: bugs, security issues, data loss, broken functionality. Important: architecture problems, missing features, poor error handling, test gaps. Minor: style, optimisations, documentation polish. Not everything is Critical. Say what was done well before listing issues. Flag significant deviations from the plan specifically, and say so when the problem is in the plan itself. Be specific (file:line, not vague), explain why each issue matters, never say "looks good" without checking, and never comment on code you did not read.

## Answer

Your SUMMARY is exactly one line:
SUMMARY: SPEC: PASS|FAIL · QUALITY: APPROVED|NEEDS_FIXES · ISSUES: critical=N important=N minor=N

SPEC is FAIL when planned functionality is missing or the implementation departs from the requirements. QUALITY is APPROVED only when the branch is ready to merge as it is.

In DETAILS, in this order: STRENGTHS, CRITICAL, IMPORTANT, MINOR (each issue with file:line, what is wrong, why it matters and how to fix it if not obvious), NOTES TRIAGE (only when the package has notes), RECOMMENDATIONS. No preamble and no closing summary.
```

- [ ] **Step 10: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 11: Commit** (controller, after review)

```bash
git add src skills test dist && git commit -m "feat: prompt templates for plan work, STATUS and verdict parsing"
```

### Task 3: `pitroom review`

**Worker:** standard

**Files:**
- Create: `src/core/review.ts`
- Modify: `src/vcs/git.ts`, `src/core/store.ts`, `src/core/run.ts`, `src/core/report.ts`, `src/cli/args.ts`, `src/cli/commands.ts`, `src/cli.ts`
- Test: `test/review.test.mjs`

**Interfaces:**
- Consumes: `loadTemplate`, `fill` (Task 2), `parseVerdict`, `Verdict` (Task 2), `effective().tiers` (Task 1).
- Produces: `reviewDiff(root, a, b)`, `rangeDiff(root, a, b)`, `commitOf(root, ref)`, `gitDir(dir)` in `src/vcs/git.ts`; `RunMeta.reviewOf?: string`, `RunMeta.reviewKind?: 'task'|'fix'|'range'`, `RunMeta.packageFile?: string`, `RunMeta.verdict?: Verdict`; `RunOptions.review?: { of: string; kind: 'task'|'fix'|'range'; packageFile: string }`; in `src/core/review.ts`: `type ReviewKind`, `interface ReviewJob { kind; of; dir; package; implementer?: Target; group?: string }`, `TEMPLATE`, `runReview(id): ReviewJob`, `rangeReview(range, dir): ReviewJob`, `pickReviewer(job): string | undefined`, `writePackage(job): string`; `launch(p, meta)` in `src/cli/commands.ts`; command `pitroom review [run | --range A..B]`.

- [ ] **Step 1: Write the failing tests** — create `test/review.test.mjs`:

```js
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
    MOCK_ACTIONS: `${verdict('PASS', 'NEEDS_FIXES', 0, 1, 2)}\\nDETAILS: app.txt:2 needs a test`,
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

test('review of a follow-up is a scoped re-review: previous findings, fix report, only the fix diff', () => {
  const s = sandbox();
  const impl = runId(s.run(['run', '-i', 'add one [[mock:append:app.txt:one;answer:SUMMARY: added one]]']));
  const first = s.run(['review', impl], { MOCK_ACTIONS: `${verdict('FAIL', 'NEEDS_FIXES', 0, 1, 0)}\\nDETAILS: FINDING-XYZ two is missing` });
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/review.test.mjs`
Expected: FAIL (`review` is taken as a bare task, no `package.md`).

- [ ] **Step 3: Git helpers** — append to `src/vcs/git.ts`:

```ts
/** Stat plus a unified diff with 10 lines of context, for a reviewer. */
export function reviewDiff(root: string, a: string, b: string): string {
  return `${must(root, [...DIFF, '--stat', a, b]).trim()}\n\n${must(root, [...DIFF, '-U10', a, b])}`;
}

/** Commit list, stat and wide-context diff of the commits in a..b, for a reviewer. */
export function rangeDiff(root: string, a: string, b: string): string {
  const range = `${a}..${b}`;
  const log = must(root, ['log', '--oneline', '--no-decorate', range]).trim();
  return [
    `## COMMITS\n\n${log || '(none)'}`,
    `## FILES CHANGED\n\n${must(root, [...DIFF, '--stat', range]).trim() || '(none)'}`,
    `## DIFF\n\n${must(root, [...DIFF, '-U10', range])}`,
  ].join('\n\n');
}

/** The commit a ref names, or undefined. */
export function commitOf(root: string, ref: string): string | undefined {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export function gitDir(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--absolute-git-dir']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
```

- [ ] **Step 4: Run record fields** — in `src/core/store.ts` add `import type { Verdict } from './answers.js';` and, after `discarded?: boolean;` in `RunMeta`:

```ts
  /** For reviews: the reviewed run id, or the reviewed range "a..b". */
  reviewOf?: string;
  reviewKind?: 'task' | 'fix' | 'range';
  /** The package copy the reviewer reads; removed when the review ends. */
  packageFile?: string;
  verdict?: Verdict;
```

- [ ] **Step 5: Reviews in the run lifecycle** — in `src/core/run.ts`:

Add `import { parseVerdict } from './answers.js';`. In `RunOptions` after `group?: string;` add:

```ts
  /** Set by `pitroom review`. */
  review?: { of: string; kind: 'task' | 'fix' | 'range'; packageFile: string };
```

In the `meta` literal of `prepareRun`, after `worktree: …,` add:

```ts
    reviewOf: o.review?.of,
    reviewKind: o.review?.kind,
    packageFile: o.review?.packageFile,
```

In `finalize`, right after `fs.writeFileSync(runFile(meta.id, 'summary.md'), `${run.finalText}\n`);` add:

```ts
  if (meta.reviewOf) {
    meta.verdict = parseVerdict(run.finalText);
    if (meta.packageFile) fs.rmSync(meta.packageFile, { force: true });
  }
```

- [ ] **Step 6: `src/core/review.ts`**

```ts
// `pitroom review`: a read-only worker judges one run's change (task review), one
// fix round (scoped re-review) or a range of commits (whole-branch review). It
// reads a single package file (requirements, report, diff) that Pitroom writes
// into the git dir of the reviewer's workspace: every worker CLI can open it
// there, and it never passes through the primary agent's context. By default the
// reviewer runs on another backend than the implementer: a second model, not the
// same one grading itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BACKEND } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { commitOf, gitDir, rangeDiff, repoRoot, reviewDiff } from '../vcs/git.js';
import { effective } from './config.js';
import { UserError } from './errors.js';
import { readSummary } from './report.js';
import { type RunMeta, freshMeta, isActive, listRunIds, readMeta, runFile } from './store.js';
import { parseTarget } from './target.js';
import type { TemplateName } from './templates.js';

export type ReviewKind = 'task' | 'fix' | 'range';

export interface ReviewJob {
  kind: ReviewKind;
  /** The reviewed run id, or the range "a..b". */
  of: string;
  /** Where the reviewer works. */
  dir: string;
  package: string;
  implementer?: Target;
  group?: string;
}

export const TEMPLATE: Record<ReviewKind, TemplateName> = { task: 'task-reviewer', fix: 're-review', range: 'code-reviewer' };

const section = (title: string, body: string) => `## ${title}\n\n${body.trim() || '(empty)'}\n`;

/** Parent, grandparent, … of a follow-up run. */
function ancestors(m: RunMeta): RunMeta[] {
  const out: RunMeta[] = [];
  for (let id = m.parent; id; ) {
    const a = readMeta(id);
    out.push(a);
    id = a.parent;
  }
  return out;
}

/** What was asked: the brief of the chain's first run (a plan task), else its task. */
function briefOf(m: RunMeta): string {
  const root = [m, ...ancestors(m)].at(-1)!;
  const f = runFile(root.id, 'brief.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : root.task;
}

/** The latest finished review of any of these runs. */
function latestReview(ids: string[]): RunMeta | undefined {
  for (const id of listRunIds().reverse()) {
    try {
      const m = readMeta(id);
      if (m.reviewOf && ids.includes(m.reviewOf) && m.state === 'done') return m;
    } catch {
      // a record being written right now
    }
  }
  return undefined;
}

/** The run's change from `from` (default: its snapshot) to its end state. */
function diffOf(m: RunMeta, from = m.baseTree): string {
  const where = m.mode === 'isolate' ? m.worktree : m.repoRoot;
  if (where && fs.existsSync(where) && from && m.afterTree) return reviewDiff(where, from, m.afterTree);
  if (from !== m.baseTree) {
    throw new UserError(`the isolated copy of ${m.id} is gone, so its fix round cannot be shown on its own; review a run that is not applied yet`, 3);
  }
  return fs.readFileSync(runFile(m.id, 'changes.patch'), 'utf8');
}

export function runReview(id: string): ReviewJob {
  const m = freshMeta(id);
  if (isActive(m.state)) throw new UserError(`run ${m.id} is still ${m.state}; pitroom wait ${m.id} first`, 3);
  if (m.reviewOf) throw new UserError(`run ${m.id} is itself a review`);
  if (m.mode === 'read') throw new UserError(`run ${m.id} was read-only; there is no change to review`);
  if (!m.changes?.length) throw new UserError(`run ${m.id} made no changes; nothing to review`);
  const chain = ancestors(m);
  const previous = latestReview(chain.map((a) => a.id));
  // The implementer's isolated copy while it exists (the code after the change), else the project.
  const dir = m.mode === 'isolate' && m.worktree && fs.existsSync(m.worktree) ? m.cwd : m.dir;
  const job = { of: m.id, dir, implementer: m.ran ?? m.worker, group: m.group };
  const title = `run ${m.id}`;
  if (!previous) {
    return {
      ...job,
      kind: 'task',
      package: [`# Review package · ${title}\n`, section('BRIEF', briefOf(m)), section('REPORT', readSummary(m)), section('DIFF', diffOf(m))].join('\n'),
    };
  }
  // A follow-up: only what this round changed, judged against the previous findings.
  const from = m.mode === 'isolate' ? chain[0]!.afterTree : m.baseTree;
  return {
    ...job,
    kind: 'fix',
    package: [
      `# Re-review package · ${title} · fix round after review ${previous.id}\n`,
      section('BRIEF', briefOf(m)),
      section('PREVIOUS FINDINGS', readSummary(previous)),
      section('FIX REPORT', readSummary(m)),
      section('FIX DIFF', diffOf(m, from)),
    ].join('\n'),
  };
}

export function rangeReview(range: string, dir: string): ReviewJob {
  const root = repoRoot(dir);
  if (!root) throw new UserError('--range needs a git repository');
  const i = range.indexOf('..');
  const a = i > 0 ? range.slice(0, i) : '';
  const b = i > 0 ? range.slice(i + 2) || 'HEAD' : '';
  if (!a || b.startsWith('.')) throw new UserError(`--range takes A..B (e.g. main..HEAD), not "${range}"`);
  for (const ref of [a, b]) if (!commitOf(root, ref)) throw new UserError(`not a commit: ${ref}`);
  return {
    kind: 'range',
    of: `${a}..${b}`,
    dir: root,
    package: [
      `# Review package · ${a}..${b}\n`,
      section('WHAT WAS IMPLEMENTED', 'The commits below.'),
      section('REQUIREMENTS', '(none given; judge the change on its own terms)'),
      rangeDiff(root, a, b),
    ].join('\n'),
  };
}

/**
 * The reviewer when none is named: for a run, the first of the standard tier, the
 * capable tier, the fallbacks and the default worker whose backend differs from
 * the implementer's; for a range, the capable tier. Undefined = the default worker.
 */
export function pickReviewer(job: ReviewJob): string | undefined {
  const eff = effective();
  const tiers = eff.tiers.value;
  if (job.kind === 'range') return tiers.capable;
  const implementer = job.implementer;
  if (!implementer) return undefined;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const candidates = [tiers.standard, tiers.capable, ...eff.fallback.value, eff.worker.value].filter((s): s is string => !!s);
  return candidates.find((c) => parseTarget(c, def).backend !== implementer.backend);
}

/** Writes the package where the reviewer can read it: <git dir of its workspace>/pitroom/. */
export function writePackage(job: ReviewJob): string {
  const g = gitDir(job.dir);
  if (!g) throw new UserError(`not a git repository: ${job.dir}`);
  const file = path.join(g, 'pitroom', `review-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, job.package);
  return file;
}
```

- [ ] **Step 7: The command** — in `src/cli/args.ts` add `'--range': 'range',` to `VALUE_FLAGS`. In `src/cli/commands.ts` add the imports

```ts
import { TEMPLATE, pickReviewer, rangeReview, runReview, writePackage } from '../core/review.js';
import { fill, loadTemplate } from '../core/templates.js';
```

and replace the whole `cmdRun` function with:

```ts
/** Runs a prepared run in the foreground, or starts it in the background with --bg. */
async function launch(p: Parsed, meta: RunMeta): Promise<number> {
  if (has(p, 'bg')) {
    startInBackground(meta);
    console.log(
      has(p, 'json')
        ? JSON.stringify(meta, null, 2)
        : `pitroom started ${meta.mode} run ${meta.id} in background${meta.group ? ` (group ${meta.group})` : ''}\n` +
            `   wait:   pitroom wait ${meta.id}\n   status: pitroom status ${meta.id}`,
    );
    return 0;
  }
  const done = await execute(meta);
  console.log(has(p, 'json') ? JSON.stringify(done, null, 2) : formatReport(done));
  return exitCodeFor(done);
}

export async function cmdRun(p: Parsed): Promise<number> {
  const opts = runOptions(p, readTask(p));
  if (!opts.task.trim()) throw new UserError('no task given (pitroom "find where X is handled")');
  return launch(p, prepareRun(opts));
}

/** A read-only review of a run's change, of a fix round, or of a commit range. */
export async function cmdReview(p: Parsed): Promise<number> {
  const range = flag(p, 'range');
  if (range && p.positional.length) throw new UserError('review takes a run or --range A..B, not both');
  if (has(p, 'write') || has(p, 'isolate')) throw new UserError('reviews are read-only; drop -w/-i');
  if (has(p, 'continue')) throw new UserError('to review a follow-up, pass its run id: pitroom review <run>');
  const job = range ? rangeReview(range, flag(p, 'dir') ?? process.cwd()) : runReview(resolveRun(p.positional[0]));
  const packageFile = writePackage(job);
  let meta: RunMeta;
  try {
    meta = prepareRun({
      ...runOptions(p, fill(loadTemplate(TEMPLATE[job.kind]), { PACKAGE_FILE: packageFile })),
      mode: 'read',
      dir: job.dir,
      worker: flag(p, 'worker') ?? (flag(p, 'tier') ? undefined : pickReviewer(job)),
      group: flag(p, 'group') ?? job.group,
      review: { of: job.of, kind: job.kind, packageFile },
    });
  } catch (e) {
    fs.rmSync(packageFile, { force: true });
    throw e;
  }
  fs.writeFileSync(runFile(meta.id, 'package.md'), job.package);
  return launch(p, meta);
}
```

In `src/cli.ts` add `review: cmd.cmdReview,` to `COMMANDS` (after `crew`), and in HELP after the `pitroom crew` usage lines add:

```text
  pitroom review [run | --range A..B] [--tier T | -W T] [--bg]
                                        read-only review of a run's change (a follow-up: only its
                                        fix round) or of a commit range; by default on another worker
```

- [ ] **Step 8: Report lines** — in `src/core/report.ts` `formatReport`, right after `out.push(ids.filter(Boolean).join(' · '));` add:

```ts
  if (meta.reviewOf) {
    const v = meta.verdict;
    const verdict = v
      ? ` · SPEC ${v.spec.toUpperCase()} · QUALITY ${v.quality.toUpperCase()} · critical ${v.critical} · important ${v.important} · minor ${v.minor}`
      : '';
    out.push(`review of ${meta.reviewOf} (${meta.reviewKind})${verdict}`);
  }
```

Right after `out.push(`   diff:    pitroom show ${meta.id} --patch`);` add `out.push(`   review:  pitroom review ${meta.id}`);`. Change `} else if (meta.sessionId && !meta.applied && !meta.discarded) {` to `} else if (meta.sessionId && !meta.applied && !meta.discarded && !meta.reviewOf) {`.

- [ ] **Step 9: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 10: Commit** (controller, after review)

```bash
git add src test dist && git commit -m "feat: pitroom review (task, fix round, range) on another worker"
```

### Task 4: Plan parser

**Worker:** cheap

**Files:**
- Create: `src/core/plan.ts`
- Modify: `src/lib.ts`
- Test: `test/plan.test.mjs`

**Interfaces:**
- Produces: `interface PlanTask { step: number; title: string; text: string; tier?: string }`; `interface Plan { file: string; title: string; header: string; constraints: string; tasks: PlanTask[] }`; `parsePlan(text: string, file?: string): Plan`; `loadPlan(file: string): Plan` (file = realpath); `planTask(plan: Plan, step: number): PlanTask`; `brief(plan: Plan, task: PlanTask): string`; `planName(file: string): string`.

- [ ] **Step 1: Write the failing tests** — create `test/plan.test.mjs`:

```js
// Implementation plans: tasks by heading, context, constraints, tiers and briefs (via dist/lib.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, parsePlan, planName, planTask } from '../dist/lib.mjs';

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
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/plan.test.mjs`
Expected: FAIL (`parsePlan` is not exported).

- [ ] **Step 3: `src/core/plan.ts`**

```ts
// Implementation plans (docs/pitroom/plans/*.md, written with pitroom-writing-plans):
// the parts one worker needs for one task, so the primary never pastes plan text
// through its own context. Headings inside fenced code blocks are content.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';

export interface PlanTask {
  step: number;
  title: string;
  /** The whole task section, heading included. */
  text: string;
  /** From a `**Worker:** <tier>` line in the task. */
  tier?: string;
}

export interface Plan {
  file: string;
  title: string;
  /** Everything between the title and the first section (goal, architecture, spec…). */
  header: string;
  /** Body of the "Global Constraints" section; "" when the plan has none. */
  constraints: string;
  tasks: PlanTask[];
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;

/** Headings and thematic breaks outside fenced code blocks. */
function structure(lines: string[]): { headings: Heading[]; rules: number[] } {
  const headings: Heading[] = [];
  const rules: number[] = [];
  let open: string | undefined; // the opening fence, e.g. "````"
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (f) {
      const mark = f[1]!;
      if (!open) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !f[2]!.trim()) open = undefined;
      return;
    }
    if (open) return;
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ line: i, level: h[1]!.length, text: h[2]! });
    else if (RULE.test(l)) rules.push(i);
  });
  return { headings, rules };
}

export function parsePlan(text: string, file = ''): Plan {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const { headings, rules } = structure(lines);
  /** The line where the block after `line` ends: the next heading or rule. */
  const after = (line: number) =>
    Math.min(headings.find((h) => h.line > line)?.line ?? lines.length, rules.find((r) => r > line) ?? lines.length);

  const titleHeading = headings.find((h) => h.level === 1);
  const start = titleHeading ? titleHeading.line + 1 : 0;
  const header = lines
    .slice(start, after(start - 1))
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim();

  const gc = headings.find((h) => /^global constraints\b/i.test(h.text));
  const constraints = gc ? lines.slice(gc.line + 1, after(gc.line)).join('\n').trim() : '';

  const tasks: PlanTask[] = [];
  for (const h of headings) {
    const m = /^Task\s+(\d+)\b\s*[:.)\-–—]?\s*(.*)$/i.exec(h.text);
    if (!m) continue;
    const end = headings.find((o) => o.line > h.line && o.level <= h.level)?.line ?? lines.length;
    const body = lines.slice(h.line, end).join('\n').replace(/(\n\s*(?:---|\*\*\*|___)\s*)+$/, '').trimEnd();
    const tier = /^\s*[-*]?\s*\*\*Worker:\*\*\s*`?([\w-]+)`?/m.exec(body)?.[1]?.toLowerCase();
    tasks.push({ step: Number(m[1]), title: m[2]!.trim(), text: body, ...(tier ? { tier } : {}) });
  }
  return { file, title: titleHeading?.text ?? '', header, constraints, tasks };
}

export function loadPlan(file: string): Plan {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new UserError(`plan not found: ${file}`);
  const plan = parsePlan(fs.readFileSync(abs, 'utf8'), fs.realpathSync(abs));
  if (!plan.tasks.length) throw new UserError(`${file} has no "Task N" headings (see pitroom-writing-plans)`);
  return plan;
}

export function planTask(plan: Plan, step: number): PlanTask {
  const t = plan.tasks.find((x) => x.step === step);
  if (!t) throw new UserError(`no Task ${step} in ${plan.file}; it has ${plan.tasks.map((x) => `Task ${x.step}`).join(', ')}`);
  return t;
}

/** What an implementer and its reviewers read: the plan's context, its constraints and one task. */
export function brief(plan: Plan, task: PlanTask): string {
  return `${[
    `# ${plan.title || planName(plan.file)}`,
    plan.header,
    '## Global Constraints',
    plan.constraints || '(none stated in the plan)',
    task.text,
  ]
    .filter(Boolean)
    .join('\n\n')}\n`;
}

/** The plan's file name without .md: its runs' default group. */
export const planName = (file: string): string => path.basename(file).replace(/\.md$/i, '');
```

- [ ] **Step 4: Export it** — append to `src/lib.ts`:

```ts
export { brief, loadPlan, parsePlan, planName, planTask } from './core/plan.js';
```

- [ ] **Step 5: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 6: Commit** (controller, after review)

```bash
git add src test dist && git commit -m "feat: implementation plan parser"
```

### Task 5: `pitroom run --plan --step`

**Worker:** standard

**Files:**
- Modify: `src/core/store.ts`, `src/core/run.ts`, `src/core/report.ts`, `src/core/review.ts`, `src/cli/args.ts`, `src/cli/commands.ts`, `src/cli.ts`
- Test: `test/workflow.test.mjs` (create)

**Interfaces:**
- Consumes: `loadPlan`, `planTask`, `brief`, `planName` (Task 4); `loadTemplate('implementer')`, `fill`, `parseStatus`, `TaskStatus` (Task 2); `RunOptions.review`, `ReviewJob` (Task 3).
- Produces: `RunMeta.plan?: { file: string; step: number; title: string }`, `RunMeta.taskStatus?: TaskStatus`; `RunOptions.plan?: { file: string; step: number }`; `RunOptions.review.plan?`; `ReviewJob.plan?`; `planStep(p): { file: string; step: number } | undefined` in `src/cli/args.ts`; `brief.md` in the run directory; flags `--plan PLAN --step N`.

- [ ] **Step 1: Write the failing tests** — create `test/workflow.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/workflow.test.mjs`
Expected: FAIL (`unknown option --plan`).

- [ ] **Step 3: Run record fields** — in `src/core/store.ts` change the answers import to `import type { TaskStatus, Verdict } from './answers.js';` and add after the `verdict?: Verdict;` member:

```ts
  /** For `--plan` runs and their follow-ups and reviews: the plan task. */
  plan?: { file: string; step: number; title: string };
  /** The implementer's STATUS line. */
  taskStatus?: TaskStatus;
```

- [ ] **Step 4: The run lifecycle** — in `src/core/run.ts`:

Change the answers import to `import { parseStatus, parseVerdict } from './answers.js';` and add

```ts
import { brief, loadPlan, planName, planTask } from './plan.js';
import { fill, loadTemplate } from './templates.js';
```

In `RunOptions` after `tier?: string;` add:

```ts
  /** `--plan PLAN --step N`: implement one task of an implementation plan. */
  plan?: { file: string; step: number };
```

and change the `review?:` member to `review?: { of: string; kind: 'task' | 'fix' | 'range'; packageFile: string; plan?: RunMeta['plan'] };`.

Add this function above `prepareRun`:

```ts
/** The worker's task. For --plan: the implementer template around one plan task. */
function planWork(o: RunOptions): { task: string; tier?: string; plan?: RunMeta['plan']; brief?: string } {
  if (!o.plan) return { task: o.task.trim(), tier: o.tier };
  if (o.continueFrom) throw new UserError("a follow-up continues its parent's task; drop --plan/--step");
  if (o.mode === 'read') throw new UserError('--plan runs implement a task: add -i (an isolated copy, recommended) or -w');
  const plan = loadPlan(o.plan.file);
  const t = planTask(plan, o.plan.step);
  const text = brief(plan, t);
  const task = fill(loadTemplate('implementer'), {
    PLAN_FILE: plan.file,
    STEP: String(t.step),
    TITLE: t.title,
    BRIEF: text.trim(),
    NOTES: o.task.trim() || '(none)',
  });
  // The task's **Worker:** tier applies when the primary names no worker or tier.
  const tier = o.tier ?? (o.worker ? undefined : t.tier);
  return { task, tier, plan: { file: plan.file, step: t.step, title: t.title }, brief: text };
}
```

In `prepareRun` replace `if (!o.task.trim()) throw new UserError('empty task');` with

```ts
  const work = planWork(o);
  if (!work.task) throw new UserError('empty task');
```

replace `tier: o.tier,` in the `resolveChain(…)` call with `tier: work.tier,`; in the `meta` literal replace `task: o.task.trim(),` with `task: work.task,`, replace `group: o.group ?? parent?.group,` with `group: o.group ?? parent?.group ?? (work.plan ? planName(work.plan.file) : undefined),` and add `plan: work.plan ?? o.review?.plan ?? parent?.plan,` after `reviewOf: o.review?.of,`. After `fs.writeFileSync(runFile(meta.id, 'task.md'), `${meta.task}\n`);` add `if (work.brief) fs.writeFileSync(runFile(meta.id, 'brief.md'), work.brief);`.

In `finalize` add, right before `if (meta.reviewOf) {`:

```ts
  if (meta.plan && !meta.reviewOf) meta.taskStatus = parseStatus(run.finalText);
```

- [ ] **Step 5: Reviews carry the plan** — in `src/core/review.ts` add `plan?: RunMeta['plan'];` to `ReviewJob`; in `runReview` change the job line to `const job = { of: m.id, dir, implementer: m.ran ?? m.worker, group: m.group, plan: m.plan };` and the title line to `const title = m.plan ? `Task ${m.plan.step}: ${m.plan.title}` : `run ${m.id}`;`. In `src/cli/commands.ts` `cmdReview` change the `review:` option to `review: { of: job.of, kind: job.kind, packageFile, plan: job.plan },`.

- [ ] **Step 6: The report line** — in `src/core/report.ts` add `import { planName } from './plan.js';` and turn the review block from Task 3 into:

```ts
  if (meta.reviewOf) {
    const v = meta.verdict;
    const verdict = v
      ? ` · SPEC ${v.spec.toUpperCase()} · QUALITY ${v.quality.toUpperCase()} · critical ${v.critical} · important ${v.important} · minor ${v.minor}`
      : '';
    out.push(`review of ${meta.reviewOf} (${meta.reviewKind})${verdict}`);
  } else if (meta.plan) {
    const status = meta.taskStatus ? ` · STATUS ${meta.taskStatus}` : '';
    out.push(`plan: ${planName(meta.plan.file)} · Task ${meta.plan.step}: ${meta.plan.title}${status}`);
  }
```

- [ ] **Step 7: Flags and commands** — in `src/cli/args.ts` add `'--plan': 'plan', '--step': 'step',` to `VALUE_FLAGS` and this function after `runOptions`:

```ts
/** `--plan PLAN --step N`: one task of an implementation plan. */
export function planStep(p: Parsed): { file: string; step: number } | undefined {
  const file = flag(p, 'plan');
  const step = flag(p, 'step');
  if (!file && !step) return undefined;
  if (!file || !step) throw new UserError('--plan and --step go together: pitroom run -i --plan PLAN.md --step N');
  if (!/^\d+$/.test(step)) throw new UserError(`--step takes a task number, not "${step}"`);
  return { file, step: Number(step) };
}
```

In `src/cli/commands.ts` import `planStep` from `./args.js`, and change `cmdRun` to:

```ts
export async function cmdRun(p: Parsed): Promise<number> {
  const opts = { ...runOptions(p, readTask(p)), plan: planStep(p) };
  if (!opts.task.trim() && !opts.plan) throw new UserError('no task given (pitroom "find where X is handled")');
  return launch(p, prepareRun(opts));
}
```

In `cmdCrew`, right after the `--continue` check, add:

```ts
  if (has(p, 'plan') || has(p, 'step')) {
    throw new UserError("start plan tasks with pitroom run -i --plan PLAN --step N --bg (they share the plan's group)");
  }
```

In `src/cli.ts` HELP, after the `--tier` line add:

```text
      --plan PLAN       with --step N: implement Task N of a plan (-i or -w); the task text is your notes
      --step N          the plan task for --plan
```

- [ ] **Step 8: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 9: Commit** (controller, after review)

```bash
git add src test dist && git commit -m "feat: pitroom run --plan --step"
```

### Task 6: `pitroom plan status|note` and plan-aware branch reviews

**Worker:** standard

**Files:**
- Create: `src/core/plan-status.ts`
- Modify: `src/core/review.ts` (`rangeReview`), `src/cli/commands.ts`, `src/cli.ts`
- Test: `test/workflow.test.mjs` (append)

**Interfaces:**
- Consumes: `loadPlan`, `planName`, `Plan` (Task 4); `RunMeta.plan`, `taskStatus`, `reviewOf`, `reviewKind`, `verdict` (Tasks 3, 5).
- Produces: `interface Note { at: string; text: string }`; `interface TaskState`; `interface PlanStatus`; `notesFile(plan)`, `readNotes(plan): Note[]`, `addNote(planFile, text): string`, `planStatus(planFile): PlanStatus`, `formatPlanStatus(s): string`; `rangeReview(range, dir, planFile?)`; commands `pitroom plan status PLAN [--json]`, `pitroom plan note PLAN "text"`, `pitroom review --range A..B --plan PLAN`.

- [ ] **Step 1: Write the failing tests** — append to `test/workflow.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/workflow.test.mjs`
Expected: FAIL (`plan` is taken as a bare task).

- [ ] **Step 3: `src/core/plan-status.ts`**

```ts
// `pitroom plan status|note`: where a plan's execution stands, rebuilt from the
// run records (they survive the primary agent's context compaction) and the
// primary's notes. Notes live in Pitroom's state directory, never in the project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from './answers.js';
import { type Plan, loadPlan, planName } from './plan.js';
import { type RunMeta, freshMeta, home, listRunIds } from './store.js';

export interface Note {
  at: string;
  text: string;
}

export interface TaskState {
  step: number;
  title: string;
  /** Implementer runs for this task: the first, its follow-ups and fresh attempts. */
  runs: number;
  last?: { id: string; state: string; status?: string };
  review?: { id: string; state: string; kind: string; verdict?: Verdict };
  applied: boolean;
  /** The latest note that starts with "Task N:". */
  note?: string;
}

export interface PlanStatus {
  plan: Plan;
  tasks: TaskState[];
  rulings: Note[];
  notesFile: string;
}

export function notesFile(plan: Plan): string {
  const id = crypto.createHash('sha1').update(plan.file).digest('hex').slice(0, 12);
  return path.join(home(), 'plans', id, 'notes.md');
}

export function readNotes(plan: Plan): Note[] {
  const f = notesFile(plan);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (.*)$/.exec(l);
      return m ? { at: m[1]!, text: m[2]! } : { at: '', text: l };
    });
}

export function addNote(planFile: string, text: string): string {
  const plan = loadPlan(planFile);
  const f = notesFile(plan);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# plan: ${plan.file}\n`);
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(f, `${at} ${text.replace(/\s+/g, ' ').trim()}\n`);
  return f;
}

export function planStatus(planFile: string): PlanStatus {
  const plan = loadPlan(planFile);
  const runs: RunMeta[] = [];
  for (const id of listRunIds()) {
    try {
      const m = freshMeta(id);
      if (m.plan?.file === plan.file) runs.push(m);
    } catch {
      // a record being written right now
    }
  }
  const notes = readNotes(plan);
  const tasks = plan.tasks.map((t): TaskState => {
    const impl = runs.filter((m) => m.plan!.step === t.step && !m.reviewOf);
    const rev = runs.filter((m) => m.plan!.step === t.step && m.reviewOf).at(-1);
    const last = impl.at(-1);
    return {
      step: t.step,
      title: t.title,
      runs: impl.length,
      last: last && { id: last.id, state: last.state, status: last.taskStatus },
      review: rev && { id: rev.id, state: rev.state, kind: rev.reviewKind ?? 'task', verdict: rev.verdict },
      applied: impl.some((m) => m.applied || (m.mode === 'write' && m.state === 'done' && !m.reverted && !!m.changes?.length)),
      note: [...notes].reverse().find((n) => n.text.startsWith(`Task ${t.step}:`))?.text,
    };
  });
  return { plan, tasks, rulings: notes.filter((n) => /\bRuling:/.test(n.text)), notesFile: notesFile(plan) };
}

const cell = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function formatPlanStatus(s: PlanStatus): string {
  const head = ['TASK', 'STATE', 'STATUS', 'REVIEW', 'ROUNDS', 'APPLIED', 'TITLE', 'NOTE'];
  const rows = s.tasks.map((t) => {
    const v = t.review?.verdict;
    const review = v ? `${v.spec}/${v.quality} (c${v.critical} i${v.important} m${v.minor})` : (t.review?.state ?? '-');
    return [
      String(t.step),
      t.last?.state ?? '-',
      t.last?.status ?? '-',
      review,
      t.runs ? String(t.runs - 1) : '-',
      t.runs ? (t.applied ? 'yes' : 'no') : '-',
      cell(t.title, 32),
      cell(t.note ?? '', 60),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  const rulings = s.rulings.length ? s.rulings.map((n) => `  ${n.at} ${n.text}`).join('\n') : '  none';
  return [
    `plan ${s.plan.file} · ${s.plan.title || planName(s.plan.file)} · ${s.tasks.length} tasks`,
    '',
    fmt(head),
    ...rows.map(fmt),
    '',
    `Rulings:\n${rulings}`,
    `notes: ${s.notesFile}`,
  ].join('\n');
}
```

- [ ] **Step 4: Plan-aware branch reviews** — in `src/core/review.ts` add

```ts
import { loadPlan, planName } from './plan.js';
import { readNotes } from './plan-status.js';
```

and replace `rangeReview` with:

```ts
export function rangeReview(range: string, dir: string, planFile?: string): ReviewJob {
  const root = repoRoot(dir);
  if (!root) throw new UserError('--range needs a git repository');
  const i = range.indexOf('..');
  const a = i > 0 ? range.slice(0, i) : '';
  const b = i > 0 ? range.slice(i + 2) || 'HEAD' : '';
  if (!a || b.startsWith('.')) throw new UserError(`--range takes A..B (e.g. main..HEAD), not "${range}"`);
  for (const ref of [a, b]) if (!commitOf(root, ref)) throw new UserError(`not a commit: ${ref}`);
  const plan = planFile ? loadPlan(planFile) : undefined;
  const notes = plan ? readNotes(plan) : [];
  const requirements = plan
    ? [
        `Plan: ${plan.file}`,
        '### Global Constraints',
        plan.constraints || '(none stated in the plan)',
        '### Tasks',
        plan.tasks.map((t) => `- Task ${t.step}: ${t.title}`).join('\n'),
      ].join('\n\n')
    : '(none given; judge the change on its own terms)';
  return {
    kind: 'range',
    of: `${a}..${b}`,
    dir: root,
    group: plan ? planName(plan.file) : undefined,
    package: [
      `# Review package · ${a}..${b}\n`,
      section('WHAT WAS IMPLEMENTED', plan ? `${plan.title}\n\n${plan.header}` : 'The commits below.'),
      section('REQUIREMENTS', requirements),
      ...(notes.length ? [section('NOTES FROM EXECUTION', notes.map((n) => `- ${n.text}`).join('\n'))] : []),
      rangeDiff(root, a, b),
    ].join('\n'),
  };
}
```

- [ ] **Step 5: Commands** — in `src/cli/commands.ts` add `import { addNote, formatPlanStatus, planStatus } from '../core/plan-status.js';`. In `cmdReview`, right after the `range && p.positional.length` check, add

```ts
  if (flag(p, 'plan') && !range) throw new UserError("--plan goes with --range (a run's review already knows its plan)");
```

and pass the plan to the range job: `rangeReview(range, flag(p, 'dir') ?? process.cwd(), flag(p, 'plan'))`. Add:

```ts
/** `pitroom plan status PLAN` / `pitroom plan note PLAN "Task N: …"`. */
export function cmdPlan(p: Parsed): number {
  const [sub, file, ...rest] = p.positional;
  if (sub === 'status' && file) {
    const s = planStatus(file);
    console.log(
      has(p, 'json')
        ? JSON.stringify({ plan: s.plan.file, title: s.plan.title, tasks: s.tasks, rulings: s.rulings, notesFile: s.notesFile }, null, 2)
        : formatPlanStatus(s),
    );
    return 0;
  }
  if (sub === 'note' && file && rest.length) {
    console.log(`noted in ${addNote(file, rest.join(' '))}`);
    return 0;
  }
  throw new UserError('usage: pitroom plan status PLAN.md [--json] | pitroom plan note PLAN.md "Task N: …"');
}
```

In `src/cli.ts` add `plan: cmd.cmdPlan,` to `COMMANDS`, change the review usage line to `pitroom review [run | --range A..B [--plan PLAN]] [--tier T | -W T] [--bg]`, and after the review usage lines add:

```text
  pitroom plan status PLAN [--json]     a plan's progress: runs, STATUS, review, fix rounds, applied
  pitroom plan note PLAN "Task N: …"    record a completion, deferred finding or ruling (outside the repo)
```

- [ ] **Step 6: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add src test dist && git commit -m "feat: pitroom plan status/note; plan-aware branch reviews"
```

### Task 7: The `using-pitroom` bootstrap

**Worker:** standard

**Files:**
- Modify: `skills/using-pitroom/SKILL.md` (whole file)
- Modify: `hooks/session-start.mjs`
- Modify: `src/core/doctor.ts`
- Modify: `test/skills.test.mjs`
- Test: `test/pitroom.test.mjs` (append)

**Interfaces:**
- Consumes: `vendor/superpowers-skills/using-superpowers/SKILL.md` (source of the skill discipline).
- Produces: the routing table naming all 13 other skills; `PACK` in `test/skills.test.mjs`; the doctor warning `superpowers is installed too (…)`.

- [ ] **Step 1: Write the failing tests** — in `test/skills.test.mjs`:

Replace the test `'the pack: using-pitroom plus focused pitroom-* skills'` with:

```js
const PACK = [
  'pitroom-brainstorming', 'pitroom-crew', 'pitroom-debugging', 'pitroom-driven-development', 'pitroom-finishing',
  'pitroom-implement', 'pitroom-receiving-review', 'pitroom-research', 'pitroom-review', 'pitroom-tdd',
  'pitroom-verification', 'pitroom-worktrees', 'pitroom-writing-plans', 'using-pitroom',
];

test('the pack: using-pitroom plus the pitroom-* workflow skills', () => {
  for (const s of skills) assert.ok(PACK.includes(s), `unexpected skill folder ${s}`);
  assert.ok(skills.includes('using-pitroom'));
});
```

In the per-skill rules test, change the description assertion to `assert.match(fields.description, /^Use\b/, 'description says when to use it');` and delete the line `assert.doesNotMatch(body, /references\//, 'no links to files that do not exist');`. After that loop add:

```js
test('skill files name Pitroom skills only, and every relative link resolves', () => {
  for (const name of skills) {
    const dir = path.join(skillsDir, name);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(text, /superpowers:|docs\/superpowers|\.superpowers\//, `${name}/${f}`);
      for (const [, target] of text.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        assert.ok(fs.existsSync(path.join(dir, target)), `${name}/${f}: link ${target}`);
      }
    }
  }
});
```

In the session-start hook test change `assert.ok(ctx.length < 6000, …)` to `assert.ok(ctx.length < 8192, 'kept short: it is paid for in every session');` and add `assert.match(ctx, /pitroom-brainstorming/);`.

Append to `test/pitroom.test.mjs`:

```js
test('doctor warns when superpowers is installed too', () => {
  const s = sandbox();
  const home = path.join(s.base, 'user-home');
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'using-superpowers'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'using-superpowers', 'SKILL.md'), '---\nname: using-superpowers\n---\n');
  assert.match(s.run(['doctor'], { HOME: home }).stdout, /superpowers is installed too \(.*using-superpowers\).*keep one/);
  const empty = path.join(s.base, 'empty-home');
  fs.mkdirSync(empty);
  assert.doesNotMatch(s.run(['doctor'], { HOME: empty }).stdout, /superpowers/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run build && node --test test/skills.test.mjs test/pitroom.test.mjs`
Expected: FAIL (hook context lacks `pitroom-brainstorming`; no superpowers warning).

- [ ] **Step 3: Replace `skills/using-pitroom/SKILL.md`** with:

~~~~markdown
---
name: using-pitroom
description: Use at the start of every conversation and before any task - establishes the Pitroom workflow skills (brainstorm, plan, worker-driven development, review, debugging, TDD, verification, finishing) and when cheap Pitroom workers should do the reading and typing instead of you.
---

<SUBAGENT-STOP>
If you are a Pitroom worker, or were dispatched as a subagent for one specific task, ignore this skill.
</SUBAGENT-STOP>

# Using Pitroom

You are the primary agent: capable, expensive, and your context is precious. Pitroom gives you a development workflow as skills, and a crew of cheap worker agents (OpenCode, Codex, Claude Code, on whatever models the user configured) that read, search, implement and review for you. You decide, verify and answer.

## Rule 1: skills first

If there is even a small chance that a skill below applies to what you are doing, invoke it (your Skill tool, or read its SKILL.md) **before** you respond or act, including before clarifying questions or looking at files. If it turns out not to fit, drop it. Announce "Using <skill> to <purpose>", follow it exactly, and turn its checklist into todos.

Process skills come first: they decide how to approach the task, implementation follows. "Let's build X" → `pitroom-brainstorming`. "Fix this bug" → `pitroom-debugging`.

The user's instructions (CLAUDE.md, AGENTS.md, direct requests) override skills; skills override your defaults.

## Rule 2: delegate what a worker can do

Before you open many files, grep around, or make mechanical edits, ask: could a worker do this and hand me back only the answer? Delegate when the work is **bounded** (one question, one area, one well-defined change), **specifiable** (the worker sees none of this conversation) and **checkable** (a diff, a test run, file:line references). Keep design and product judgment, auth, crypto, payments and migrations, anything that needs the user's input or secrets, and anything smaller than writing the brief.

## Which skill

| Situation | Skill |
|---|---|
| Any creative work: a feature, a component, a behaviour change | `pitroom-brainstorming` |
| A spec or requirements for a multi-step task | `pitroom-writing-plans` |
| Executing a written plan | `pitroom-driven-development` |
| An isolated branch for feature work or plan execution | `pitroom-worktrees` |
| A bug, a test failure, unexpected behaviour | `pitroom-debugging` |
| Writing any feature or bugfix code | `pitroom-tdd` |
| About to say something is done, fixed or passing | `pitroom-verification` |
| A finished task or feature, or before a merge | `pitroom-review` |
| Review feedback to act on | `pitroom-receiving-review` |
| Implementation done and tests pass: merge, PR or keep | `pitroom-finishing` |
| Find, map or explain code | `pitroom-research` |
| One well-defined change outside a plan | `pitroom-implement` |
| Two or more independent investigations or changes | `pitroom-crew` |

## Running Pitroom

Call `pitroom` (on PATH after `pitroom install`; otherwise the command in your session context). `pitroom doctor` diagnoses setup problems. Workers and models come from the user's config (`worker`, `fallback`, `models`, `tiers`); pick others only when the user or a plan says so (`--tier capable`, `-W codex`).

Workers can take minutes. Start long work with `--bg` and keep working; follow it with `pitroom watch --json` through your host's background or monitor facility, or call `pitroom wait --timeout 540` again while it exits 75. Never poll with `sleep`.

## Non-negotiable

- Never weaken a worker's safety flags, and never put secrets in a brief.
- Worker output is draft work and a worker's report is a claim: verify what you rely on (`pitroom-verification`).
- You apply patches and commit; workers never commit or push. Push, merge and pull requests happen only through `pitroom-finishing`, after asking.
- If Pitroom fails, carry on yourself; if setup is broken, tell the user what `pitroom doctor` says.

## Red flags

| Thought | Reality |
|---|---|
| "This is just a simple question" | Questions are tasks. Check the skills. |
| "Let me explore the codebase first" | Skills say how to explore; `pitroom-research` does the reading. |
| "This doesn't need a formal skill" | If a skill exists for it, use it. |
| "I remember this skill" | Skills change. Read the current version. |
| "I'll just grep around myself" (3+ files) | `pitroom-research` |
| "I'll fix these twelve lint errors one by one" | `pitroom-implement` |
| "First A, then B, then C" (and they are independent) | `pitroom-crew` |
| "The worker can decide the architecture" | Keep the decision; delegate the reading that informs it. |
| "The worker said the tests pass" | Run them. `pitroom-verification` |
~~~~

- [ ] **Step 4: Hook header** — in `hooks/session-start.mjs` replace the first two lines inside the `<pitroom>` template:

```js
const context = `<pitroom>
You have Pitroom: a development workflow as skills, and cheap worker agents that read, search, implement and review for you. Run it as ${command}.
Below is the 'using-pitroom' skill, your introduction; load the other pitroom-* skills with your Skill tool when they apply.
```

(the rest of the template, `${body}` and `</pitroom>`, stays as it is).

- [ ] **Step 5: Doctor warning** — in `src/core/doctor.ts`, in `skillChecks()` right after `const viaPlugin = pluginInstalled();` add:

```ts
  const superpowers = superpowersInstalled();
  if (superpowers) {
    checks.push({
      level: 'warn',
      message: `superpowers is installed too (${superpowers}): two bootstraps compete for the same work; keep one (Pitroom includes the superpowers workflow)`,
    });
  }
```

and add at the end of the file:

```ts
/** Where superpowers is installed next to Pitroom, if it is. */
function superpowersInstalled(): string | undefined {
  try {
    const f = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const key = Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).plugins ?? {}).find((k) => k.startsWith('superpowers@'));
    if (key) return `Claude Code plugin ${key}`;
  } catch {
    // no Claude Code plugins
  }
  for (const base of [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
    const dir = path.join(base, 'using-superpowers');
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return undefined;
}
```

- [ ] **Step 6: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add skills hooks src test dist && git commit -m "feat(skills): using-pitroom bootstrap for the workflow skills"
```

### Task 8: `pitroom-brainstorming` and `pitroom-writing-plans`

**Worker:** standard

**Files:**
- Create: `skills/pitroom-brainstorming/SKILL.md` (from `vendor/superpowers-skills/brainstorming/SKILL.md`)
- Create: `skills/pitroom-brainstorming/spec-document-reviewer-prompt.md`
- Create: `skills/pitroom-writing-plans/SKILL.md` (from `vendor/superpowers-skills/writing-plans/SKILL.md`)
- Create: `skills/pitroom-writing-plans/plan-document-reviewer-prompt.md`

**Interfaces:**
- Consumes: the skill names from Task 7's routing table; `pitroom run --plan`, `**Worker:**` tiers (Tasks 1, 5).
- Produces: plan documents whose tasks are `### Task N: <name>` headings with a `**Worker:**` line.

- [ ] **Step 1: Copy** `vendor/superpowers-skills/brainstorming/SKILL.md` to `skills/pitroom-brainstorming/SKILL.md` and `vendor/superpowers-skills/writing-plans/SKILL.md` to `skills/pitroom-writing-plans/SKILL.md`. Do not copy `visual-companion.md`, `scripts/` or the two `*-reviewer-prompt.md` files (they are rewritten below).

- [ ] **Step 2: Adapt `skills/pitroom-brainstorming/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-brainstorming
     description: Use before any creative work - creating features, building components, adding functionality, or modifying behavior - to explore intent, requirements and design with the user and get approval before implementation.
     ---
     ```
  2. In all three checklists, the item **Explore project context** gets this addition at the end of its line: ` — let workers do the reading (\`pitroom-research\` for one area, \`pitroom-crew\` for several) and read their answers, not the files`.
  3. Architectural checklist: delete item 2 (**Offer the visual companion just-in-time** …) and renumber the rest 2-8. In the **Write design doc** item change `docs/superpowers/specs/` to `docs/pitroom/specs/`; in the last item change "invoke writing-plans skill" to "invoke `pitroom-writing-plans`".
  4. Process flow graph: rename the node `"Invoke writing-plans skill"` to `"Invoke pitroom-writing-plans"` everywhere in the graph.
  5. "Terminal states are path-bound" paragraph: "the ONLY skill you invoke after brainstorming is writing-plans" → "the ONLY skill you invoke after brainstorming is `pitroom-writing-plans`".
  6. Under **Understanding the idea**, replace the first bullet with: "Check out the current project state first (docs, recent commits); for code, ask a worker for a map (`pitroom-research`) instead of reading it yourself".
  7. **Documentation**: change the path to `docs/pitroom/specs/YYYY-MM-DD-<topic>-design.md` and delete the bullet "Use elements-of-style:writing-clearly-and-concisely skill if available".
  8. After the four numbered checks of **Spec Self-Review** (before "Fix any issues inline"), add:
     ~~~~markdown
     **Second read (optional, for a long spec):** a read-only worker applies [spec-document-reviewer-prompt.md](spec-document-reviewer-prompt.md):

     ```bash
     sed "s#{{SPEC_FILE}}#docs/pitroom/specs/<file>.md#" "<this skill's folder>/spec-document-reviewer-prompt.md" > "$TMPDIR/spec-review.md"
     pitroom run --task-file "$TMPDIR/spec-review.md"
     ```

     Weigh its findings like any review (`pitroom-receiving-review`).
     ~~~~
  9. **Implementation** section: "Invoke the writing-plans skill to create a detailed implementation plan" → "Invoke `pitroom-writing-plans` to create a detailed implementation plan"; "writing-plans is the next step" → "`pitroom-writing-plans` is the next step".
  10. Delete the whole `## Visual Companion` section (to the end of the file).

- [ ] **Step 3: Write `skills/pitroom-brainstorming/spec-document-reviewer-prompt.md`**

```markdown
You are a spec document reviewer. Verify that this spec is complete and ready for implementation planning.

Spec to review: {{SPEC_FILE}}

## What to check

| Category | What to look for |
|---|---|
| Completeness | TODOs, placeholders, "TBD", incomplete sections |
| Consistency | Internal contradictions, conflicting requirements |
| Clarity | Requirements ambiguous enough to make someone build the wrong thing |
| Scope | Focused enough for a single plan, not several independent subsystems |
| YAGNI | Unrequested features, over-engineering |

## Calibration

Only flag issues that would cause real problems during implementation planning: a missing section, a contradiction, a requirement that could be read two ways. Wording, style and "some sections are less detailed than others" are not issues. Approve unless there are serious gaps that would lead to a flawed plan.

## Answer

SUMMARY: STATUS: APPROVED, or SUMMARY: STATUS: ISSUES FOUND (N)
In DETAILS: each issue as "[Section]: issue - why it matters for planning", then RECOMMENDATIONS (advisory; they do not block approval).
```

- [ ] **Step 4: Adapt `skills/pitroom-writing-plans/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-writing-plans
     description: Use when you have a spec or requirements for a multi-step task, before touching code - writes a task-by-task implementation plan that Pitroom workers can execute.
     ---
     ```
  2. Announce line: "I'm using the pitroom-writing-plans skill to create the implementation plan."
  3. Context line: `superpowers:using-git-worktrees` → `pitroom-worktrees`.
  4. **Save plans to:** `docs/pitroom/plans/YYYY-MM-DD-<feature-name>.md`.
  5. After the **Task Right-Sizing** section add:
     ```markdown
     ## Worker Tier

     Every task names the worker tier that implements it, on its own line right under the heading: `**Worker:** cheap`, `**Worker:** standard` or `**Worker:** capable`. `pitroom run --plan` uses it when the executor names no worker; the user's config maps tiers to workers (`tiers`).

     - **cheap**: the task text contains the complete code (implementation is transcription plus testing), or a single-file mechanical fix.
     - **standard**: several files with integration concerns, or an implementer working from prose.
     - **capable**: design judgment or broad understanding of the codebase.

     Turn count beats token price: the cheapest models take 2-3× the turns on multi-step work. When unsure between two tiers, take the higher.
     ```
  6. In the **Plan Document Header** template replace the "For agentic workers" line with:
     `> **For agentic workers:** REQUIRED SUB-SKILL: Use pitroom-driven-development to implement this plan task-by-task (each task runs as \`pitroom run -i --plan <this file> --step N\`). Steps use checkbox (\`- [ ]\`) syntax for tracking.`
  7. In the **Task Structure** template add, right under `### Task N: [Component Name]`, a blank line and `**Worker:** cheap | standard | capable`. Before the template add the sentence: "Task headings are exactly `### Task N: <name>`: `pitroom run --plan` finds tasks by them, and a task runs until the next heading of the same or a higher level."
  8. After the Task Structure template add: "Workers never commit: an implementer skips commit steps, and the primary commits after the task's review, when it applies the patch. Write the commit step anyway; it tells the primary what to commit and how to word it."
  9. **Self-Review**: add a fourth check: "**4. Headings and tiers:** every task has a `### Task N:` heading with a unique N and a `**Worker:**` line."
  10. Replace the whole **Execution Handoff** section with:
      ```markdown
      ## Execution Handoff

      After saving the plan, optionally have a read-only worker check it with [plan-document-reviewer-prompt.md](plan-document-reviewer-prompt.md) (fill `{{PLAN_FILE}}` and `{{SPEC_FILE}}` with `sed` as in `pitroom-brainstorming`, run it with `pitroom run --task-file`). Then offer:

      **"Plan complete and saved to `docs/pitroom/plans/<filename>.md`. Two execution options:**

      **1. Pitroom-driven (recommended)** - a worker implements each task in an isolated copy, another model reviews it, I apply and commit between tasks

      **2. Inline** - I execute the tasks myself in this session, with the same checkpoints

      **Which approach?"**

      Either way: **REQUIRED SUB-SKILL:** `pitroom-driven-development` (its "Inline execution" section covers option 2).
      ```

- [ ] **Step 5: Write `skills/pitroom-writing-plans/plan-document-reviewer-prompt.md`**

```markdown
You are a plan document reviewer. Verify that this plan is complete and ready for implementation by workers who see only one task each.

Plan to review: {{PLAN_FILE}}
Spec for reference: {{SPEC_FILE}}

## What to check

| Category | What to look for |
|---|---|
| Completeness | TODOs, placeholders, incomplete tasks, missing steps, "similar to Task N" |
| Spec alignment | The plan covers the spec's requirements, no major scope creep |
| Task decomposition | Clear boundaries, actionable steps, each task independently testable |
| Buildability | Could a worker follow one task, with only the plan's header and Global Constraints, without getting stuck? |
| Structure | Every task has a `### Task N:` heading with a unique N and a `**Worker:**` tier; names and types match across tasks |

## Calibration

Only flag issues that would cause real problems during implementation: a worker building the wrong thing or getting stuck. Wording, style and nice-to-haves are not issues. Approve unless there are serious gaps: missing requirements from the spec, contradictory steps, placeholder content, or tasks too vague to act on.

## Answer

SUMMARY: STATUS: APPROVED, or SUMMARY: STATUS: ISSUES FOUND (N)
In DETAILS: each issue as "[Task X, Step Y]: issue - why it matters for implementation", then RECOMMENDATIONS (advisory; they do not block approval).
```

- [ ] **Step 6: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass (the skills tests cover the new folders).

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add skills && git commit -m "feat(skills): pitroom-brainstorming and pitroom-writing-plans"
```

### Task 9: `pitroom-driven-development`, `pitroom-crew`, `pitroom-worktrees`

**Worker:** cheap

**Files:**
- Create: `skills/pitroom-driven-development/SKILL.md` (the folder already holds the Task 2 templates)
- Modify: `skills/pitroom-crew/SKILL.md` (whole file)
- Create: `skills/pitroom-worktrees/SKILL.md` (from `vendor/superpowers-skills/using-git-worktrees/SKILL.md`)

**Interfaces:**
- Consumes: `pitroom run --plan/--step/--tier`, `pitroom review`, `pitroom plan status|note`, `pitroom apply|discard|wait|watch|stop` (Tasks 1-6).

- [ ] **Step 1: Write `skills/pitroom-driven-development/SKILL.md`**

~~~~markdown
---
name: pitroom-driven-development
description: Use when executing a written implementation plan - each task goes to a Pitroom worker in an isolated copy, a worker on another model reviews it, and you rule, apply and commit between tasks.
---

# Pitroom-Driven Development

Execute a plan by giving each task to a fresh implementer worker in an isolated copy, a task review (spec compliance and code quality) by a worker on another model after each, and a whole-branch review at the end. You are the controller: you never write a task's code yourself; you rule on conflicts, apply patches and commit.

**Why workers:** each gets exactly its task (Pitroom extracts it from the plan) and none of your conversation. Their tokens are cheap and your context stays free for coordination. A reviewer on a different backend is a second model, not the implementer grading itself.

**Core principle:** fresh worker per task + task review on another model + whole-branch review = high quality at worker prices.

**Narration:** between tool calls, at most one short line. `pitroom plan status` and the tool results carry the record.

**Continuous execution:** do not pause to check in with your human partner between tasks. The only reasons to stop are the four below, or all tasks complete. "Should I continue?" prompts waste their time: they asked you to execute the plan.

**Rulings, not stalls.** Conflicts, ambiguities, plan defects, a cap you would have asked to exceed: decide them. The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers. Record every decision with `pitroom plan note PLAN "Task N: Ruling: <what you decided> — <why> — <what it costs if wrong>"` and keep going. A wrong ruling costs rework your human partner can see and undo; a session parked on a question costs their whole day.

Four things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this branch that norms say you ask about first (a merge, a push, a publish); a plan so broken that every path forward is a guess.

## Setup

1. **Branch:** `pitroom-worktrees`. Never implement on main/master without explicit consent.
2. **Where are we:** `pitroom plan status PLAN`. A task with a `Task N: complete` note is done: never re-dispatch it. A task with runs but no completion note is mid-loop: continue it from its last run and review. After compaction, trust `pitroom plan status` and `git log` over your memory.
3. **Read the plan once**, and its Spec. Note the Global Constraints. Create a todo per task.
4. **Pre-flight scan**, before Task 1. Its output is a table, not a verdict: one row for every pair of tasks that share a file or an interface (what one produces against what the other consumes), one row per task on whether its own text agrees with itself (its tests against its code, the files it creates against the files it later touches), and anything the plan mandates that the review rubric treats as a defect (a test that asserts nothing, duplicated logic). Rule on every finding and note the rulings. The table also tells you which tasks are independent (see Parallel tasks).
5. **Worker setup:** tasks that run the project's tests need its dependencies inside the isolated copy: pass `--link node_modules` (or `.venv`, …) or set `link` in the config.

## Tiers

Every task names a tier (`**Worker:** cheap|standard|capable`), and `pitroom run --plan` uses it. The config maps tiers to workers (`pitroom config` shows `tiers`); an unconfigured tier falls back to the default worker with a warning. Escalating means the next tier up: cheap → standard → capable. Above capable is you, and you only rule; you do not write the code.

## The task loop

### 1. Implement

```bash
pitroom run -i --plan PLAN --step N --link node_modules --verify "<the task's test command>" --bg \
  "<optional notes: interfaces or decisions from earlier tasks the brief cannot know, your resolution of an ambiguity>"
```

Pitroom gives the worker the implementer rules, the plan's context and Global Constraints, and Task N's text; never paste plan text yourself. The run joins the plan's group: follow it with `pitroom watch -g <plan name> --json` or `pitroom wait <run>`.

### 2. Handle the status

The report starts with `plan: … · STATUS <value>`:

- **DONE:** review it (step 3).
- **DONE_WITH_CONCERNS:** read OPEN ISSUES. Doubts about correctness or scope: resolve them first with `pitroom run --continue <run> "<guidance>"`. Observations: note them and review.
- **NEEDS_CONTEXT:** `pitroom run --continue <run> "<the missing context>"`.
- **BLOCKED:** a context problem → `--continue` with context; it needs more reasoning → a fresh run one tier up (`--tier`); too large → split it and note the ruling; the plan is wrong → rule, note, and re-dispatch with the ruling in the notes.
- **unknown** (no status line): treat it as DONE_WITH_CONCERNS.

Never make the same worker retry without changing something. A failing `verify:` line is a finding for the fix loop, not a reason to fix it yourself.

### 3. Review

```bash
pitroom review <run>
```

A read-only worker on another backend gets one package: the brief, the implementer's report and the diff with context. It returns `SPEC PASS|FAIL`, `QUALITY APPROVED|NEEDS-FIXES` and the issues by severity. Never skip it, and never accept a review that lacks either verdict; the implementer's self-review never replaces it.

- Don't pre-judge: never tell a reviewer to ignore something. A finding you think is a false positive enters the loop; you adjudicate at the cap.
- CANNOT VERIFY items (requirements in unchanged code or across tasks): check each yourself before completing the task. A real gap is a failed spec review.

### 4. The fix loop

It triggers on SPEC FAIL, any Critical or Important finding, or a CANNOT VERIFY item you confirmed. Minor findings never enter the loop: note them (`pitroom plan note PLAN "Task N: minor (deferred): …"`) for the final review. A finding that conflicts with the plan's text is yours to rule on first (the spec wins), noted before you act.

A round is one fix plus one scoped re-review. Five rounds at most per task:

- **Rounds 1-3:** `pitroom run --continue <last run> "<the open findings, verbatim>"` (same session, same isolated copy), then `pitroom review <fix run>`. Pitroom sees a fix round and sends only its diff and the previous findings.
- **Rounds 4-5:** a fresh implementer one tier up: `pitroom run -i --plan PLAN --step N --tier <next> "A prior worker attempted this task <R> times; you own it now. Open findings: …"`, `pitroom discard <old run>`, then `pitroom review <new run>`.
- After each round: `pitroom plan note PLAN "Task N: fix round R/5 (X addressed, Y open — <one-liners>)"`.

Never fix findings yourself: controller fixes skip review.

**The breaker.** When round 5 still leaves findings open, stop and adjudicate each one:
- The reviewer is wrong, or the point is contestable: park it — `Task N: parked — <finding> — Ruling: <why the code stands>`.
- Real, but nothing downstream builds on it: park it the same way, saying it is real and deferred.
- Real and load-bearing: rule on the smallest change that unblocks the dependent work, note it, and carry it into the next task's notes. Stop only if every path forward is a guess.

Adjudicate only at the cap; every adjudication is a note. A silent discard is forbidden.

### 5. Land the task

When the review is clean, or every open finding is parked with a ruling at the cap:

```bash
pitroom apply <last run>        # checked apply; refuses on conflict
<the task's tests, run by you>
git add <the task's files> && git commit -m "<the plan's commit message>"
pitroom plan note PLAN "Task N: complete (<base7>..<head7>, review clean)"
```

Mark the todo complete and move on. Never start a dependent task before this one is applied: its isolated copy is taken from your tree.

## Parallel tasks

Tasks the pre-flight table shows as independent (no shared file, no interface between them) may run at once: start each with `pitroom run -i --plan PLAN --step N --bg` (they share the plan's group), watch them with `pitroom watch -g <plan name> --json`, review each, then apply and commit them one at a time in plan order. When `pitroom apply` refuses a patch that no longer applies, send that task a `--continue` to rebase it on the current tree, or run it again. Everything that shares a file runs in sequence.

## Waiting

Never poll with short sleeps, and never sit in one silent, open-ended wait. While workers run, do your own bookkeeping: rulings, reading reports, the next task's notes. When idle, `pitroom wait <run> --timeout 540`; exit 75 means still running: post one line of status and call it again. `pitroom stop <run>` a worker that is clearly stuck, and redo its task.

## Final review

After the last task:

```bash
pitroom review --range "$(git merge-base <base> HEAD)..HEAD" --plan PLAN
```

It runs on the `capable` tier with the whole-branch rubric, and the package carries the plan and your notes, so the reviewer triages the deferred minors and parked findings. If it returns findings: ONE fix run with the complete list, not one run per finding (`pitroom run -i --tier capable --link node_modules "<all findings>"`), exactly one review of that fix (`pitroom review <fix run>`), then apply, test and commit. Adjudicate the residual findings as in the breaker. There is no second fix wave: residual load-bearing findings go to your human partner through `pitroom-finishing`.

## Finish

Collect every note containing `Ruling:` (`pitroom plan status PLAN` lists them) into your final message under "Rulings I made", in the order you made them, each with what it costs if wrong. The list is exhaustive: it is the only place the decisions you took on your human partner's behalf reach them. Then use `pitroom-finishing`.

## Inline execution

When Pitroom is unavailable or your human partner chose inline execution: execute the tasks yourself, in order, following each step exactly and running every verification the plan specifies, with `pitroom-tdd` and `pitroom-verification`. Stop and ask when blocked (a missing dependency, a failing test, an unclear instruction); don't guess. Review the branch with `pitroom-review` when Pitroom is available, then use `pitroom-finishing`.

## Common rationalizations

| Excuse | Reality |
|---|---|
| "Close enough on spec compliance" | A spec gap is not done. Fix it, or reach the cap and adjudicate. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes skip review and fill your context. Continue the worker. |
| "One more round will converge" | Past the cap, rounds don't converge: the failure is structural. Adjudicate. |
| "The reviewer will just find something new anyway" | Fix-round reviews see only the fix diff; they cannot wander. |
| "This finding is obviously wrong, I'll drop it" | You adjudicate only at the cap, and every ruling is a note. |
| "The fix was small, skip the re-review" | Unreviewed fixes are how regressions land. |
| "The same model can review its own work" | `pitroom review` picks another backend when one is configured; configure `tiers` if it can't. |
| "Notes are overhead" | Notes and run records are what survive compaction. Controllers without them re-dispatch finished tasks. |
| "The worker said the tests pass" | Run them after applying. `pitroom-verification` |
~~~~

- [ ] **Step 2: Replace `skills/pitroom-crew/SKILL.md`** with:

~~~~markdown
---
name: pitroom-crew
description: Use when facing two or more independent tasks - questions about different areas, unrelated bugs or failing test files, the same mechanical change in separate modules - to run Pitroom workers in parallel, watch them live and merge their results.
---

# Running a Pitroom crew

Several workers at once, each with its own session (and, for changes, its own isolated copy of the project): one worker per independent problem domain. You split the work, watch, and merge.

## When to use

- Several questions about different areas of the code.
- Three or more test files failing with different root causes; subsystems broken independently.
- The same mechanical change in separate modules.

Don't use it when the failures are related (fixing one might fix the others: investigate them together first), when understanding needs the whole system, when you don't yet know what is broken (exploratory debugging: `pitroom-debugging`), or when workers would edit the same files. The tasks of a written plan run through `pitroom-driven-development`, which has its own rules for parallel tasks.

## 1. Split

Parts must be **independent**: no part needs another's result, and no two parts edit the same file. Two to five parts is the sweet spot; at most `maxParallel` workers (default 4) run at a time, the rest queue. Keep dependent or judgment-heavy parts for yourself.

## 2. Write focused briefs

Each worker sees only its brief, so each brief is:
1. **Focused:** one problem domain ("fix agent-tool-abort.test.ts", not "fix all the tests").
2. **Self-contained:** the error messages, test names and file paths it needs.
3. **Constrained:** what not to change ("do not change production code", "tests only").
4. **Specific about the answer:** "the root cause and what you changed", "file:line for each".

```text
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:
1. "should abort tool with partial output capture" - expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" - fast tool aborted instead of completed
3. "should properly track pendingToolCount" - expects 3 results but gets 0
These look like timing issues. Find the real cause: replace arbitrary timeouts with
event-based waiting, or fix the abort implementation. Do NOT just increase timeouts.
Answer with the root cause and what you changed.
```

`pitroom-research` and `pitroom-implement` have more brief templates.

## 3. Start

```bash
pitroom crew -g auth-audit \
  "Map how sessions are created in src/auth; file:line for each step." \
  "List every place that reads the session cookie outside src/auth; file:line." \
  "Which tests cover session expiry? List files and what each asserts."
```

Read-only by default. For changes add `-i` (each worker edits its own isolated copy): `pitroom crew -i -g lint-fix "Fix the lint errors in src/a" "Fix the lint errors in src/b"`. Never parallel `--write`; Pitroom refuses it.

## 4. Watch

Follow the group live without polling:
- `pitroom watch -g NAME --json`: one JSON line per change (`queued`, `started`, `progress`, `fallback`, `done`/`failed`, then `all-done`). Run it through your host's background or monitor facility so each line reaches you as it happens; it exits by itself when the group is done.
- No such facility: `pitroom wait -g NAME --timeout 540`, and call it again while it exits with 75.
- `pitroom status -g NAME`: one table snapshot.
- Tell the user they can see the same table live with `pitroom watch -g NAME` in a terminal.

While workers run, do the parts you kept for yourself.

## 5. Collect, verify and merge

```bash
pitroom wait -g NAME --brief        # one line per worker: state + SUMMARY
pitroom show <run>                  # the full report of the ones you need
```

- Read each summary and understand what changed.
- Check for conflicts: did two workers touch the same code or contradict each other?
- Verify what you will rely on (`refs:` lines help), then combine the findings in your own words.
- For `-i` crews: review each patch (`pitroom review <run>` or `pitroom show <run> --patch`), then `pitroom apply -g NAME`. It applies in order and stops at the first conflict; fix that one with `pitroom run --continue <run> "…"` or by hand, then apply the rest.
- Run the full test suite yourself afterwards, and spot-check: workers make systematic errors.

## When things go wrong

- A worker failed or timed out: retry that part once with a sharper brief, or do it yourself.
- Rate limits: the fallback chain handles single failures; if many fail, lower `maxParallel` (config or `PITROOM_MAX_PARALLEL`).
- Stop everything: `pitroom stop -g NAME` (running and queued).
~~~~

- [ ] **Step 3: Adapt `skills/pitroom-worktrees/SKILL.md`** (copy of `vendor/superpowers-skills/using-git-worktrees/SKILL.md`)
  1. Frontmatter:
     ```
     ---
     name: pitroom-worktrees
     description: Use when starting feature work that needs isolation from the current workspace, or before executing an implementation plan - sets up an isolated branch for your own work (workers get isolated copies from Pitroom itself).
     ---
     ```
  2. Announce line: "I'm using the pitroom-worktrees skill to set up an isolated workspace."
  3. Right after the **Overview** section add:
     ```markdown
     ## Workers don't need this

     This skill isolates **your** branch. Pitroom workers never edit your checkout when started with `-i`: each gets a private copy of your current state, and you apply its patch. Don't create a worktree per worker.
     ```

- [ ] **Step 4: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 5: Commit** (controller, after review)

```bash
git add skills && git commit -m "feat(skills): pitroom-driven-development, crew and worktrees"
```

### Task 10: `pitroom-review`, `pitroom-receiving-review`, `pitroom-finishing`

**Worker:** standard

**Files:**
- Modify: `skills/pitroom-review/SKILL.md` (whole file; `code-reviewer.md` from Task 2 stays)
- Create: `skills/pitroom-receiving-review/SKILL.md` (from `vendor/superpowers-skills/receiving-code-review/SKILL.md`)
- Create: `skills/pitroom-finishing/SKILL.md` (from `vendor/superpowers-skills/finishing-a-development-branch/SKILL.md`)

**Interfaces:**
- Consumes: `pitroom review` (Tasks 3, 6).

- [ ] **Step 1: Replace `skills/pitroom-review/SKILL.md`** with:

~~~~markdown
---
name: pitroom-review
description: Use when completing a task, implementing a major feature, before merging, or whenever you want a second opinion on a diff, branch or pull request - a read-only Pitroom worker on another model reviews it against its requirements.
---

# Reviewing with Pitroom

A read-only worker reviews the change against what was asked, on another backend than the one that wrote the code when one is configured. It reads a package (requirements, report, diff with context) that never passes through your context; you get the verdicts and the findings.

**Core principle:** review early, review often. Findings are leads for you to weigh, not verdicts to obey.

## When

**Mandatory:** after each task of a plan (`pitroom-driven-development` does it), after a major feature, before a merge.
**Valuable:** when stuck (fresh eyes), before a refactor (a baseline), after fixing a complex bug.

## How

| What | Command | The reviewer gets |
|---|---|---|
| A worker's change (`-i` or `-w` run) | `pitroom review <run>` | the task (for plan runs: the plan brief), the worker's report, the diff |
| A follow-up that fixed review findings | `pitroom review <fix run>` | the previous findings, the fix report, only the fix diff |
| Your branch, or any commit range | `pitroom review --range main..HEAD [--plan PLAN]` | the commits, stat and diff; with `--plan`, the plan's goal, constraints, tasks and notes |
| A pull request | `git fetch origin pull/123/head:pr-123` then `pitroom review --range "$(git merge-base main pr-123)..pr-123"` | the same, without checking the PR out |

`--tier capable` or `-W claude` picks the reviewer; `--bg` keeps you working meanwhile. The report's first line gives `SPEC PASS|FAIL · QUALITY APPROVED|NEEDS-FIXES` and the counts; `pitroom show <review> --full` has every finding. The whole-branch rubric is [code-reviewer.md](code-reviewer.md).

## Act on the findings

Use `pitroom-receiving-review`. In short:
- Fix Critical issues immediately and Important ones before proceeding; note Minor ones for later.
- Verify each finding against the code before acting: cheap models produce false positives, and verified `refs:` only mean the cited lines exist.
- Push back with technical reasoning when the reviewer is wrong.
- In a plan, fixes go back to the implementer (the fix loop in `pitroom-driven-development`), never into your own session.
- Tell the user which findings you accepted and why.

Never post review comments, push or merge on a worker's word alone.

## Red flags

Never skip a review because the change is "simple", ignore Critical issues, proceed with unfixed Important issues, or argue with valid technical feedback.

| Excuse | Reality |
|---|---|
| "I'll just review the diff myself instead" | You are the coordinator: the diff and its evaluation belong in the reviewer's context, only the findings in yours. |
| "The reviewer needs my session history to understand the change" | It needs the requirements and the diff, and the package carries both. |
| "The same model can review it" | Configure `tiers` so reviews run on another backend; a model grading itself misses its own blind spots. |
~~~~

- [ ] **Step 2: Adapt `skills/pitroom-receiving-review/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-receiving-review
     description: Use when receiving code review feedback - from a Pitroom reviewer, a colleague or a pull request - before implementing suggestions, especially if feedback seems unclear or technically questionable; requires technical rigor and verification, not performative agreement or blind implementation.
     ---
     ```
  2. After the `### From External Reviewers` subsection (before `## YAGNI Check for "Professional" Features`) add:
     ```markdown
     ### From a Pitroom reviewer

     Reviews from `pitroom review` come from cheap, often free models: expect false positives. Check every finding against the code; a cited file:line that exists is not a claim that is right. Inside a plan, don't implement the fixes yourself: send the verified findings to the implementer (`pitroom-driven-development`'s fix loop). Findings you reject are rulings: note them with `pitroom plan note`.
     ```

- [ ] **Step 3: Adapt `skills/pitroom-finishing/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-finishing
     description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work - verifies, presents merge / pull request / keep options, and executes the one your human partner chooses.
     ---
     ```
  2. Announce line: "I'm using the pitroom-finishing skill to complete this work."
  3. At the start of **Step 1: Verify Tests** add: "First make sure no Pitroom worker is still running for this work (`pitroom ls --running`) and that no isolated patch you meant to keep is unapplied (`pitroom ls`)."
  4. In **Step 6**, the sentence "Superpowers created this worktree — we own cleanup:" (it wraps after "Superpowers") becomes "`pitroom-worktrees` created this worktree — we own cleanup:".

- [ ] **Step 4: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 5: Commit** (controller, after review)

```bash
git add skills && git commit -m "feat(skills): pitroom-review, receiving-review and finishing"
```

### Task 11: `pitroom-debugging`, `pitroom-tdd`, `pitroom-verification`

**Worker:** cheap

**Files:**
- Create: `skills/pitroom-debugging/` — `SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`, `condition-based-waiting-example.ts`, `find-polluter.sh` (from `vendor/superpowers-skills/systematic-debugging/`)
- Create: `skills/pitroom-tdd/` — `SKILL.md`, `writing-good-tests.md` (from `vendor/superpowers-skills/test-driven-development/`)
- Create: `skills/pitroom-verification/SKILL.md` (from `vendor/superpowers-skills/verification-before-completion/SKILL.md`)

- [ ] **Step 1: Copy** the files listed above (not `CREATION-LOG.md` or `test-*.md`), keeping `find-polluter.sh` executable.

- [ ] **Step 2: Adapt `skills/pitroom-debugging/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-debugging
     description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes - finds the root cause first, with Pitroom workers gathering the evidence.
     ---
     ```
  2. At the end of **Phase 1: Root Cause Investigation** (after item 5, before `### Phase 2`) add:
     ```markdown
     **Delegate the gathering, keep the reasoning.** Reading logs, tracing a value through many files, finding every caller, bisecting commits: give those to read-only workers (`pitroom-research`; several independent ones at once with `pitroom-crew`) and ask for file:line evidence. The hypothesis, and the decision about what the evidence means, stay with you.
     ```
  3. At the end of **Phase 3: Hypothesis and Testing** add:
     ```markdown
     **Competing hypotheses:** when two or three are equally likely, one read-only worker per hypothesis can gather the evidence for and against it in parallel (`pitroom-crew`). Test them one at a time yourself.
     ```
  4. `superpowers:test-driven-development` → `pitroom-tdd`; `superpowers:verification-before-completion` → `pitroom-verification`.

- [ ] **Step 3: Adapt the TDD files**
  1. `skills/pitroom-tdd/SKILL.md` frontmatter:
     ```
     ---
     name: pitroom-tdd
     description: Use when implementing any feature or bugfix, before writing implementation code - red, green, refactor, for you and for the workers you brief.
     ---
     ```
  2. At the end of the **Overview** section add: "Workers follow it too: an implementer worker on a plan task is told to use TDD and to report RED and GREEN evidence. Check that evidence in its report before you trust the tests."
  3. In `skills/pitroom-tdd/writing-good-tests.md`, remove ` (superpowers:writing-skills)` from the sentence "Documents that instruct agents are tested by the consuming agent's behavior".

- [ ] **Step 4: Adapt `skills/pitroom-verification/SKILL.md`**
  1. Frontmatter:
     ```
     ---
     name: pitroom-verification
     description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims, including claims a worker made; evidence before assertions always.
     ---
     ```
  2. Before `## When To Apply` add:
     ```markdown
     ## Worker reports are claims

     A Pitroom worker's "tests pass", `verify: ✔ passed` in an isolated copy, or a reviewer's approval is evidence about that copy at that moment, not about your tree now. After `pitroom apply`, run the verification yourself on your tree before you say anything is done, fixed or passing.
     ```

- [ ] **Step 5: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 6: Commit** (controller, after review)

```bash
git add skills && git commit -m "feat(skills): pitroom-debugging, tdd and verification"
```

### Task 12: Docs, version 0.6.0, cleanup

**Worker:** standard

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `test/skills.test.mjs`
- Delete: `vendor/`

- [ ] **Step 1: The pack is complete** — in `test/skills.test.mjs` replace the body of the pack test with `assert.deepEqual([...skills].sort(), PACK);`.

- [ ] **Step 2: README**
  1. Insert before `## Crews`:
     ~~~~markdown
     ## Workflow

     Pitroom ships a full development methodology as skills, adapted from [superpowers](https://github.com/obra/superpowers) so that its subagents are cheap workers: your agent brainstorms and plans with you, then executes the plan task by task while workers do the typing and a second model does the reviewing.

     ```text
     pitroom-brainstorming ──► spec (docs/pitroom/specs/)
     pitroom-writing-plans ──► plan (docs/pitroom/plans/), every task tagged with a worker tier
     pitroom-driven-development, per task:
       pitroom run -i --plan PLAN --step N    implementer worker, isolated copy, TDD evidence, STATUS line
       pitroom review <run>                   read-only reviewer on another backend: SPEC and QUALITY verdicts
       pitroom run --continue <run> "…"       fix rounds; the re-review sees only the fix diff
       pitroom apply <run> · tests · commit   the primary lands it; workers never commit
     pitroom review --range main..HEAD --plan PLAN   whole-branch review on the capable tier
     pitroom-finishing ──► merge, PR or keep (asked, never automatic)
     ```

     Tiers map plan tasks to workers: `"tiers": {"cheap": "opencode", "standard": "codex", "capable": "claude"}`. `pitroom plan status PLAN` rebuilds where a plan stands from the run records (it survives context compaction), and `pitroom plan note` keeps completions and rulings outside the repo.
     ~~~~
  2. Replace the `## Skills` table with:
     ```markdown
     | Skill | Your agent uses it to |
     |---|---|
     | `using-pitroom` | follow the workflow and decide what to delegate (injected at session start by the plugin) |
     | `pitroom-brainstorming` | turn an idea into an approved design before any code |
     | `pitroom-writing-plans` | write a task-by-task plan with a worker tier per task |
     | `pitroom-driven-development` | execute a plan: worker per task, review on another model, fix loop, apply, commit |
     | `pitroom-worktrees` | isolate its own branch for the work |
     | `pitroom-tdd` | test first, for itself and the workers it briefs |
     | `pitroom-debugging` | find root causes, with workers gathering the evidence |
     | `pitroom-verification` | run the checks before claiming anything is done |
     | `pitroom-review` | get a change, a fix round, a branch or a PR reviewed by another model |
     | `pitroom-receiving-review` | weigh review findings with technical rigor |
     | `pitroom-finishing` | merge, open a PR or keep the branch, as the user chooses |
     | `pitroom-research` | find, map or explain code through a read-only worker |
     | `pitroom-implement` | get a one-off change made in an isolated copy |
     | `pitroom-crew` | split independent work across parallel workers and merge the results |
     ```
  3. In **Why Pitroom**, replace the "Works with any agent" bullet with: `- **Works with any agent.** Fourteen [Agent Skills](https://agentskills.io): the superpowers development workflow run by workers, plus delegation (`using-pitroom`, `pitroom-research`, `-crew`, `-implement`), a CLI, and a Claude Code / Codex plugin whose session-start hook loads the workflow. Claude Code, Codex, Gemini CLI, Cursor, or anything that can run a shell command.`
  4. In the **Commands** block, after the `pitroom crew` line add:
     ```text
     pitroom run -i --plan PLAN --step N [--tier T] ["notes"]
     pitroom review [run | --range A..B [--plan PLAN]] [--tier T | -W T] [--bg]
     pitroom plan status PLAN [--json] · pitroom plan note PLAN "Task N: …"
     ```
  5. In the Configuration JSON example add `"tiers": { "cheap": "opencode", "standard": "codex", "capable": "claude" },` after the `models` line, and add to the sentence before it: "`tiers` names workers for `--tier` and for plan tasks' `**Worker:**` lines."
  6. Replace the final `MIT licensed.` line with:
     ```markdown
     ## Credits

     The workflow skills (brainstorming, planning, worker-driven development, review, debugging, TDD, verification, worktrees, finishing) are adapted from [superpowers](https://github.com/obra/superpowers) by Jesse Vincent, used under the MIT License:

     > Copyright (c) 2025 Jesse Vincent
     >
     > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
     >
     > The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
     >
     > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

     Pitroom itself is MIT licensed.
     ```

- [ ] **Step 3: CHANGELOG** — insert at the top, under `# Changelog`:

```markdown
## 0.6.0

### Workflow skills
Pitroom now ships a complete development workflow, adapted from [superpowers](https://github.com/obra/superpowers) so that its subagents are Pitroom workers (Credits in the README): `pitroom-brainstorming`, `pitroom-writing-plans`, `pitroom-driven-development`, `pitroom-worktrees`, `pitroom-review`, `pitroom-receiving-review`, `pitroom-finishing`, `pitroom-debugging`, `pitroom-tdd` and `pitroom-verification`, next to `pitroom-research`, `pitroom-implement` and `pitroom-crew`. `using-pitroom` is the bootstrap for all of them. `pitroom doctor` warns when superpowers is installed too.

### Plan execution
- `pitroom run -i --plan PLAN --step N`: the worker gets the implementer rules, the plan's context and Global Constraints and exactly one task; its `STATUS:` line (DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED) is recorded. Runs join the plan's group.
- `pitroom review <run>`: a read-only reviewer, by default on another backend, reads one package (brief, report, diff with context) and returns SPEC and QUALITY verdicts. Reviewing a follow-up is a scoped re-review (previous findings, fix report, only the fix diff). `pitroom review --range A..B [--plan PLAN]` reviews a branch with the plan and the notes from execution.
- `pitroom plan status PLAN` rebuilds a plan's progress from the run records; `pitroom plan note PLAN "…"` records completions, deferred findings and rulings outside the repo.
- Config `tiers` (`{"cheap": "opencode", "standard": "codex", "capable": "claude"}`) and `--tier NAME`; plan tasks pick their tier with a `**Worker:**` line.
```

- [ ] **Step 4: Version and manifests** — set `"version": "0.6.0"` in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`plugins[0].version`) and `.codex-plugin/plugin.json`. Set the `description` of `package.json` and `.claude-plugin/plugin.json` to: `A free pit crew for your expensive coding agent: the superpowers development workflow, run by cheap workers. Delegate research, fixes, tests, reviews and whole plans from Claude Code, Codex or any agent to OpenCode, Codex or Claude Code workers, with receipts that prove the savings.` Add `"workflow"`, `"code-review"`, `"tdd"` and `"planning"` to the `keywords` of `package.json`.

- [ ] **Step 5: Remove the vendored sources** — `git rm -r -q vendor`.

- [ ] **Step 6: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck && PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH npm test`
Expected: all pass.

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add -A README.md CHANGELOG.md package.json .claude-plugin .codex-plugin test dist && git commit -m "docs: workflow skills, 0.6.0"
```

## Final verification (controller)

1. `pitroom install`, then `pitroom doctor`: 14 skills linked, tiers listed, the superpowers warning shown on this machine (expected until the user removes one).
2. Real run in a scratch repo (`mkdir -p "$TMPDIR/pitroom-e2e" && cd "$TMPDIR/pitroom-e2e" && git init -q && npm init -y >/dev/null`), with a two-task plan at `docs/pitroom/plans/demo.md`: Task 1 (`**Worker:** cheap`) adds `sum(a, b)` in `sum.js` with a `node:test` test; Task 2 (`**Worker:** standard`) adds `mean(xs)` using `sum`. For each task: `pitroom run -i --plan … --step N --verify "node --test"`, `pitroom review <run>` (must run on Codex or Claude, not OpenCode), a fix round if needed, apply, commit, `pitroom plan note`. Then `pitroom review --range <first>..HEAD --plan …` (capable tier: Claude) and `pitroom plan status …`.
3. Check: every reviewer could read its package, verdicts parsed, fix-round packages hold only the fix diff, notes and rulings listed. Record what was verified in the 0.6.0 CHANGELOG entry and commit.
