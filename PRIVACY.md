# Pitroom privacy policy

_Last updated: 2026-09-30_

Pitroom is a command-line tool and a set of agent skills that run on your own computer. This page says what data is involved, what for, who receives it, how long it is kept and what you can do about it.

## What the Pitroom authors collect

Nothing. Pitroom has no accounts, no analytics and no telemetry, and by default its own code makes no network requests. No data is sent to the authors.

**One request you can turn on.** With `"priceFeed": true` in the config (or `PITROOM_PRICE_FEED=1`; off by default) Pitroom keeps a price list of AI models up to date: at most once a day, in a background process after a run, it sends a plain `GET` for one public file (`https://models.dev/api.json` unless you set `priceFeedUrl`) and keeps a trimmed copy in its state directory. The request carries no data about you, your code, your tasks or your runs, and no cookie or account; like any web request it shows your IP address to the server that answers it. Nothing is fetched while the feed is off, and `pitroom prices` shows what it holds.

## Data categories and purposes

When you delegate work, Pitroom handles these categories of data, only to carry out that work:

| Data | Purpose |
|---|---|
| The task text you or your agent write | Tell the worker what to do |
| Files of your project that the worker reads, and its edits | Let the worker do the task; return an exact diff |
| For reviews, the diff under review with 10 lines of context | Let a second worker review the change |
| Run records: the task, the worker's answer, diffs, timings | Let your agent and you read results, apply or undo them |
| Savings ledger: token counts, cost estimates, worker and model names per run (no task text, no code) | Show what delegating saved |
| Settings you choose (`~/.config/pitroom/config.json`) | Remember your worker, models and tiers |

Project files may contain personal data of yours or of third parties; Pitroom does not look for it, filter it or add to it.

## Recipients

Pitroom starts a worker agent CLI that you installed and signed in to yourself. The task text, the files it reads and, for reviews, the diff go to that CLI and to the provider of the worker's model, under that provider's terms and privacy policy, not under this one. Pitroom does not filter this content: secrets committed in a reviewed range are sent as they are. The file-reading tools of OpenCode and Claude Code workers refuse `.env` files and private keys, but Codex workers are not restricted that way and a shell command can still read such files, so keep secrets out of the project folder you delegate in. To keep code on your machine, point the worker at a local model. Nobody else receives data from Pitroom.

## Where data is stored and for how long

- Run records and the savings ledger: `~/.local/state/pitroom`, or the folder named by `PITROOM_HOME`. Pitroom never deletes them by itself: they stay until you remove them.
- Private working copies of your project for isolated runs: inside the same folder, removed when you apply or discard the run.
- Settings: `~/.config/pitroom/config.json`, until you delete it.

Nothing is stored in your repository.

## Your controls

- `pitroom clean --yes` removes run records older than 14 days (change it with `--days N`); unapplied isolated patches are kept, and so is the savings ledger.
- Delete the state folder to remove everything, including the ledger; delete the settings file to reset your settings.
- `pitroom discard <run>` removes a run's private working copy.
- You choose which worker CLI and model receive your data (`-W`, `config`), and whether a worker may use the web (`--web`, off by default).

## Changes and contact

If this policy changes, the new version is published in this file with a new date. Questions and requests: <https://github.com/ATASTECH/pitroom/issues>.
