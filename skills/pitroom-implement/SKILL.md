---
name: pitroom-implement
description: Use for well-defined code changes a cheaper worker can make - small bug fixes, simple features, mechanical refactors, renames, writing tests, fixing lint or type errors, docs - where you can state the goal and check the result with a diff or tests.
---

# Implementing with a Pitroom worker

The worker edits code; you review and apply. Nothing reaches the user's tree without your decision.

## Pick the mode

| | Flag | Use |
|---|---|---|
| isolate | `-i` | **Default for changes.** The worker edits a private copy of the current state (uncommitted and untracked files included). You apply the patch. |
| write | `-w` | Only for trivial in-place edits while nobody else edits those files. One `--write` run per repository at a time; `pitroom revert <run>` undoes exactly its changes. |

## Run

```bash
pitroom run -i --link node_modules --verify "npm test -- auth" \
  "Fix: expired tokens return 500 instead of 401 in src/auth/session.ts. Add a regression test in test/auth.test.ts. Do not change the public API."
pitroom run -w "Rename getUserById to findUserById in src/ and update imports. No other changes."
```

`--link` shares ignored folders (node_modules, .venv) with the isolated copy so tests can run there; `--verify` runs your check after the worker and reports pass/fail. Long changes: add `--bg` and collect with `pitroom wait <run>`.

## Write a good brief

- **Goal** in one sentence, with the observable behaviour that must change.
- **Where**: files, functions, the failing test or error message.
- **Constraints**: "no new dependencies", "keep the public API", "match the existing style".
- **Done means**: which tests must pass, what must not change.

## Review and land

1. Read the report: `FILES CHANGED`, `VERIFICATION`, `OPEN ISSUES`, and the `verify:` line.
2. `pitroom show <run> --patch`: review the diff as you would a colleague's.
3. isolate: `pitroom apply <run>` (checked apply; refuses on conflict) or `pitroom discard <run>`. write: keep it, or `pitroom revert <run>`.
4. Run the relevant tests yourself after applying.
5. Needs another pass? `pitroom run --continue <run> "Also handle the refresh-token path."` (same session and copy; the patch accumulates).

Commit only if the user asked you to. If the worker fails twice, make the change yourself.
