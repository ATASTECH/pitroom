# Pitroom review on pull requests

The repository is also a GitHub Action. On each push to a pull request it runs `pitroom review --range BASE..HEAD` with a worker you choose (a free model is enough for a first pass), read-only, and puts the review in the job summary and in **one** pull request comment, updated on every push. The step can fail on critical (or important) findings, so a review can be a required check.

```yaml
# .github/workflows/pitroom-review.yml
name: pitroom review
on: pull_request

permissions:
  contents: read
  pull-requests: write # the comment

jobs:
  review:
    # Never for a pull request from a fork: its code would sit next to your worker's API key, and a worker that
    # reads it could be talked into sending the key somewhere. Forks' runs get no secrets anyway.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the review reads the commits between base and head
      - run: npm install --global opencode-ai # your worker's CLI
      - uses: ATASTECH/pitroom@v0.29.0 # pin a release
        with:
          worker: opencode:opencode/big-pickle
          fail-on: critical
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }} # however your worker CLI signs in on a server
```

## Inputs

| Input | Default | |
|---|---|---|
| `worker` | opencode, its default model | `backend[:model]`, as for `pitroom review -W`. Install and sign in its CLI in an earlier step. |
| `range` | the pull request, `base..head` | Any `A..B` git understands. |
| `fail-on` | `never` | `critical`, `important` (critical or important) or `never`. A review that cannot finish (the worker failed, no verdict) fails the step too, unless `never`, where it is a warning. |
| `comment` | `true` | Post the review as one comment, found again by a hidden marker and updated. With a read-only token (a fork) it says so in a warning; the job summary still has the review. |
| `github-token` | `github.token` | Needs `pull-requests: write` for the comment. |
| `node-version` | `24` | Pitroom needs Node.js 22.5 or later (`node:sqlite`). |

Outputs: `run` (the review's run id), `spec` (`pass`, `fail`), `quality` (`approved`, `needs-fixes`), `critical`, `important`.

## What it does and does not do

- The reviewer is a read run: it gets the numbered diff and reads the files it needs. It does not change the checkout, and it never commits or pushes (the git guard applies as on your machine).
- Every `path:line` the review cites is checked against the checkout, as for any run; the report says how many held.
- The worker's text goes into the comment inside a code fence, so nothing it writes is rendered as a link, an image or a mention.
- Pitroom's records live in the runner's temp folder and go with the job. There is no Pitroom service: the only network traffic is your worker CLI's and the comment.
