# Review benchmark: planted bugs

Does `pitroom review` find a real bug that was planted in real code, and does it leave clean code alone?

`make.mjs` builds 48 packages on four repositories (React, Django, Kubernetes and Pitroom itself):

- **32 bug packages**: one semantic bug changed in a real source file (16 *easy*: the bug alone;
  16 *hard*: the bug plus three comment-only edits in the same file). The bugs come from five
  mechanical operators: equality flip (`===`/`!==`), `&&`/`||` swap (`and`/`or` in Python), boundary
  (`<`/`<=`), off-by-one (`+ 1`/`- 1`) and `return true`/`return false`. Python and Go mutants are
  syntax-checked. The mix is what the operators found in the random files, not a chosen one (mostly
  equality flips and `&&`/`||` swaps).
- **16 "clean" packages**: three comment-only edits and no bug. They are **not scored**: the comments are inserted at random places, and some are really wrong (a `// hot path` above code that only runs in development, a comment inside a license header that breaks a repository check), so reviewers were right to flag them and the packages cannot measure false alarms. A fair test needs edits that are equivalent by construction.

Every package is one commit on a neutral branch with the message `chore: tidy <file>`; the reviewer
is given the commit range by hash. The truth (file, line, original and changed line) is in
`manifest.json`, which is not in any repository the reviewers read.

```bash
# clones from ../multi-repo plus a clone of pitroom itself in the same folder
node make.mjs --repos ~/workspace/bench-repos
node run.mjs --targets opencode:opencode/big-pickle,codex:gpt-6-sol --pool 12
node score.mjs --json results/scores.json
```

`run.mjs` is resumable (finished runs are skipped) and uses `--no-fallback`.

## Scoring

Only Critical and Important findings count.

- **Bug found**: a finding names the changed file and either cites a line within 5 of the bug or
  names an identifier from the changed line or from the function around it. A model that describes
  the right bug but quotes a wrong line still counts; the next column is the strict one.
- **Exact line**: a finding cites `file:line` within 3 of the bug.
- A run that ended in a provider error is left out; a timeout counts as a miss.

## Limits

- The bugs are mechanical, not the subtle design mistakes real reviews meet. Every reviewed change is tiny (2 to 5 lines) and the commit message says only "tidy", so most models see one suspicious line; larger diffs would be harder.
- Without a valid clean set there is no false-alarm rate: a model that calls every diff broken would score 100% here.
- Three of the 32 Python mutants landed in docstrings instead of code and were dropped after the fact (`invalid` in `manifest.json`), leaving 29 bug packages.
- Matching by identifier can credit a finding that mentions the same function for another reason.
- React, Django and Kubernetes are public and may be in a model's training data; Pitroom's own code
  is not. `make.mjs` uses a fixed seed, so the packages are reproducible.
