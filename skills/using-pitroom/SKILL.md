---
name: using-pitroom
description: Use when you want cheap Pitroom workers or its workflow skills for a task, or when the user asks for Pitroom - a menu of the pitroom-* skills (brainstorm, plan, worker-driven development, review, debugging, TDD, verification, finishing), when each pays off, and how to run workers. Optional; skip it for work you would rather do yourself.
---

<SUBAGENT-STOP>
If you are a Pitroom worker, or were dispatched as a subagent for one specific task, ignore this skill.
</SUBAGENT-STOP>

# Using Pitroom

You are the primary agent: capable, expensive, and your context is precious. Pitroom gives you a development workflow as skills, and a crew of cheap worker agents (OpenCode, Codex, Claude Code, on whatever models the user configured) that read, search, implement and review for you. You decide, verify and answer.

## Optional by design

Pitroom is a toolbox, not a procedure. Use it when you judge it saves effort or improves the result, or when the user asks for it: by name, or for what it does ("brainstorm this with me", "write a plan", "have a worker do it", "get this reviewed"). Otherwise work as you normally would, with no skill and no worker. When the user says to stop using it, stop.

The user's instructions (CLAUDE.md, AGENTS.md, direct requests) always come before any of this.

## When it pays off

- Reading a lot to answer a little: many files to search, a flow to trace, a large module to map (`pitroom-research`).
- Well-defined, checkable work you can hand off with a short brief: mechanical edits across files, tests to write, lint or type errors (`pitroom-implement`), several independent ones at once (`pitroom-crew`).
- A second opinion from another model on a diff or a branch (`pitroom-review`).
- Larger features you want to take through design, plan and worker-driven execution (the workflow skills below).

A worker's brief pays off when the work is **bounded** (one question, one area, one well-defined change), **specifiable** (the worker sees none of this conversation) and **checkable** (a diff, a test run, file:line references).

## When to leave it

- Small work: a typo, a one-line fix, a rename inside one file, a value the user named, a question you can answer from what you know or one file, talking an idea through, running a command the user gave you. Just do it.
- Design and product judgment, auth, crypto, payments and migrations, and anything that needs the user's input or secrets: keep those yourself; delegate at most the reading that informs them.

## Which skill

| Situation | Skill |
|---|---|
| A feature, component or behaviour change you want designed with the user first | `pitroom-brainstorming` |
| A spec or requirements for a multi-step task | `pitroom-writing-plans` |
| Executing a written plan | `pitroom-driven-development` |
| An isolated branch for feature work or plan execution | `pitroom-worktrees` |
| A bug, a test failure, unexpected behaviour whose cause is not obvious | `pitroom-debugging` |
| Feature or bugfix code you want to drive test-first | `pitroom-tdd` |
| About to say something is done, fixed or passing | `pitroom-verification` |
| A finished task or feature, or before a merge | `pitroom-review` |
| Review feedback to act on | `pitroom-receiving-review` |
| Implementation done and tests pass: merge, PR or keep | `pitroom-finishing` |
| Find, map or explain code | `pitroom-research` |
| One well-defined change outside a plan | `pitroom-implement` |
| Two or more independent investigations or changes | `pitroom-crew` |

Once you or the user pick a skill, follow it: its checklists and gates are how it works. Say which one you are using, and drop it when it stops fitting.

## Running Pitroom

Call `pitroom` (on PATH after `pitroom install`; otherwise the command in your session context). `pitroom doctor` diagnoses setup problems. Workers and models come from the user's config (`worker`, `fallback`, `models`, `tiers`); pick others only when the user or a plan says so (`--tier capable`, `-W codex`).

Workers can take minutes. Start long work with `--bg` and keep working; follow it with `pitroom watch --json` through your host's background or monitor facility, or call `pitroom wait --timeout 540` again while it exits 75. Never poll with `sleep`.

## When you do use it

- Never weaken a worker's safety flags, and never put secrets in a brief.
- Worker output is draft work and a worker's report is a claim: verify what you rely on (`pitroom-verification`).
- You apply patches and commit; workers never commit or push. Push, merge and pull requests happen only after the user asks.
- Keep the decisions: delegate the reading and typing, not the architecture.
- Say what you delegated: one line per worker run naming the worker and model (the run report has both) and what it cost or saved. Not every host shows Pitroom's cards or status line, and the user should always know which model touched their code. `pitroom savings --models` lists them all.
- You set a worker's permissions when you create it, from the task and from how much autonomy the user gave you in this session (for example auto mode): read-only by default, `-i` (an isolated copy) for changes, `-w` (edits in place) when the user wants that, `--web` only when the task needs the web. A worker never widens its own permissions.
- Pitroom keeps a fixed floor that no flag lifts: no git history changes, no `sudo`, no publishing, no secrets, no killing processes. Everything above that floor is your call.
- Deletions are your decision, made as the user's agent. `pitroom apply` refuses a patch that deletes files unless you pass `--allow-delete`. If removing files is what the user asked for or an obvious part of it, apply with the flag and tell them which files went; if the worker deleted something the user did not ask for, ask first, or discard the run.
- If Pitroom fails, carry on yourself; if setup is broken, tell the user what `pitroom doctor` says.
