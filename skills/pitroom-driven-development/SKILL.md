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

Tasks the pre-flight table shows as independent (no shared file, no interface between them) may run at once: start each with `pitroom run -i --plan PLAN --step N --bg` (they share the plan's group), watch them with `pitroom watch -g <plan name> --json`, review each, then apply and commit them one at a time in plan order. When `pitroom apply` refuses a patch, look at what conflicts. If only generated files differ (such as a rebuilt `dist/`), apply the rest of the patch and rebuild them. If source hunks conflict, do not drop them: run the task again from the current tree with the conflict in its notes and review that run as usual, or resolve every hunk by hand and review the result with `pitroom review --range` before you commit. Everything that shares a file runs in sequence.

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
