---
name: pitroom-review
description: Use when you want a cheap second opinion on a diff, a branch or a pull request - likely bugs, missed edge cases, missing tests, risky changes - before you or the user commit or merge it.
---

# Second-opinion review with a Pitroom worker

A read-only worker reviews a diff you give it. Its findings are leads for you to weigh, not verdicts.

## Run

```bash
git diff > "$TMPDIR/review.diff"                        # or: git diff main...HEAD, gh pr diff 123
pitroom run -f "$TMPDIR/review.diff" "Review this diff for correctness bugs, unhandled edge cases, missing tests and risky changes. For each finding: file:line, severity (high/medium/low), why it is wrong, and a concrete failing scenario. Say 'no findings' if there are none. Ignore style."
```

Point the worker at context it needs ("the caller is src/api/routes.ts") and at what matters most for this change ("concurrency", "backwards compatibility"). For a large diff, split it by area with `pitroom-crew`.

## Use the findings

- Check each finding against the code before acting; free models produce some false positives. Verified `refs:` mean the cited lines exist, not that the claim is right.
- Fix real issues yourself or with `pitroom-implement`; drop the rest with a reason.
- Tell the user which findings you accepted and why.

Never post review comments, push or merge on the worker's word alone.
