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
checked out, its audit verdict). The task text stays out unless `--with-text` is given, and the data never
leaves `data/`. Reference results from before 2026-10-02 are dropped: the checker could not resolve bare file
names until 0.6.10, so its "file not found" then says nothing about the answer.

## Results (2026-10-05, 975 runs on one machine)

See [results/summary.md](results/summary.md) for the full tables.

| Will the run fail? (any cause) | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 94.0% | 0.167 | 0.333 | 0.500 |
| per worker | 72.9% | 0.213 | 0.363 | 0.675 |
| same worker failed in the last 30 min | 88.4% | 0.107 | 0.157 | 0.718 |
| logistic regression (all features) | 90.8% | 0.064 | 0.093 | 0.793 |

What the data says:

- **The one label with enough cases is about providers, not tasks.** 281 runs failed; 257 of them hit a rate
  limit or a quota. Failures came in bursts: 39% of the older runs failed, 6% of the newer ones. The baselines
  that rank them best use the worker and whether it just failed, which is what Pitroom's cooldown already does.
- **Failures for other reasons are too few to learn from:** 19 in 687 runs (model not available, timeouts, a
  crash). Real use alone has 144 runs with 8 failures.
- **Labels about the answer itself are too few:** 129 finished runs could have their references checked with the
  current checker, and 10 had one that did not check out; 20 runs were audited, 4 not with "agree".
- 800 of the 944 runs come from Pitroom's own benchmarks, which hammered free models on purpose.

So there is nothing here yet for a text classifier to learn: the failures are explained without the task text,
and the labels that depend on the answer number in the tens. A learned model would be worth trying with a few
hundred real-use runs carrying an answer-quality label, at least 50 of them negative: for example from a period
with a higher audit rate (`"audit": 0.5`), whose verdicts are such labels.

## Limits

One machine, one user, six days. The time split leaves the burst of rate limits almost entirely in the training
part, which is why the base rate is badly calibrated on the test part. Accuracy at 0.5 favours predicting "no
failure" when failures are rare; Brier, ECE and AUC are the numbers to compare.
