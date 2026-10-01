# Changelog

## Unreleased

- Scrolling boxes fade out at their edges while there is more to scroll (the expanded card, the result and diff blocks), and so does the window itself.
- "Saved" is labelled "Est. saved" with an (i) that says what it is: an estimate against the primary model's list price (`price` in `/api/state` and `/api/stats`), not money back.
- The dashboard's footer says it stops itself when left idle and how to stop it now.
- A dashboard left running serves the files of the build on disk: it re-reads them when they change, so an upgrade or rebuild no longer needs a restart to show up.
- The expanded run card keeps its header in place and scrolls the rest (a shadcn `ScrollArea`), and its close button sits in the card's corner.
- The Live filter and the Stats period use the same sliding-pill tabs as the page tabs; the history timestamp tooltip is the themed one and keyboard-focusable; scrollbars are thin and in the theme's colours.
- A review's card shows a short count of its findings instead of the raw verdict line, and its result starts at the findings.
- `pitroom savings --card` draws the card in the dashboard's look.

## 0.6.6

### Node.js 22.13 or newer
- Pitroom now needs Node.js 22.13+ (`engines`, the launcher, the CI matrix of 22 and 24, the build target). It is the first release line with a built-in SQLite (`node:sqlite`) that needs no flag, which the run history uses.

### History in SQLite
- Every finished run is written to `history.db` (built-in `node:sqlite`, FTS5): the task, worker and model, time, tokens, savings, the worker's steps, its answer and the diff, plus the whole record.
- `pitroom history [TEXT]` searches and filters (`--model`, `--state`, `--group`, `--since`, `--limit`, `--json`); `pitroom history stats` shows runs, success rate, average time and tokens per worker and model; `pitroom history import` takes in older runs (it also runs by itself on first use).
- After a run the raw event stream is compressed (about a sixth of its size) and the stderr log is kept only for runs that did not succeed. `pitroom clean` now keeps the history: `show`, `show --patch` and a short run id keep working for cleaned runs.
- The dashboard serves `/api/history` and `/api/stats`.

### A new dashboard
- `pitroom dash` is now a React app built from [shadcn/ui](https://ui.shadcn.com) components on [Base UI](https://base-ui.com), with [Shadix UI](https://shadix-ui.vercel.app)'s expandable card and [beUI](https://beui.dev)'s agent activity stream, and tabs: **Live** (running and recent runs as cards that grow, with a shared-layout animation, into a panel with the task, the worker's steps, the result, the diff and the details), **History** (full-text search and filters over the SQLite history, a table, a side panel per run) and **Stats** (success rate, time, tokens and savings per worker and model, runs per day). Light and dark themes.
- It is built once into `dist/ui` (esbuild and the Tailwind CLI, from `ui/`) and served as two static files; the CLI still has no runtime dependencies. The page's Content-Security-Policy allows only its own files and one hashed inline script.

### Seeing Pitroom in the Claude Code and Codex apps
- `pitroom dash` serves a live, read-only page of every run on `127.0.0.1` (state, worker and model, time, steps, tokens, savings, result; click a run for its report). `--detach` starts it in the background and prints the address (a running one is reused), `--stop` ends it, `--open` opens a browser, and it closes itself after four idle hours. The host must be `localhost`, `127.0.0.1` or `[::1]`, and only GET is answered.
- `pitroom watch --brief` prints one card line when a run starts, when it falls back and when it ends, then a total: made for Claude Code's Monitor tool and for a Codex command block.
- Click a card in the dashboard to see what the worker was asked (the task), what it did step by step (files read, searches, commands, edits, with times), its result, the files and diff it changed, and the details (model, tokens, cost, fallbacks, reference check). Runs can be searched and older ones loaded; `#run-id` in the address opens a card.
- Worker adapters record a step-by-step timeline from the event stream (`ParsedRun.timeline`).
- Cards name a range review by 9-character hashes instead of 40.
- The skills tell the agent to start the dashboard and give you its address when workers run in the background.

## 0.6.5

### Models, costs and effort
- `pitroom models [worker] [--all] [--json]` lists what Codex (from its model cache), Claude Code (aliases) and OpenCode (`opencode models`) offer, the effort levels each model accepts, your costs and what your own runs used (runs, average tokens, reported dollars).
- Config `costs` (`{"codex:gpt-6-sol": 1, "codex:gpt-6.1-sol": 2}`): your relative cost per model. Pitroom cannot know vendor prices, so it does not guess them; `pitroom doctor` prints the cost of the models in use and notes a cheaper one you priced.
- `--effort LEVEL` for every worker (`model#level`: Codex effort, Claude Code `--effort`, OpenCode variant). The skills tell the agent to pick the cheapest model and the lowest effort that fits.
- Fix: a target that names only an effort (`codex:#low`) skipped the configured `models` default and ran the vendor's own default model. It now gets the configured model with that effort. A Codex or Claude Code worker with no pinned model gets a warning.

### More workers, free first
- Up to 20 workers run at once by default (`maxParallel`), 30 at most; before, the default was 4. The rest queue and the fallback chain absorbs free-tier rate limits.
- An optional `review` tier in `tiers` names who reviews a run (and needs no same-backend warning). The skills start on the `cheap` tier, OpenCode's free model, and raise a task only when it needs more; plans are written the same way.

### Project files
- `THIRD_PARTY_NOTICES.md` carries the MIT notice of superpowers, which the workflow skills are adapted from, and ships in the npm package; the README stays clean and links to it.
- `CODE_OF_CONDUCT.md`, issue forms (bug report, feature request), a pull request template and a contact-link page for security reports.
- `npm run bump -- patch|minor|major|X.Y.Z` moves the version in `package.json`, `package-lock.json` (which still said 0.1.0) and both plugin manifests together and adds a CHANGELOG heading; a test fails while any file disagrees or the new CHANGELOG heading still has its placeholder text.

### README
- The workflow and the architecture are SVG diagrams (they render on GitHub and on npm, unlike mermaid). The speed gain is stated with measured numbers: 470 s of worker time in 156 s of wall clock.
- Install commands per agent as copy-and-paste blocks (Claude Code, Codex, npm), with update and uninstall; diagrams for the workflow and for how a run flows; the free-first setup, `pitroom models`, costs and effort are explained; the hard-coded version line is gone (the badges show the real versions).

### Seeing Pitroom at work
- The card hook also reaches the agent (`additionalContext`), so the user hears which worker and model ran even where the host shows no hook messages. Runs that finished without a card are announced on the next `pitroom` command.
- `pitroom savings --models` lists workers and models with runs, tokens, cost and savings.

## 0.6.4

### Deleting is the user's call
- `pitroom apply` (and `apply -g`) refuses a patch that deletes files unless you pass `--allow-delete`; nothing of the patch is applied. The run report flags deletions with a warning, for isolated runs and for `-w` runs (undo: `pitroom revert`).
- Workers are told to delete a file only when the task explicitly asks for it, to list every deleted file, and to propose any other deletion under OPEN ISSUES instead of doing it.
- The skills (`using-pitroom`, `pitroom-implement`, `pitroom-driven-development`, `pitroom-crew`) make the primary agent the decider: it sets each worker's permissions from the task and the user's session (read, isolate or write mode, `--web`), decides whether a deletion is wanted and passes `--allow-delete` itself, asking the user only when the worker deleted something that was not asked for. A fixed floor (no git history changes, no `sudo`, no publishing, no secrets) stays in place.

## 0.6.3

### Skills
- `pitroom-debugging` no longer bundles `find-polluter.sh`, an executable that ran the project's tests in a loop (a directory scan flagged it as a security risk). The test-pollution hunt is now a written procedure: bisect the test files by hand, in an isolated copy, with the project's own test command.

## 0.6.2

### Directory listing
- The Codex manifest no longer names other assistants or platforms in its name, descriptions and keywords (the OpenAI directory flags them), and carries an app icon (`assets/logo.svg`, `assets/icon.svg`) and a `privacyPolicyURL`.
- `PRIVACY.md`: what Pitroom stores and what reaches a worker's model provider.

## 0.6.1

### Install
- The Claude Code and Codex marketplace now installs the published npm package (under 0.5 MB, no dependencies) instead of copying the whole repository: before, `claude plugin install` also copied `src/` and `test/` and ran `npm install` for the development tools (39 MB). One `.claude-plugin/marketplace.json` serves both agents.
- The README has an install table per agent: Claude Code plugin, Codex plugin (skills only, no session-start hook, the `pitroom` command comes from npm) and npm with `pitroom install`.

### Directory listing
- The Codex manifest carries the listing fields the public plugin directory asks for (short description, developer, capabilities, links) and no longer declares `hooks`, which the directory does not accept.
- `docs/releasing.md` lists the release steps and how to submit to the Anthropic and OpenAI directories.

## 0.6.0

### Workflow skills
Pitroom now ships a complete development workflow, adapted from [superpowers](https://github.com/obra/superpowers) so that its subagents are Pitroom workers (Credits in the README): `pitroom-brainstorming`, `pitroom-writing-plans`, `pitroom-driven-development`, `pitroom-worktrees`, `pitroom-review`, `pitroom-receiving-review`, `pitroom-finishing`, `pitroom-debugging`, `pitroom-tdd` and `pitroom-verification`, next to `pitroom-research`, `pitroom-implement` and `pitroom-crew`. `using-pitroom` is the bootstrap for all of them. `pitroom doctor` warns when superpowers is installed too.

### Plan execution
- `pitroom run -i --plan PLAN --step N`: the worker gets the implementer rules, the plan's context and Global Constraints and exactly one task; its `STATUS:` line (DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED) is recorded. Runs join the plan's group.
- `pitroom review <run>`: a read-only reviewer, by default on another backend, reads one package (brief, report, diff with context) and returns SPEC and QUALITY verdicts. Reviewing a follow-up is a scoped re-review (previous findings, fix report, only the fix diff). `pitroom review --range A..B [--plan PLAN]` reviews a branch with the plan and the notes from execution.
- `pitroom plan status PLAN` rebuilds a plan's progress from the run records; `pitroom plan note PLAN "…"` records completions, deferred findings and rulings outside the repo.
- Config `tiers` (`{"cheap": "opencode", "standard": "codex", "capable": "claude"}`) and `--tier NAME`; plan tasks pick their tier with a `**Worker:**` line.

## 0.5.0

### New workers
- **Codex CLI** (`-W codex`, `codex:<model>`, `codex:<model>#<effort>`): `codex exec --json` with Codex's OS sandbox (`read-only` for read, `workspace-write` for write/isolate), approvals off, `~/.codex/config.toml` ignored (its MCP servers would run outside the sandbox), resume by session id, model read from the session's rollout file. Verified on real runs: read (sandbox refused a write), isolate + follow-up + apply.
- **Claude Code** (`-W claude`, `claude:haiku`…): `claude -p --output-format stream-json` with `--safe-mode --restricted --strict-mcp-config`, `--permission-mode dontAsk` and an explicit tool allowlist (`Read,Grep,Glob` for read; `+Edit,Write,Bash` with git/destructive commands disallowed for write), `.env`/key files denied, resume by session id, cost reported. `doctor` checks the login and warns about Opus-class defaults. Verified on real runs (`claude:haiku`): the read worker was granted exactly `Glob, Grep, Read` with no user MCP servers or plugins; isolate + follow-up in the same session + apply.
- Gemini CLI is recognised as "soon".
- Config `models`: a default model per worker (`{"codex": "gpt-6.1-sol", "claude": "claude-sonnet-5-5"}`) for targets that name none, including fallbacks; a model in the target or `-m` wins. `pitroom config` and `doctor` show it.
- Fallback chains cross backends (e.g. Claude Code logged out → OpenCode); a group can mix workers.

### Safety
- **Git guard layer 2** for every worker: git's own env config (`GIT_CONFIG_*`) installs a `reference-transaction` hook that refuses every ref update (commit, reset, branch/tag, stash, rebase, merge; `--no-verify` cannot skip it) and rewrites every push URL to an unreachable one. It holds where the PATH shim does not: login shells (Codex runs `zsh -lc`, macOS `path_helper` reorders PATH), absolute `/usr/bin/git`, scripts.

### Fixes
- Worker CLIs that are Node scripts (npm installs of Codex, OpenCode) run on Pitroom's own Node 18+, not whatever `env node` finds first on PATH.
- Run records from before pluggable workers no longer crash `pitroom ls`.

## 0.4.0

### OpenCode v2
- The OpenCode adapter targets OpenCode v2 (`doctor` fails on v1 with an upgrade hint).
- **Security fix:** every run uses `opencode run --standalone`. Without it, v2 attaches to the shared background service and the per-run permission profile and git guard would not apply to the worker. Asserted by the contract tests for every mode.
- Removed v1-only `--dir`; message passed last; `--log-level error`.
- Profiles: `shell` gets the same rules as `bash`; v2's `execute` tool (browser automation, OpenCode API) is denied; v2 scratch directories allowed.
- Parser: v2 events (no `tokens.total`, `{type, message, status}` errors, `Permission denied: <tool>`); default model from `debug config` sources; model of a run from `session export`.
- `403 FreeTierError` from OpenCode Zen free models counts as `auth`, so the fallback chain moves on.
- Workers run with `OPENCODE_DISABLE_AUTOUPDATE=1`.
- **Security fix:** v2 takes its workspace from `$PWD`, not the process cwd, so a worker could edit the directory pitroom was launched from instead of its isolated copy (or its `-d DIR`). Every worker now gets `PWD` set to its directory; the fake OpenCode used in tests reproduces the behaviour and the isolate tests fail without the fix.
- Real v2 streams recorded as contract-test fixtures.

### Crews (parallel workers)
- `pitroom crew [-i] -g NAME "task" …` starts several background workers as a group (`--task-file` with `---` separators).
- `pitroom watch [-g NAME] [--json]`: live table, or one JSON line per change (`queued`, `started`, `progress`, `fallback`, `done`…, `all-done`) for agents to follow.
- `pitroom wait` takes several runs or `-g NAME`, with `--any` and `--brief`; `status`, `ls`, `stop` and `apply` accept `-g NAME`. `apply -g` lands isolate patches in order and stops at the first conflict.
- Queue: at most `maxParallel` workers (default 4, `PITROOM_MAX_PARALLEL`) run at once; new state `queued`.
- Write lock: one `--write` run per repository; parallel changes use `--isolate`.

### Isolation
- `--isolate` now runs in a standalone repository that reads your objects through `alternates`, instead of a linked `git worktree`: nothing is written into your repository (no dangling commit, no worktree registration), and no worker CLI can map the copy back to your checkout. Removing it is deleting a folder.

### Skills and packaging
- The single skill became a pack: `using-pitroom` (when to delegate, which skill) plus `pitroom-research`, `pitroom-crew`, `pitroom-implement`, `pitroom-review`.
- Claude Code plugin (`.claude-plugin/`) with a SessionStart hook that injects `using-pitroom`; Codex plugin manifest (`.codex-plugin/`). `dist/` is committed so plugins work from a clone.
- `pitroom install` / `uninstall` replace `install-skill`: skills go to `~/.agents/skills` and `~/.claude/skills`, and a launcher to `~/.local/bin/pitroom` that picks a Node 18+ even when an older Node is first on PATH.
- `doctor` checks every skill, the launcher, and warns when the skills are installed both as links and as a plugin.

### Internals
- CLI split into `src/cli.ts`, `src/cli/args.ts`, `src/cli/commands.ts`.
- Reference verification: a range inside a named function counts for that function; identifiers between two references are not guessed.

## 0.3.0

- **Worker adapters**: the core (safety, snapshots, reference checks, receipts, fallback) no longer knows any particular CLI. Workers implement one `Backend` interface (`src/backends/types.ts`); OpenCode is the first adapter. Codex, Claude Code and Gemini CLI are designed for (see `docs/backends.md`) and will be added as adapters.
- **Targets** `backend[:model]` everywhere: `-W/--worker`, config `worker` and `fallback`, env `PITROOM_WORKER` / `PITROOM_FALLBACK`. Bare models still mean "the preferred worker's backend"; models containing `:` stay intact.
- Fallback chains may span backends; `--continue` stays on the backend that owns the session.
- Every worker runs through one process runner: closed stdin, git guard, recursion guard, timeouts.
- Adapter contract tests run automatically for every registered backend, against real recorded event streams.
- `doctor` shows the worker chain and how each worker enforces read-only runs.
- Breaking (pre-release): config `model`/`fallbackModels` → `worker`/`fallback`; `PITROOM_FALLBACK_MODELS` → `PITROOM_FALLBACK`; `PITROOM_OPENCODE` → `PITROOM_OPENCODE_BIN`.

## 0.2.0

- **Reference verification**: every `path:line` in the worker's answer is checked against disk (file exists, line/range in bounds, the named symbol is nearby) and summarised as `refs: N/M verified`.
- **Model fallback chain**: `fallbackModels` (config) / `PITROOM_FALLBACK_MODELS` (env); on "model not found", rate-limit, quota or provider-unavailable errors before any work was done, the run retries on the next model. `--no-fallback` disables it. Attempts are recorded and shown.
- **Git guard**: a `git` shim first on the worker's PATH blocks commit/push/reset/checkout/stash/clean/rebase/merge, index changes, ref deletion and similar, including through `sh -c`, `env`, scripts and aliases. Git never waits for a password, editor or pager.
- **Config file**: `~/.config/pitroom/config.json` (`model`, `fallbackModels`, `timeout`, `primary`, `price`, `link`, `web`) and `pitroom config` to show effective values and their source.
- **Web off by default**: `webfetch`/`websearch` need `--web`.
- `pitroom doctor` checks the config, the git guard and fallback models, and suggests free models from your own OpenCode catalogue.
- Runs that never reached a model are no longer counted in `pitroom savings`.

## 0.1.0

- First release: `pitroom run` in read / write / isolate modes, permission profiles injected per run, exact change tracking with revert/apply, background runs, receipts and `pitroom savings`, `pitroom doctor`, the `pitroom` skill.
