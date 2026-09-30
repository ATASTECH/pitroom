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
