# Pitroom workflow skills: superpowers, run by workers

Status: approved design, 2026-09-30. Target release: 0.6.0.

## Goal

Pitroom becomes a complete development methodology, not only a delegation
tool: the superpowers skill pack (obra/superpowers 6.3.0, MIT) is copied and
adapted so that its subagents are Pitroom workers. The primary agent keeps the
superpowers discipline (brainstorm, plan, test first, review, verify, finish)
while cheap workers do the implementing and a different model does the
reviewing. Pitroom replaces superpowers; it does not depend on it.

## Decisions

| Question | Decision |
|---|---|
| Relationship to superpowers | Replaces it. All skills are copied and adapted under `pitroom-*` names; `pitroom doctor` warns when superpowers is also installed. |
| Scope | Every superpowers skill except `writing-skills`. The brainstorming visual companion (browser server) is left out. |
| Tooling | Skills plus a thin CLI layer that replaces superpowers' bash scripts (`task-brief`, `review-package`, `sdd-workspace`). |
| Attribution | Only in the README "Credits" section, which carries the MIT copyright and permission notice. No per-file notices. |
| Commits | Workers never commit. The primary applies a worker's patch, runs the tests and commits on the feature branch. Push, merge and PRs only through `pitroom-finishing`, after asking. |

## Skill pack

Names are prefixed because `pitroom install` links skills into flat,
unnamespaced skill folders next to other packs.

| Skill | Source | Adaptation |
|---|---|---|
| `using-pitroom` | using-superpowers + current using-pitroom | Bootstrap injected by the SessionStart hook: the skill discipline ("if a skill might apply, invoke it"), the delegation rule, and the routing table to every other skill. At most 8 KB. |
| `pitroom-brainstorming` | brainstorming | Same three paths (spike, bounded, architectural) and approval gate. Project exploration goes to `pitroom-research` / `pitroom-crew`. Specs go to `docs/pitroom/specs/`. The spec reviewer prompt may run as a read-only worker. |
| `pitroom-writing-plans` | writing-plans | Plans go to `docs/pitroom/plans/`. The plan header points to `pitroom-driven-development`. Every task carries a `**Worker:** cheap|standard|capable` line. Commit steps are the primary's. |
| `pitroom-driven-development` | subagent-driven-development + executing-plans | The core loop (below). Without Pitroom, the primary executes the plan inline with the same checkpoints. |
| `pitroom-crew` | dispatching-parallel-agents + current pitroom-crew | Merged. |
| `pitroom-worktrees` | using-git-worktrees | Isolation for the primary's own branch. Worker isolation is `-i`, not a worktree per worker. |
| `pitroom-review` | requesting-code-review + code-reviewer.md | Uses `pitroom review`. |
| `pitroom-receiving-review` | receiving-code-review | Near verbatim; adds that free-model reviewers produce false positives to verify. |
| `pitroom-finishing` | finishing-a-development-branch | Same options; push/merge/PR only after asking. |
| `pitroom-debugging` | systematic-debugging + its supporting files | Phase 1 evidence gathering and competing hypotheses may run as parallel read-only workers. |
| `pitroom-tdd` | test-driven-development + writing-good-tests | Near verbatim. The implementer template demands RED/GREEN evidence. |
| `pitroom-verification` | verification-before-completion | Near verbatim; adds "a worker's report is a claim, not evidence". |
| `pitroom-research`, `pitroom-implement` | current | Kept for one-off delegation outside a plan. |

Every `superpowers:` cross-reference becomes the matching `pitroom-*` skill.
Paths `docs/superpowers/...` become `docs/pitroom/...`.

## The core loop (`pitroom-driven-development`)

Roles: the primary is the controller; implementers are isolated Pitroom
workers; reviewers are read-only workers, by default on a different backend
than the implementer.

Setup
1. `pitroom-worktrees`: a feature branch; main/master only with consent.
2. `pitroom plan status PLAN` to find completed tasks (survives compaction).
3. Read the plan once; pre-flight table of tasks that share files or
   interfaces and of self-contradictions; rule on conflicts and note them.

Per task N
1. Implement: `pitroom run -i --plan PLAN --step N [--tier T] --verify "<cmd>" --bg`.
2. Handle `STATUS:` (DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED, unknown)
   as superpowers does; NEEDS_CONTEXT is answered with `--continue`.
3. Review: `pitroom review <run>`: spec compliance and quality verdicts.
4. Fix loop, at most 5 rounds, each one fix plus one scoped re-review:
   rounds 1-3 `pitroom run --continue <run> "<findings>"` then
   `pitroom review <fix-run>`; rounds 4-5 a fresh run one tier up with the
   previous report attached. After round 5 the primary adjudicates and records
   a `Ruling:` note. Minor findings are noted, never looped.
5. Land: `pitroom apply <run>`, run the tests, commit, then
   `pitroom plan note PLAN "Task N: complete (<base7>..<head7>)"`.

Independent tasks (no shared file, no interface dependency in the pre-flight
table) may run in parallel with `pitroom crew -i` and are applied in plan
order. Dependent tasks run one after another, each isolated copy taken after
the previous task was applied.

Finish: `pitroom review --range <merge-base>..HEAD --plan PLAN` on the
`capable` tier, one fix wave, one scoped re-review, the full list of
"Rulings I made", then `pitroom-finishing`.

## CLI

### `pitroom run --plan PLAN --step N`

- Parses the plan (Markdown): title, `**Goal:**`, `**Architecture:**`,
  `**Tech Stack:**`, `**Spec:**`, the `## Global Constraints` section, and the
  task section whose heading matches `^#+\s+Task\s+N\b` (not N0, N1…),
  ignoring headings inside fenced code blocks. A task section ends at the next
  heading of the same or a higher level.
- A `**Worker:** <tier>` line in the task section picks the tier when neither
  `-W` nor `--tier` is given.
- The worker's task is the implementer template filled with the plan context,
  the global constraints and the task text, plus the positional task argument
  (optional) as "Notes from the primary".
- The brief (plan context + constraints + task text) is saved as `brief.md`
  in the run directory; `meta.plan = { file, step, title }`.
- The group defaults to the plan's file name without extension.
- Allowed with `-i` and `-w`; refused with `-r` (exit 2).
- Errors: missing plan file or task → exit 2 listing the task headings found.

### `--tier NAME` and config `tiers`

- Config: `"tiers": { "cheap": "opencode", "standard": "codex", "capable": "claude" }`
  (a record of target specs, like `models`; per-worker `models` still apply).
- `--tier` resolves to a worker target; `-W` wins over `--tier`. An unknown or
  unset tier warns and uses the default worker.
- `pitroom config` and `pitroom doctor` show the tiers.

### `STATUS:` line

The answer format gains an optional first line `STATUS: <value>` for plan
runs. The report parser stores it as `meta.taskStatus`; missing → `unknown`.

### `pitroom review`

- `pitroom review <run>`: task review of an `-i` or `-w` run.
  - Package file in the review run's directory: the implementer's brief, its
    report, the stats, and the diff `baseTree..afterTree` with 10 lines of
    context. Attached with `-f`.
  - Template: `task-reviewer-prompt.md`.
  - If the run continues an earlier run (`parent`) that has a review, this is
    a scoped re-review: template `re-review-prompt.md`, the previous findings,
    and only the diff `parent.afterTree..run.afterTree`.
- `pitroom review --range A..B [--plan PLAN]`: whole-branch review with
  `code-reviewer.md` of `git diff -U10 A..B` (plus the commit list and stat);
  the plan's goal and constraints when `--plan` is given. Default tier
  `capable`.
- Reviewer choice when no `-W`/`--tier`: the first of the `standard` tier,
  the `capable` tier, then the fallback chain whose backend differs from the
  implementer's; otherwise the default worker. Always read-only.
- Review runs record `meta.reviewOf` (run id or range) and, parsed from the
  answer, `meta.verdict = { spec: 'pass'|'fail'|'unknown', quality:
  'approved'|'needs-fixes'|'unknown', critical, important, minor }`.
- Other options as for `run` (`--bg`, `-g`, `--timeout`, `--json`). The
  group defaults to the reviewed run's group.
- Errors: run still active → exit 3 ("wait first"); no changes → exit 2;
  not a git repo for `--range` → exit 2.

### `pitroom plan status PLAN` / `pitroom plan note PLAN "text"`

- Notes live outside the repo: `<pitroom home>/plans/<sha1(realpath PLAN)[:12]>/notes.md`,
  first line `# plan: <path>`, one timestamped line per note.
- `status` prints, for every task heading in the plan: the latest
  implementer run (state, `STATUS:`), the latest review verdict, the number
  of fix rounds, whether it was applied, and the last note that starts with
  `Task N:`. Then every note line containing `Ruling:`. `--json` for agents.

### Templates

`skills/pitroom-driven-development/{implementer,task-reviewer,re-review}-prompt.md`
and `skills/pitroom-review/code-reviewer.md` hold only the prompt body with
`{{PLACEHOLDER}}` fields. The CLI reads them at run time from the package root;
a missing template is exit 3 with a hint to run `pitroom doctor`. Adapted to
Pitroom: no commits, no delegation, no questions mid-run (report
NEEDS_CONTEXT instead), and the reviewer's output mapped onto Pitroom's answer
format: `SUMMARY` carries `SPEC:` and `QUALITY:` verdict lines and counts,
`DETAILS` carries strengths, issues by severity with file:line, and the
"cannot verify from the diff" items.

### Doctor

Warns when superpowers is installed too (a `superpowers@` Claude Code plugin,
or a `using-superpowers` skill in `~/.agents/skills` or `~/.claude/skills`):
two bootstraps compete; keep one.

## Testing

- Unit: plan parser (fences, Task 1 vs Task 10, missing Global Constraints,
  `**Worker:**`), template filling (no `{{` left), reviewer choice, tier
  resolution, verdict and STATUS parsing.
- End to end with the mock worker: `--plan --step` prompt contains the task
  and constraints and no other task; review package contains patch and
  report; continue + review sends only the fix diff and the previous
  findings; `plan status` / `plan note`; `review --range`.
- Skills: exactly the 14 skills, Agent Skills frontmatter rules, bootstrap
  under 8 KB and routing to every skill, no `superpowers:` references, every
  relative link resolves.
- Real run: a two or three task plan in a scratch repo, OpenCode implementing,
  Codex reviewing, Claude doing the final review.

## Docs

README: workflow section and Credits (with the MIT notice of obra/superpowers).
CHANGELOG 0.6.0. `docs/backends.md` unchanged.

## Out of scope

The visual companion, `writing-skills`, Gemini worker, platform host notes,
publishing.
