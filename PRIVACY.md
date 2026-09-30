# Pitroom privacy policy

_Last updated: 2026-09-30_

Pitroom is a command-line tool and a set of agent skills that run on your own computer. This page says what it does with your data.

## What the Pitroom authors collect

Nothing. Pitroom has no accounts, no analytics and no telemetry, and its own code makes no network requests. No data is sent to the authors.

## What happens when you delegate work

Pitroom starts a worker agent CLI that you installed and signed in to yourself. Whatever you ask a worker to do is handled by that CLI and by the model provider behind it:

- the task text you or your agent write;
- the files the worker reads in your project;
- for reviews, the diff under review with 10 lines of context, written to a package file the reviewer reads.

That data goes to the provider of the worker's model, under that provider's terms and privacy policy, not under this one. Pitroom does not filter the content it hands to a worker: secrets that are committed to a reviewed range are sent as they are. Workers cannot read `.env` files or private key files through Pitroom's permission profiles. To keep code on your machine, point the worker at a local model.

## What Pitroom stores on your computer

- Run records (the task, the worker's answer, diffs, receipts and the savings ledger) in `~/.local/state/pitroom`, or in the folder named by `PITROOM_HOME`.
- Optional settings in `~/.config/pitroom/config.json`.
- Private working copies of your project for isolated runs, inside the state folder. They are removed when you apply or discard a run.

Nothing is stored in your repository. To delete the records, run `pitroom clean` or remove the state folder.

## Changes and contact

If this policy changes, the new version is published in this file with a new date. Questions and requests: <https://github.com/ATASTECH/pitroom/issues>.
