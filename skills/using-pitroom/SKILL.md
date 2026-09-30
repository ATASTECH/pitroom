---
name: using-pitroom
description: Use at the start of every conversation and before any task - establishes the Pitroom workflow skills (brainstorm, plan, worker-driven development, review, debugging, TDD, verification, finishing) and when cheap Pitroom workers should do the reading and typing instead of you.
---

<SUBAGENT-STOP>
If you are a Pitroom worker, or were dispatched as a subagent for one specific task, ignore this skill.
</SUBAGENT-STOP>

# Using Pitroom

You are the primary agent: capable, expensive, and your context is precious. Pitroom gives you a development workflow as skills, and a crew of cheap worker agents (OpenCode, Codex, Claude Code, on whatever models the user configured) that read, search, implement and review for you. You decide, verify and answer.

## Rule 0: small work stays with you

Some work needs no skill, no worker and no brief: just do it and answer. A typo, a one-line fix or one spot the user pointed at, a rename inside one file, a value the user named; a question you can answer from this conversation or one file you already know; talking an idea through; running a command the user gave you. Writing a brief or walking a workflow for these costs more than the work itself.

It stops being small the moment it changes behaviour, touches several files, or needs reading around the code first: then Rule 1 applies.

## Rule 1: skills first

For everything beyond Rule 0: if there is even a small chance that a skill below applies to what you are doing, invoke it (your Skill tool, or read its SKILL.md) **before** you respond or act, including before clarifying questions or looking at files. If it turns out not to fit, drop it. Announce "Using <skill> to <purpose>", follow it exactly, and turn its checklist into todos.

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
| "This is just a simple question" | If what you know or one file answers it, answer (Rule 0). If it means reading around the code, `pitroom-research`. |
| "Let me explore the codebase first" | Skills say how to explore; `pitroom-research` does the reading. |
| "It's small, so no skill" (but it changes behaviour or several files) | Small in words is not small in work. Rule 0 ends there: a behaviour change starts with `pitroom-brainstorming`. |
| "I'll write a brief for this one-line fix" | Rule 0: just make the edit. |
| "I remember this skill" | Skills change. Read the current version. |
| "I'll just grep around myself" (3+ files) | `pitroom-research` |
| "I'll fix these twelve lint errors one by one" | `pitroom-implement` |
| "First A, then B, then C" (and they are independent) | `pitroom-crew` |
| "The worker can decide the architecture" | Keep the decision; delegate the reading that informs it. |
| "The worker said the tests pass" | Run them. `pitroom-verification` |
