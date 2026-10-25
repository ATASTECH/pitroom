# Outcome prediction: is there anything for a learned model to learn?

Small classifiers that return a typed decision with a calibrated confidence (for example a fine-tuned
multilingual encoder) could, in principle, tell Pitroom before a run whether it will fail, whether its answer
will hold up, or whether an audit is worth running. Before trying one, this experiment asks what Pitroom's own
history can support, using simple baselines a learned model would have to beat.

## Run it

```bash
node export.mjs        # reads <state dir>/history.db (read-only), writes data/runs.jsonl (git-ignored)
node baseline.mjs      # time-ordered split: the older 70% to fit, the newer 30% to test
node baseline.mjs --write   # also saves results/summary.md
```

`export.mjs` keeps, per run, only what is known when it starts (worker, mode, kind, task length, whether the
same worker failed in the 30 minutes before) and how it ended (failed or not and why, whether its references
checked out, its audit verdict, and for a change the first review's verdict). The task text stays out unless `--with-text` is given, and the data never
leaves `data/`. Reference results from before 2026-10-02 are dropped: the checker could not resolve bare file
names until 0.6.10, so its "file not found" then says nothing about the answer.

## Results (2026-10-25, 1,455 runs on one machine: 572 from real use, 883 from benchmarks)

See [results/summary.md](results/summary.md) for the full tables. The first run (2026-10-05, 944 runs) is in the git
history of that file.

| Question | Positive | Best predictor | Brier (constant → best) | AUC |
|---|---|---|---|---|
| Will the run fail? (any cause) | 358 of 1,455 | logistic regression | 0.158 → 0.135 | 0.62 |
| Will it fail for a reason other than a rate limit? | 51 of 1,148 | per worker | 0.080 → 0.080 | 0.70 |
| Will it fail? (real use only) | 65 of 572 | same worker failed in the last 30 min | 0.152 → 0.149 | 0.58 |
| Will a finished answer cite a file or line that does not check out? | 125 of 483 | per worker | 0.215 → 0.136 | 0.85 |
| Will an audit dispute the answer? | 19 of 49 | too few to split by time | | |
| Will a review send a change back? | 30 of 73 | too few to split by time | | |

What the data says:

- **Whether a run fails is still about providers, not tasks.** With three times the runs, nothing predicts a real-use
  failure much better than its base rate; most failures are rate limits and quotas, which the cooldowns handle.
- **Who answers predicts whether the answer's references hold up** (AUC 0.85, against 0.5 for the base rate): in real
  use, Codex `gpt-6.1-sol` had a reference that did not check out in 4% of its answers, `beam-free` in 19%,
  `space-bunny` in 41%, Antigravity `gemini-3.8-flash` in 42% and Claude `sonnet-5-5` in 83%. That label measures the
  checker too, though: many of the failed references name a file without its folder (`cua-driver.test.ts:1440`) or a
  file outside the project, and the checker may have looked at another file of that name or none. Before it ranks
  workers (`rankWorkers` uses the share of runs that ended well and of checked work that held up), the checker's share
  needs separating from the worker's.
- **The labels from another worker (audits, reviews of changes) number in the tens**, and a split by time leaves fewer
  than 10 positive cases to test on. `"audit": 0.5`, with an audit tier that answers, collects them.

So a learned text model is still not worth training: the failures are explained without the task text, the one
plentiful answer-quality label is mostly "which worker", and the labels about the work itself are too few.

## Limits

One machine, one user, four weeks. The time split puts the older 70% in training: rate-limit bursts and the workers
in use change over the weeks, so the test part is not like the training part, which is what the predictors face in
real use too. Accuracy at 0.5 favours predicting "no
failure" when failures are rare; Brier, ECE and AUC are the numbers to compare.
