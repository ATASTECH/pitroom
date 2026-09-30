# Multi-repo benchmark

Nine bounded questions on three large public repositories (React, Django, Kubernetes), each
checked against `git grep` at a pinned commit. Results for the models in the main README are in
`results/`.

```bash
# 1. shallow clones at the commits in questions.json
mkdir -p ~/workspace/bench-repos && cd ~/workspace/bench-repos
git clone --depth 1 https://github.com/facebook/react.git
git clone --depth 1 https://github.com/django/django.git
git clone --depth 1 https://github.com/kubernetes/kubernetes.git   # about 400 MB

# 2. run a worker target on all nine questions (no fallback: a failing model stays failed)
node run.mjs --targets opencode:opencode/big-pickle,codex:gpt-6-sol#low --lanes 2

# 3. score every results/*.jsonl
node score.mjs --json results/scores.json
```

The scorer refuses to run if a clone is not at the commit the questions were written for (the
clones are shallow: use `git fetch --depth 1 origin <commit>` and check it out to pin them).

- `definition`: 1 for the exact `path:line`, 0.5 for the right file on another line.
- `count`: 1 only for the exact number.
- `set`: F1 of the listed paths against the real list.
- A run that hit a provider's rate limit or quota is **not measured** and is left out; any other
  unfinished run scores 0. An answer with nothing before `DETAILS` counts as not in the requested format.

Keep `--lanes` low for free providers: OpenRouter's free models share a daily request quota.
