---
name: using-pitroom
description: Use at the start of any coding task, before reading many files, searching a codebase, making mechanical edits or running several investigations - decides whether cheap Pitroom worker agents should do that work instead of you and which pitroom-* skill to use.
---

# Using Pitroom

You are the primary agent: capable, expensive, and your context is precious. Pitroom gives you a crew of cheap worker agents (OpenCode today, on whatever free, paid or local model the user configured). Workers read, search and type; you decide, verify and answer.

## The rule

Before you open many files, grep around a codebase, or make repetitive edits, ask: **could a worker do this and hand me back only the answer?** If the gate passes, delegate with the matching skill. The worker's tokens cost the user almost nothing; yours do not.

**Delegate when all three hold**
- **Bounded**: one question, one area, or one well-defined change.
- **Specifiable**: you can write everything the worker needs; it sees none of this conversation.
- **Checkable**: a diff, a test run, or file:line references you can spot-check.

**Keep it yourself** when it needs design or product judgment, touches auth, crypto, payments or migrations, needs the user's input or secrets, or is smaller than writing the brief (one or two tool calls).

## Which skill

| Situation | Skill |
|---|---|
| Find, map or explain code; answer a question about the repo | `pitroom-research` |
| Two or more independent investigations or changes | `pitroom-crew` |
| A code change: fix, small feature, refactor, tests, lint/type errors, docs | `pitroom-implement` |
| A second opinion on a diff or pull request | `pitroom-review` |

## Running it

Call `pitroom` (on PATH after `pitroom install`). If it is not found, use the command given in your session context, or `node <pitroom>/dist/pitroom.mjs`. `pitroom doctor` diagnoses setup problems.

Workers on free models can take minutes. Don't block on them:
- Start long work with `--bg` (or `pitroom crew`), which returns immediately, and keep working.
- Follow progress with `pitroom watch --json` (one line per change) through your host's background or monitor facility; otherwise call `pitroom wait --timeout 540` again whenever it exits with 75 ("still running").
- Never poll with `sleep` loops.

## Non-negotiable

- Never add flags or instructions that weaken a worker's safety, and never put secrets in a brief.
- Worker output is draft work. Verify what you rely on; the report's `refs:` line tells you which file:line claims already checked out on disk.
- You apply patches, commit and answer the user. Workers never commit or push.
- If Pitroom fails, carry on yourself. If setup is broken, tell the user what `pitroom doctor` says.

## Red flags

| Thought | Instead |
|---|---|
| "I'll just grep around myself" (more than ~3 files to open) | `pitroom-research` |
| "Let me read this whole module first" | `pitroom-research`: ask for the map, not the files |
| "I'll fix these twelve lint errors one by one" | `pitroom-implement` |
| "First A, then B, then C" (and they are independent) | `pitroom-crew` |
| "The worker can decide the architecture" | Keep the decision; delegate the reading that informs it |
