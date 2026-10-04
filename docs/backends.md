# Worker backends

Pitroom's core does everything that must be true for every worker: closed stdin,
the git guard on `PATH`, recursion guard, timeouts and signals, snapshots and
isolated copies, exact change tracking, reference verification, receipts and
the fallback chain. A **backend** only translates between Pitroom and one worker
CLI. That keeps adapters small (OpenCode is ~150 lines) and makes it impossible
for a new adapter to skip a safeguard.

```
src/
  backends/
    types.ts            the Backend contract and shared types
    index.ts            registry
    opencode/           the reference adapter
      index.ts          invocation, failure classification, models, doctor
      events.ts         `--format json` stream → ParsedRun
      profiles.ts       read / write permission profiles
  core/                 lifecycle, process runner, prompt, refs, receipts, report
  vcs/                  git snapshots, isolated copies, git guard
```

## The contract

```ts
interface Backend {
  id: string;                 // "opencode", used in targets: "opencode:provider/model"
  name: string;
  capabilities: {
    readOnly: 'permission-rules' | 'os-sandbox' | 'tool-allowlist' | 'approval-mode';
    resume: 'by-id' | 'none';
    reportsCost: boolean;
    attachFiles: boolean;
  };
  binary(): string;                                     // PITROOM_<ID>_BIN > PATH > known install path
  invocation(req: WorkerRequest): Invocation;           // pure
  parse(stdout: string): ParsedRun;                     // pure, tolerant of a torn last line
  failure(run, stderr, exitCode): Failure | undefined;  // kind drives the fallback chain
  defaultModel?(): string | undefined;
  resolveModel?(sessionId: string): string | undefined;
  listModels?(): string[];
  doctor(ctx): DoctorCheck[];
}
```

`failure().kind` is `model-unavailable`, `rate-limited`, `auth` or `other`. Anything
but `other`, when the worker did no work, makes the core try the next target.

## Mapping Pitroom's modes

The core decides the mode; the adapter must make the CLI enforce it with the
CLI's **own** mechanism, and never with flags that switch safety off
(`--yolo`, `--dangerously-*`, `bypassPermissions`, `danger-full-access`,
`--auto`): the contract tests reject them.

| | read | write / isolate | resume | cost |
|---|---|---|---|---|
| **OpenCode v2** (`run --standalone --format json`) | permission profile: edit denied, shell allowlist, `execute` and web off | profile: edits on, history-changing git, bulk deletes and `execute` denied | `--session <id>` | reported |
| **Codex** (`exec --json --ignore-user-config`) | `-c sandbox_mode="read-only"` (OS sandbox) | `-c sandbox_mode="workspace-write"` (writes only in the working dir, no network), `approval_policy="never"` | `exec resume <id>` | tokens only |
| **Claude Code** (`-p --output-format stream-json --verbose`) | `--safe-mode --restricted --strict-mcp-config`, `--permission-mode dontAsk`, tools `Read,Grep,Glob` only | same lockdown, tools `+Edit,Write,Bash`, `--disallowedTools Bash(git commit:*)`… | `--resume <id>` | `total_cost_usd` |
| **Gemini CLI** (`--prompt … --output-format stream-json`) | `--approval-mode plan` (the policy engine allows read tools only) | `auto_edit` + Pitroom's `--policy` rules (shell minus history-changing git) | index/latest only → `resume: 'none'` | tokens only |

Whatever the CLI, the core still applies the git guard, closes stdin (Codex and
Gemini otherwise read piped stdin into the prompt), sets `PWD` to the worker's
directory, snapshots the tree and verifies references. `--isolate` runs in a
standalone repository that reads the user's objects through `alternates`
(not a `git worktree`), so no CLI can map it back to the user's checkout.

## OpenCode v2 notes

The OpenCode adapter targets OpenCode v2 (`doctor` fails on v1). What changed from v1, and why the adapter looks the way it does:

- **`--standalone` is a safety requirement.** A plain `opencode run` attaches to OpenCode's shared background service, which was started with its own environment. The per-run permission profile (`OPENCODE_CONFIG_CONTENT`), the git guard on `PATH` and `PITROOM_ACTIVE` would then never reach the worker. With `--standalone` each run gets a private server that inherits them; the contract tests assert the flag for every mode.
- **No `--dir`, and `$PWD` wins.** v2 takes its workspace from `$PWD`, not the process working directory. The core's process runner sets `PWD` to the worker's directory for every CLI; without it a worker started in an isolated copy edited the directory pitroom was launched from (found in a real crew run; the mock now reproduces it and the isolate tests fail without the fix).
- **Permissions**: v2 calls the shell tool `shell` (v1: `bash`); profiles set both keys to the same rules. The new `execute` tool reaches namespaced tools (browser automation, the OpenCode API itself) and is denied in both modes. `write`/`edit` take `path`.
- **Events**: `step_finish.tokens` has no `total` (summed from its parts); errors are `{type, message, status}`; a refused tool reports `Permission denied: <tool>`.
- **Models and sessions**: `debug config` lists config sources (the model is `{providerID, model}`), sessions are exported with `session export`, and model ids accept a `#variant` suffix.
- **Free tier**: OpenCode Zen free models can answer `403 FreeTierError` ("free tier can only be used from within OpenCode"). It is classified as `auth`, so the fallback chain moves on.
- **Auto-update**: workers run with `OPENCODE_DISABLE_AUTOUPDATE=1`, so a run never upgrades OpenCode underneath the user.

Recorded v2 streams live in `test/fixtures/opencode/{events,failures}/v2-*`; the v1 ones stay as parser regression tests.

## Codex notes

- **`--ignore-user-config`.** `~/.codex/config.toml` can define MCP servers, which run outside Codex's sandbox and could have side effects in a read-only run, and profiles that loosen the sandbox. Disabling servers one by one is not reliable (`-c mcp_servers.<name>.enabled=false` breaks on names containing dots or spaces), so workers ignore the file; auth still works. The model is the target's, or Codex's built-in default; `#effort` sets the reasoning effort (`codex:gpt-5.6-sol#low`, `codex:#low`).
- **Resume takes no `-s`/`-C`**, so the sandbox always goes through `-c sandbox_mode=…`; the tests assert it for new and resumed runs.
- **Login shells.** Codex runs commands through `zsh -lc`; macOS's `path_helper` and `~/.zprofile` reorder `PATH`, which hides the git-guard shim. The second guard layer (git's own env config: a `reference-transaction` hook and `pushInsteadOf`) holds regardless, for every worker.
- **Stream**: `item.completed` items of type `error` are warnings (deprecated settings, skills budget), not failures; failures are top-level `error` / `turn.failed`, whose message is a JSON API error. The JSON stream does not name the model, so it is read from the session's rollout file. Cost is not reported.
- **"Not supported when using Codex with a ChatGPT account"** comes back both for models the account cannot use and for models the installed Codex CLI is too old to know (seen with `gpt-6.1-sol` on 0.146, working on 0.159). It is `model-unavailable`, so the chain moves on, and the message suggests updating Codex.
- **Node**: `codex` is a Node script (`#!/usr/bin/env node`); Pitroom runs such CLIs on its own Node 22.13+, since agents' shells often have an older Node first on `PATH`.

## Claude Code notes

- **Lockdown** (see the table): `--safe-mode` keeps the user's CLAUDE.md, skills, plugins, hooks and MCP out; `--restricted` removes command-running tools unless listed, confines file tools to the working directory and refuses `bypassPermissions`; `--permission-mode dontAsk` denies anything outside the allowlist instead of prompting. The init event of a real run lists exactly `Glob, Grep, Read` for a read-only worker, no MCP servers, and only Claude Code's built-in plugins.
- **Not `--bare`**: it disables OAuth, which would break Claude subscriptions.
- **Argument order**: `--tools`, `--allowedTools` and `--disallowedTools` take lists; non-list options follow them and the prompt comes after `--`, so no list can swallow it.
- **Errors**: an API error arrives as an assistant message with `is_api_error_message` (e.g. `authentication_failed`, "OAuth session expired"); it is not counted as work, so the fallback chain can move on.
- **Model**: the init event names it. The user's default is often an Opus-class model; `doctor` warns and suggests `-W claude:haiku`.

## Gemini CLI notes

Status: **beta**, tried against Gemini CLI 0.62 with a Google AI Studio API key (`gemini-api-key`). Real runs are recorded under `test/fixtures/gemini` (a read run, an edit run, a retired model, a daily quota); the two older fixtures there (`read-flash`, `write-edit`) are constructed from the CLI's event types and cover a denied tool call.

What was checked live:

- **Read** runs (`--approval-mode plan`): files are read, and a write (`write_file`) is refused by the CLI ("Plan Mode").
- **Isolate / write** runs: edits land in the isolated copy only; the original is untouched. Shell commands matching `policies/gemini/shell.toml` (`git commit`, `git push`, `rm -rf`, `sudo`, other agents) are refused with Pitroom's message, others run.
- **Fallback**: a quota or retired-model failure is classified (`rate-limited`, `model-unavailable`) and the chain moves to the next worker.

What is **not** enforced, so do not rely on it:

- **Secret files.** `policies/gemini/base.toml` has deny rules for `.env`, `*.pem` and SSH keys, and the CLI loads them without errors, but in live tests Gemini 0.62 still read `server.pem` and `prod.env` (even a plain deny-all `read_file` rule was ignored). It does refuse a bare `.env`. What protects a Gemini read run is Pitroom's **read snapshot**: when the directory holds secret-looking files the worker reads a clean snapshot without them (checked live: the files come back as "File not found"). Edit runs (`-i`, `-w`) and reviews still rely on the worker being told not to read them, and Pitroom warns when such files sit there: for an isolated copy, git-ignore them.
- **Shell rules are prefix based** (an unusual spelling of a forbidden command may pass), and a shell `cat .env` is not caught. Use read mode (no shell) when that matters.
- **Web**: `no-web.toml` denies `google_web_search` and `web_fetch` unless `--web`; this was not verified live.

How a worker is started:

- **`--approval-mode plan`** is the read-only mode; write and isolate use `auto_edit`. Never `--yolo` (the contract tests reject it and the worker settings disable it).
- **`--policy policies/gemini/*.toml`**: `base.toml` (secret rules above, MCP refused), `no-web.toml`, and `shell.toml` for write and isolate (shell is allowed, since a headless run cannot answer "ask the user", minus the forbidden commands). Gemini's loader rejects a rule without `toolName` and any regex it thinks could be slow (nested quantifiers), which skips the whole file: `npm test` checks the patterns, and a live run with the file is the final check.
- **A private `GEMINI_CLI_HOME`** (`<pitroom home>/gemini-home`): its settings come from `policies/gemini/worker-settings.json` plus your sign-in method (`security.auth`), with links to your `oauth_creds.json`. Your hooks, MCP servers, skills and global `GEMINI.md` are therefore not loaded (hooks would run on every worker; a worker also starts with ~20k fewer tokens). An API key kept in the keychain keeps working. A system settings file would be the usual place, but Gemini CLI 0.62 ignores one that root does not own. `-e none` turns extensions off, and the MCP allow list names a server nothing has (an empty list means "no restriction" there).
- **Folder trust**: a headless run in a folder Gemini does not trust fails. Folders you trusted in Gemini stay trusted. `PITROOM_GEMINI_TRUST=1` adds `--skip-trust`, which also lets that folder's own `.gemini` settings (hooks included) load.
- **Stream**: `message` events carry the answer in `delta` chunks, merged per model turn; the answer is the text after the last tool call. `result.stats` gives tokens (`cached` is part of `input_tokens`), not dollars. Lines that are not JSON are skipped.
- **Models**: Gemini CLI cannot list models; the catalogue is its built-in names (`gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, …). The 2.5 models are no longer served to new API keys. Its own default (`auto`) may be a larger model, so pin a worker, e.g. `-W gemini:gemini-3.8-flash`. The free tier has a small daily quota per model. No effort option: `#level` is dropped.
- **Resume**: sessions are chosen by index or `latest` per project, which is not safe with parallel workers, so `--continue` is not supported (`resume: 'none'`).
- **Sign-in**: a Google account sign-in (`oauth-personal`, Code Assist for individuals) is refused by Google for this client (`IneligibleTierError`); use an API key from Google AI Studio (`gemini` stores it, or set `GEMINI_API_KEY`).

## Adding a worker

1. Create `src/backends/<id>/index.ts` exporting a `Backend`; keep CLI knowledge
   (flags, event format, error wording, model listing) in that folder.
2. Register it in `src/backends/index.ts` (and drop the id from `PLANNED`).
3. Record real fixtures under `test/fixtures/<id>/`:
   - `events/*.jsonl`: stdout of real runs (one read, one write), home paths replaced;
   - `failures/<name>.stdout.jsonl` + `.stderr.log`: e.g. an unknown model;
   - `expected.json`: session id, step count, token total, answer prefix, failure kinds.
4. `npm test`: `test/backends.test.mjs` runs the contract suite against every
   registered backend automatically (capabilities, no bypass flags, read ≠ write,
   prompt in argv, optional model/session/files, parsing, failure classification).
5. Add an end-to-end mock for the CLI if its behaviour differs materially, and a
   row to the table above and to the README.
