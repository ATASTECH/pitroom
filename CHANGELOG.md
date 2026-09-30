# Changelog

## 0.5.0

### New workers
- **Codex CLI** (`-W codex`, `codex:<model>`, `codex:<model>#<effort>`): `codex exec --json` with Codex's OS sandbox (`read-only` for read, `workspace-write` for write/isolate), approvals off, `~/.codex/config.toml` ignored (its MCP servers would run outside the sandbox), resume by session id, model read from the session's rollout file. Verified on real runs: read (sandbox refused a write), isolate + follow-up + apply.
- **Claude Code** (`-W claude`, `claude:haiku`…): `claude -p --output-format stream-json` with `--safe-mode --restricted --strict-mcp-config`, `--permission-mode dontAsk` and an explicit tool allowlist (`Read,Grep,Glob` for read; `+Edit,Write,Bash` with git/destructive commands disallowed for write), `.env`/key files denied, resume by session id, cost reported. `doctor` checks the login and warns about Opus-class defaults.
- Gemini CLI is recognised as "soon".
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
