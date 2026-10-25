# Outcome prediction: results

Data: 1538 runs exported, 1455 used (Pitroom's own test sandboxes and stopped runs left out): 572 from real use, 883 from benchmarks.

### Will the run fail? (any cause)

1455 runs; train 1018 (278 positive, 2026-09-29 on), test 437 (80 positive, 2026-10-13 on)

| Predictor | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 81.7% | 0.158 | 0.090 | 0.500 |
| per worker | 75.1% | 0.162 | 0.081 | 0.586 |
| same worker failed in the last 30 min | 81.9% | 0.148 | 0.084 | 0.652 |
| logistic regression (all features) | 85.1% | 0.135 | 0.114 | 0.619 |

### Will the run fail for a reason other than a rate limit or quota?

1148 runs; train 803 (22 positive, 2026-09-29 on), test 345 (29 positive, 2026-10-14 on)

| Predictor | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 91.6% | 0.080 | 0.057 | 0.500 |
| per worker | 91.6% | 0.080 | 0.068 | 0.699 |
| same worker failed in the last 30 min | 91.6% | 0.080 | 0.056 | 0.561 |
| logistic regression (all features) | 91.6% | 0.082 | 0.069 | 0.657 |

### Will the run fail? (real use only)

572 runs; train 400 (35 positive, 2026-09-29 on), test 172 (30 positive, 2026-10-20 on)

| Predictor | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 82.6% | 0.152 | 0.087 | 0.500 |
| per worker | 82.6% | 0.154 | 0.129 | 0.595 |
| same worker failed in the last 30 min | 82.6% | 0.149 | 0.087 | 0.575 |
| logistic regression (all features) | 82.6% | 0.158 | 0.133 | 0.531 |

### Will a finished answer cite a file or line that does not check out?

483 runs; train 338 (81 positive, 2026-10-02 on), test 145 (44 positive, 2026-10-21 on)

| Predictor | Accuracy | Brier | ECE | AUC |
|---|---|---|---|---|
| constant (base rate) | 69.7% | 0.215 | 0.064 | 0.500 |
| per worker | 82.1% | 0.136 | 0.059 | 0.846 |
| same worker failed in the last 30 min | 69.7% | 0.216 | 0.064 | 0.501 |
| logistic regression (all features) | 82.8% | 0.154 | 0.133 | 0.796 |

### Will an audit dispute the answer? (any verdict but "agree")

49 runs; train 34 (9 positive, 2026-09-30 on), test 15 (10 positive, 2026-10-04 on)

Too few positive cases to evaluate (at least 10 in each part are needed).

### Will a review send the change back? (spec not met, or fixes asked)

73 runs; train 51 (24 positive, 2026-09-30 on), test 22 (6 positive, 2026-10-21 on)

Too few positive cases to evaluate (at least 10 in each part are needed).

### Labels about the answer itself

- Finished runs whose references could be checked with the current checker: 483, of which 125 had a reference that did not check out.
- Audited runs: 50 (agree 30, partial 15, disagree 4, unclear 1).
- Reviewed changes: 73 (approved 43, sent back 30).

