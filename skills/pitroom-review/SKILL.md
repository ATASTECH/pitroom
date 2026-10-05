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
| A pull request | `git fetch origin pull/123/head:pr-123` then `pitroom review --range main..pr-123` (the diff starts where the PR left main) | the same, without checking the PR out |

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
