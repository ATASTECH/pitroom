---
name: pitroom-crew
description: Use when a task splits into two or more independent parts - several questions about different areas, several unrelated bugs or failing test files, the same mechanical change in separate modules - to run Pitroom workers in parallel, watch them live and merge their results.
---

# Running a Pitroom crew

Several workers at once, each with its own session (and, for changes, its own isolated copy of the project). You split the work, watch, and merge.

## 1. Split

Parts must be **independent**: no part needs another's result, and no two parts edit the same file. Two to five parts is the sweet spot; at most `maxParallel` workers (default 4) run at a time, the rest queue. Each brief must stand alone (see `pitroom-research` and `pitroom-implement` for brief templates). Keep dependent or judgment-heavy parts for yourself.

## 2. Start

```bash
pitroom crew -g auth-audit \
  "Map how sessions are created in src/auth; file:line for each step." \
  "List every place that reads the session cookie outside src/auth; file:line." \
  "Which tests cover session expiry? List files and what each asserts."
```

Read-only by default. For changes add `-i` (each worker edits its own isolated copy): `pitroom crew -i -g lint-fix "Fix the lint errors in src/a" "Fix the lint errors in src/b"`. Never parallel `--write`; Pitroom refuses it.

## 3. Watch

Follow the group live without polling:
- `pitroom watch -g NAME --json`: one JSON line per change (`queued`, `started`, `progress`, `fallback`, `done`/`failed`, then `all-done`). Run it through your host's background or monitor facility so each line reaches you as it happens; it exits by itself when the group is done.
- No such facility: `pitroom wait -g NAME --timeout 540`, and call it again while it exits with 75.
- `pitroom status -g NAME`: one table snapshot.
- Tell the user they can see the same table live with `pitroom watch -g NAME` in a terminal.

While workers run, do the parts you kept for yourself.

## 4. Collect and merge

```bash
pitroom wait -g NAME --brief        # one line per worker: state + SUMMARY
pitroom show <run>                  # the full report of the ones you need
```

Cross-check where parts overlap, verify what you will rely on (`refs:` lines help), then combine the findings in your own words.

For `-i` crews: review each patch (`pitroom show <run> --patch`), then `pitroom apply -g NAME`. It applies in order and stops at the first conflict; fix that one with `pitroom run --continue <run> "…"` or by hand, then apply the rest. Run the tests yourself afterwards.

## When things go wrong

- A worker failed or timed out: retry that part once with a sharper brief, or do it yourself.
- Rate limits: the fallback chain handles single failures; if many fail, lower `maxParallel` (config or `PITROOM_MAX_PARALLEL`).
- Stop everything: `pitroom stop -g NAME` (running and queued).
