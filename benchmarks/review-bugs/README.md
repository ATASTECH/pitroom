# Review benchmark: planted bugs

Does `pitroom review` find a real bug that was planted in real code, and does it leave clean code alone?

`make.mjs` builds 48 packages on four repositories (React, Django, Kubernetes and Pitroom itself):

- **32 bug packages**: one semantic bug changed in a real source file (16 *easy*: the bug alone;
  16 *hard*: the bug plus three comment-only edits in the same file). The bugs come from five
  mechanical operators: equality flip (`===`/`!==`), `&&`/`||` swap (`and`/`or` in Python), boundary
  (`<`/`<=`), off-by-one (`+ 1`/`- 1`) and `return true`/`return false`. Python and Go mutants are
  syntax-checked. The mix is what the operators found in the random files, not a chosen one (mostly
  equality flips and `&&`/`||` swaps).
- **16 "clean" packages**: three comment-only edits and no bug. They are **not scored**: the comments are inserted at random places, and some are really wrong (a `// hot path` above code that only runs in development, a comment inside a license header that breaks a repository check), so reviewers were right to flag them and the packages cannot measure false alarms.
- **16 equivalent packages** (`equiv.mjs`, p49 to p64, four per repository): one or two edits that look like the planted bugs (a comparison changed on one line, with the same `chore: tidy` message) but cannot change what the code does. The operands of a comparison are swapped and the operator mirrored (`i < n` becomes `n > i`, `a.tag === HostRoot` becomes `HostRoot === a.tag`), only where both operands are plain (a name, a dotted name, a number, a string) and what is around the comparison binds more loosely than it, so it is the same expression; never in comments, strings or docstrings. Two kinds of edit that a reviewer could rightly flag are left out: a literal moved to the left (`null !== x`, which a lint rule may forbid) and added parentheses (which gofmt, black and Prettier remove, so a format check in CI would fail). Pitroom's packages carry the same edit in its committed `dist/` too, as its contributing guide asks ("commit the rebuilt files with your change"; esbuild keeps the operand order, so it is what a rebuild gives), else a reviewer rightly asks for the rebuilt files; a comparison that is not exactly once in the bundle is not used. A Critical or Important finding on these packages is a false alarm (the review template puts style under Minor). `test/bench-equiv.test.mjs` checks the rule: what it rejects, and that every mirrored JavaScript expression gives the same value as the original for thousands of value combinations.

Every package is one commit on a neutral branch with the message `chore: tidy <file>`; the reviewer
is given the commit range by hash. The truth (file, line, original and changed line) is in
`manifest.json`, which is not in any repository the reviewers read.

```bash
# clones from ../multi-repo plus a clone of pitroom itself in the same folder
node make.mjs --repos ~/workspace/bench-repos
node equiv.mjs --repos ~/workspace/bench-repos   # appends p49-p64
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
- **False alarm** (equivalent packages): the review has a Critical or Important finding.
- **On the edit**: such a finding cites the changed file within 3 lines of an edit, so it blames the
  edit itself rather than something else in the file (a real but older problem, which a reviewer may
  rightly report).
- A run that ended in a provider error is left out; a timeout counts as a miss (on an equivalent
  package, as no alarm).
- The Critical and Important part of a review starts at its first Critical or Important heading:
  some reviewers leave out an empty Critical one (until 2026-10-25 such reviews were read as having
  no findings, which counted a few found bugs as misses).

## Limits

- The bugs are mechanical, not the subtle design mistakes real reviews meet. Every reviewed change is tiny (2 to 5 lines) and the commit message says only "tidy", so most models see one suspicious line; larger diffs would be harder.
- A model that calls every diff broken would find every bug: read "Bug found" next to "False alarm". The equivalent edits are as small as the bugs and sit on the same kind of line, but they are of one kind (a mirrored comparison); a reviewer may find other harmless rewrites more suspicious.
- Three of the 32 Python mutants landed in docstrings instead of code and were dropped after the fact (`invalid` in `manifest.json`), leaving 29 bug packages.
- Matching by identifier can credit a finding that mentions the same function for another reason.
- React, Django and Kubernetes are public and may be in a model's training data; Pitroom's own code
  is not. `make.mjs` uses a fixed seed, so the packages are reproducible.
