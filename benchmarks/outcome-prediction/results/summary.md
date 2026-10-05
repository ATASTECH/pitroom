# Outcome prediction: results

Data: 975 runs exported, 944 used (Pitroom's own test sandboxes and stopped runs left out): 144 from real use, 800 from benchmarks.

### Will the run fail? (any cause)

944 runs; train 660 (259 positive, 2026-09-29 on), test 284 (17 positive, 2026-10-01 on)

| Predictor | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 94.0% | 0.167 | 0.333 | 0.500 |
| per worker | 72.9% | 0.213 | 0.363 | 0.675 |
| same worker failed in the last 30 min | 88.4% | 0.107 | 0.157 | 0.718 |
| logistic regression (all features) | 90.8% | 0.064 | 0.093 | 0.793 |

### Will the run fail for a reason other than a rate limit or quota?

687 runs; train 480 (15 positive, 2026-09-29 on), test 207 (4 positive, 2026-10-01 on)

Too few positive cases to evaluate (at least 10 in each part are needed).

### Will the run fail? (real use only)

144 runs; train 100 (6 positive, 2026-09-29 on), test 44 (2 positive, 2026-10-03 on)

Too few positive cases to evaluate (at least 10 in each part are needed).

### Labels about the answer itself

- Finished runs whose references could be checked with the current checker: 129, of which 10 had a reference that did not check out.
- Audited runs: 20 (agree 16, partial 1, disagree 3, unclear 0).

