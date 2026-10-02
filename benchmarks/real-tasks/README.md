# Real-task benchmark: pilot only

Does a primary coding agent finish real tasks better, cheaper or faster when it also has Pitroom?

**Status: a pilot of three tasks. It supports no claim about savings, and Pitroom's README does not make one from it.**

`mine.mjs` finds candidate tasks in a repository's history (commits that change `src` and tests together).
`tasks.json` holds the three pilot tasks from Pitroom's own history. `run.mjs` runs each in two arms:

- **A**: the primary agent alone (no `pitroom` command).
- **B**: the same agent with Pitroom's usage guide and the `pitroom` command.

Each run starts from a fresh copy of the code at the commit before the fix, with **no git history** (the
fix is not in it). The commit's own test files are copied in only after the run, and a run passes when they pass.

```bash
node run.mjs --validate                                       # each task: tests fail before the fix, pass after
node run.mjs --tasks pitroom-card-subjects --arms A,B --reps 1                 # primary agent: Claude Code
node run.mjs --primary codex --tasks pitroom-card-subjects --arms A,B --reps 1  # primary agent: Codex
```

With `--primary codex` each run gets its own `HOME` and `CODEX_HOME` (only the login is copied), so no installed
skill or setting leaks into arm A. Arm B links OpenCode's and Pitroom's own settings in.

## What the pilot showed

One run per task and arm, so every difference below is within what one run can vary by.

**Claude Code** (`claude-sonnet-5-5`)

| Task | Arm | Result | Time | Primary tokens | Cost | Pitroom workers |
|---|---|---|---|---|---|---|
| pitroom-card-subjects | A | pass | 106 s | 246k | $0.22 | - |
| pitroom-card-subjects | B | pass | 55 s | 185k | $0.21 | 0 |
| pitroom-verdict-and-doctor | A | pass | 78 s | 295k | $0.15 | - |
| pitroom-verdict-and-doctor | B | pass | 73 s | 264k | $0.14 | 0 |
| pitroom-worker-names | A | pass | 55 s | 246k | $0.12 | - |
| pitroom-worker-names | B | pass | 51 s | 259k | $0.13 | 0 |

**Codex** (`gpt-6-sol`)

| Task | Arm | Result | Time | Primary tokens | Cost | Pitroom workers |
|---|---|---|---|---|---|---|
| pitroom-card-subjects | A | pass | 176 s | 616k | subscription | - |
| pitroom-card-subjects | B | pass | 149 s | 324k | subscription | 0 |
| pitroom-verdict-and-doctor | A | pass | 144 s | 592k | subscription | - |
| pitroom-verdict-and-doctor | B | pass | 140 s | 482k | subscription | 0 |
| pitroom-worker-names | A | pass | 114 s | 587k | subscription | - |
| pitroom-worker-names | B | pass | 165 s | 774k | subscription | 0 |

- Every run passed the hidden tests, in both arms and with both agents.
- **In arm B neither agent called Pitroom (0 workers in all six arm-B runs).** The solutions change 13 to 23 source lines
  (added plus removed), and Pitroom's guide says small work is faster done yourself.
- Token and cost differences between the arms go both ways and are noise at one run per cell.

So these tasks do not measure what Pitroom is for (reading and typing work worth handing to cheaper workers).
A fair test needs bigger tasks, several repeats and a budget for them; it has not been run.
