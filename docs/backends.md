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
    readOnly: 'permission-rules' | 'os-sandbox' | 'tool-allowlist' | 'approval-mode' | 'snapshot';
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
| **Gemini CLI** (`--prompt … --output-format stream-json`) | `--approval-mode plan` (the policy engine allows read tools only) | `auto_edit` + Pitroom's `--policy` rules (shell minus history-changing git) | by session id (`--resume <id>`) → `resume: 'by-id'` | tokens only |
| **Qwen Code** (`<prompt> --safe-mode --output-format stream-json`) | `--approval-mode plan` (edits, shell and reads outside the working directory declined) | `--approval-mode default` + `--allowed-tools Edit(./**) write_file(./**) notebook_edit(./**) run_shell_command`, shell minus history-changing git via `--exclude-tools` | `--resume <id>` | tokens only |
| **Kilo Code** (`kilo run --format json`) | OpenCode's read profile through `KILO_CONFIG_CONTENT` | OpenCode's write profile | `--session <id>` | reported |
| **Antigravity CLI** (`agy -p … --output-format stream-json --sandbox`) | a read-only **snapshot of its own** (agy has no read-only mode for `-p`), plus `--mode plan` and Pitroom's deny rules | `--mode accept-edits`, shell in agy's terminal sandbox, the same deny rules | `--conversation <id>` | tokens only |

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
- **Resume**: `--resume` takes the session id that the stream's `init` event reports (checked live on 0.62: the follow-up remembered what the first run read), as well as an index or `latest` (which are not safe with parallel workers, so Pitroom never uses them). `--continue` therefore works (`resume: 'by-id'`). Sessions are kept per project folder, so a follow-up runs in the same folder as its parent, which Pitroom does anyway.
- **Sign-in**: a Google account sign-in (`oauth-personal`, Code Assist for individuals) is refused by Google for this client (`IneligibleTierError`); use an API key from Google AI Studio (`gemini` stores it, or set `GEMINI_API_KEY`).

## Qwen Code notes

Status: **beta**, checked against Qwen Code 0.25.0. The fixtures in `test/fixtures/qwen` were recorded from the real CLI, started with Pitroom's own command line, against a **scripted OpenAI-compatible endpoint** (a small local server that answers with prepared tool calls and text): the events, permission decisions, refusals and error output are the CLI's, the model is not. It has not yet been run against a real model provider.

What was checked that way:

- **Read** runs (`--approval-mode plan`): `read_file`, `grep_search` and `glob` work; `write_file`, `run_shell_command` and a read outside the working directory are declined.
- **Write / isolate** runs: edits and new files inside the working directory land; an edit or a new file outside it (the user's real checkout from an isolated copy, another folder, a `../` path) is declined; `git commit` and `rm -rf` are refused by Pitroom's deny rules; other shell commands run. End to end (`pitroom run -i -W qwen:…`): the changes come back as the isolated copy's patch and the user's tree is untouched.
- **`--continue`**: `--resume <session id>` (the id of the stream's `init` event) sends the earlier turns along.
- **Failures**: a bad key (401, `auth`), an unknown model (404, `model-unavailable`) and a used-up quota (429, `rate-limited`) are classified, did no work, and let the chain move on.

How a worker is started, and why:

- **Not `--approval-mode auto-edit`.** It approves an edit *anywhere on disk*: in a test an isolated run edited the user's real checkout and wrote to `/tmp`. `default` declines whatever is not allowed (a headless run cannot ask), and the allow rules name edits inside the working directory only (`./**` is relative to the CLI's cwd, which the core sets to the isolated copy or the project).
- **`--safe-mode`** keeps the user's QWEN.md, hooks, extensions, skills and MCP servers out, and turns off the **background memory extraction**: without it, every run ends with an extra request in which a subagent with `write_file` and `edit` writes "durable facts" from the run into `~/.qwen/memories` (user-wide) and the project's memory folder.
- **`--exclude-tools`**: even in plan mode Qwen Code runs `enter_worktree` (it made a git worktree and a branch in the project in a test), and it has subagents, memory, cron, messaging and goal tools. They are excluded in every mode, and `web_fetch` / `web_search` unless `--web`. An excluded tool the model calls anyway is declined, with a message the model sees.
- **The prompt is the first argument**: `--exclude-tools` and `--allowed-tools` take every following word, and Qwen Code reads no prompt after `--`. A prompt that starts with `-` gets a leading space.
- **`QWEN_CODE_SYSTEM_DEFAULTS_PATH`** points at `policies/qwen/worker-defaults.json`: no auto-update, no memory extraction, and `maxRetries: 0`, which removes the CLI's 10 × 60 s waits on a rate limit. Its other retry layer (7 tries with backoff) stays, so a used-up quota surfaces after about 80 s, not 10 minutes. These are *defaults*: the user's own settings win, and an enterprise system settings file is left alone. `QWEN_CODE_DISABLE_CRON=1` and `QWEN_DISABLE_AUTO_TITLE=1` are set too.
- **Sign-in and model** come from the user's `~/.qwen/settings.json` (`security.auth.selectedType`, `model.name`) and environment (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, …); `-W qwen:<model>` passes `--model`. There is no effort option: `#level` is dropped. Cost is not reported (tokens only): give it a price with `workerPrices`.

What is **not** enforced, so do not rely on it:

- **Secret files.** `read_file` reads `.env` inside the working directory. What protects a read run is Pitroom's **read snapshot** (a directory with secret-looking files is read as a clean snapshot without them); edit runs rely on the worker being told not to read them.
- **The shell is not confined.** An allowed shell command can write outside the working directory, as with the other workers that have a shell; the git guard still holds, and the deny rules are prefix based.

## Kilo Code notes

Status: **beta**, checked against `@kilocode/cli` 7.8.8. Kilo Code's CLI is a fork of OpenCode: the same `run --format json` events, agents and permission rules, so the adapter reuses OpenCode's profiles and parser. Like the Qwen Code fixtures, `test/fixtures/kilo` was recorded from the real CLI, started with Pitroom's own command line, against a **scripted OpenAI-compatible endpoint**; not yet with a real provider.

What was checked that way, with a `kilo daemon` running:

- **Read** runs: `read` and `grep` work; the edit tools are not offered at all, and `bash`, a `.env` read and a read outside the project are refused by the profile.
- **Write / isolate**: edits and new files inside the project land; a write outside it and `git commit` are refused. End to end (`pitroom run -i -W kilo:…`), the change comes back as the isolated copy's patch and the user's tree is untouched.
- **`--continue`**: `--session <id>` sends the earlier turns along.
- **Failures**: an unknown model (`model-unavailable`), a bad key (`auth`) and a used-up quota (`rate-limited`, after about 80 s of the CLI's own retries) did no work, so the chain moves on.

How a worker is started, and why:

- **`KILO_CONFIG_CONTENT`**, not `OPENCODE_CONFIG_CONTENT`: Kilo reads its own variable (checked with `kilo debug config`). The profiles' scratch-folder rules point at Kilo's folders (`~/.local/share/kilo/…`, `$TMPDIR/kilo/…`), and the config sets `autoupdate: false`.
- **A private `XDG_STATE_HOME`** (`<pitroom home>/kilo-state`). `kilo run` has no `--standalone`: when the user's `kilo daemon` is up, it attaches to it (found through `~/.local/state/kilo/daemon.json`), and the daemon, started with its own environment, ignores the injected config, the git guard and `PITROOM_ACTIVE` (seen: "Agent not found: pitroom-read"; `--port` and `--pure` do not prevent it). With a state folder of its own the worker finds no daemon and starts a private server. Sign-in, config and sessions live in the data and config folders, which stay the user's.
- **`--log-level ERROR`** in capitals: Kilo rejects `error` and prints its help instead of running.
- Never `--auto` ("auto-approve permissions that are not explicitly denied"), never `--attach`.

## Antigravity CLI notes

Status: **beta**. Checked against **agy 1.3.5** on macOS (October 2026): a read run, a follow-up, an isolated edit, shell commands in the sandbox, the deny rules, an unknown model, a used-up quota and a missing sign-in were run against the real CLI, and `test/fixtures/antigravity` holds their recorded output (home paths replaced). Not yet checked on Linux (the sign-in file link) or Windows (`doctor` says to use `-i` there).

Why it is here: Google refuses a Google account sign-in to Gemini CLI (`IneligibleTierError`, "migrate to the Antigravity suite"), so for someone without an AI Studio key, `agy` is the way to use their Google account's models (Gemini, and the Claude and GPT-OSS models Antigravity offers).

How a worker is started, and why:

- **`-p <prompt> --output-format stream-json`**: one prompt, a JSON event stream, exit. `-p` takes the prompt as its value; a prompt that starts with `-` gets a leading space.
- **Read runs read a snapshot of their own** (`readOnly: 'snapshot'`). agy has no read-only mode for `-p` runs (issue 45 of google-antigravity/antigravity-cli), and `--mode plan` is reported to still write in them (issue 1181: the file is created in the same turn). So the core never lets Antigravity read the project: right before its attempt it makes the run a snapshot of its own (`snapshots/<tree>-<run id>`, made like the shared clean snapshot: from git objects, uncommitted and untracked files included, secret-looking and ignored files left out, files read-only), whatever `readIn` says. Not the shared one: directories there stay writable, so a new or replaced file would be seen by every later read run on the same state. Its follow-ups read the same snapshot. After the attempt, whatever git sees newly changed there is reported as `READ-ONLY VIOLATION` (the stream need not mention it; a follow-up is not blamed for its parent's writes), and the answer is not cached. A worker after it in the chain reads where it was meant to (the project or the shared snapshot), never Antigravity's, and a second Antigravity target gets a fresh snapshot if the first wrote in its own. As a fallback it costs nothing until it runs. These snapshots are full checkouts: pruning keeps the newest few of them apart from the shared ones, so a burst of Antigravity runs does not push those out, and a follow-up whose snapshot was pruned gets it made again from the same tree. If the snapshot cannot be made, Antigravity is skipped like a failed attempt (the next worker runs, or the run fails: as the worker before it failed, a rate limit staying one, or, when no worker ran at all, without counting against any worker's record); it never falls back to the project. `--in-place`, reviews (whose package lives in the git folder) and folders outside git read the directory itself, with a warning. `pitroom doctor --probe` runs it in an empty temporary folder. `--mode plan` is passed anyway; write and isolate use `--mode accept-edits`. Never `--dangerously-skip-permissions` (the contract tests reject it).
- **`--sandbox`** in every mode: shell commands run in agy's terminal sandbox (the workspace writable, its `.git` read-only, `.env` and `~/.ssh` unreadable, no network). The sandbox and the permission rules are for macOS and Linux; on Windows agy still uses its previous permission system, and `doctor` says to use `-i` there.
- **A home of its own per workspace.** agy reads its settings only from `~/.gemini/antigravity-cli/settings.json` (and its permissions from `~/.gemini/config`); `ANTIGRAVITY_APP_DATA_DIR` and every other variable tried leave its data folder where it is (its log says `CLI app data directory: …`). So a worker runs with `HOME` set to `<pitroom home>/antigravity-home/<id>`, one per workspace (the run's snapshot, its isolated copy, or the project for `-w`), where Pitroom writes `settings.json` (atomically: a parallel worker never reads half a file). The sign-in is linked in: on macOS agy finds it in the login keychain through `$HOME/Library/Keychains`, which is linked to yours; elsewhere it is the file `antigravity-oauth-token`, linked from `~/.gemini/antigravity-cli` (and a dangling link is repaired). Conversations stay in that home, so a follow-up, which runs in the same workspace, finds its own; homes not used for two weeks are removed. The worker's commands see that home too: your dotfiles are out of their reach, your own agy settings, plugins and MCP servers do not apply, and agy picks its default model unless `-W antigravity:<model>` names one. The settings: `enableTerminalSandbox`, `toolPermission: proceed-in-sandbox` and the grant `command(*)` (a headless run cannot answer a prompt: an ungranted command is refused, and the turn may end without an answer), `artifactReviewPolicy: always-proceed`, `allowNonWorkspaceAccess: false`, `write_file` for its own `brain` folder (plan mode writes its plan there, outside the workspace), `read_file` for the folders of your PATH under your home (the sandbox sees only the system and what is granted: without it an nvm `node` is `Operation not permitted`; a `bin` in a versioned install brings the install along, other folders only themselves, as `~/.cargo` holds credentials), and deny rules (deny beats allow): the workspace's secret-looking files and the secrets in your home (`.ssh`, `.aws`, `.gnupg`, `.netrc`, `.config/gh`, …) by absolute path, the shared forbidden commands (`src/backends/deny.ts`), `mcp(*)`, `read_url(*)` and `execute_url(*)`.
- **How agy matches the rules**, as seen in 1.3.5 (its docs say only "prefix, word by word"): `read_file` takes an absolute path or one relative to the workspace, as a folder prefix, and no pattern; a `regex:` target is not read, and a relative path breaks the sandbox (`sandbox configuration error: … non-absolute file path`) without denying anything, so secret files are listed one by one. A `command` rule is compared word by word with the start of each command in the line, after agy has split it at `;`, `&&`, `||` and `|` and taken off wrappers such as `env -i` and `timeout 60` (but not `xargs`, and not what find runs with `-exec`). A `regex:` command rule is split at spaces too, each word a regex for one word (`.*` is exactly one word), and backslashes are dropped. A line with `{}` in it is not split: a rule is matched against the whole line, start to end. The rules are built for that: each forbidden command as it is and by path, git behind its global options, a recursive `rm` wherever its option stands, `sh -c` and `eval`, find with `-exec`, `-ok` or `-delete` refused outright (a rule for what it runs only holds when it spans the whole line), xargs running a forbidden command, and, for lines with `{}`, `git <subcommand>`, `rm -r`, xargs and find anywhere in them. `test/backends.test.mjs` checks them with that matching; they remain pattern rules, and the git guard is what holds for git whatever the spelling (`.git` is read-only in the sandbox too). One settings file serves every mode, since a follow-up may run in another: so **`--web` does not apply** to Antigravity workers.
- **`--print-timeout 24h`**: agy's docs give its own limit as 5 minutes (1.3.5's help says none), and a run that hits it ends with partial output; Pitroom's timeout governs instead.
- **Model**: `-W antigravity:<model>` passes `--model` (`agy models` lists yours), and `#level` passes `--effort`. Without one, agy picks. Its quota is per Google account and can run out for hours: give it a fallback.
- **`--continue`**: `--conversation <id>` with the id of the stream's `init` event, never `-c` (the latest conversation, which is unsafe beside parallel workers).

The stream, as agy 1.3.5 writes it: every line is `{"event": "init" | "step_update" | "result", …}` with the payload under the event's name. `init.model` names the model when `--model` was given. `step_update.step_type` is `user_input`, `agent_response` (text in `text_delta` chunks), `tool` (`tool_name`, and `tool_info` with the tool's name, parameters and `output`, or `error: {type, message}`), `checkpoint` or `error_message`; `state` is `ACTIVE`, `DONE`, or `ERROR` for a failed or refused call. The answer is `result.response`; tokens are `result.usage` (`input_tokens` with `cache_read_tokens` inside it, `output_tokens`, `thinking_tokens`, `total_tokens`), or the sum of the finished steps' own usage when a run is cut short; `result.denied_actions` lists calls refused for want of a grant. Tools are agy's own names: `run_command` (`CommandLine`) is the shell, `view_file` (`AbsolutePath`) reads, `write_to_file`, `replace_file_content` and `multi_replace_file_content` (`TargetFile`) are edits. Every field is read tolerantly.

Failures, as recorded. A command refused for want of a grant ends the turn with **status `SUCCESS`, no answer and exit 0**, and a stderr line (`jetski: no output produced — a tool required the "command" permission …`); a command refused by a deny rule usually lets the agent answer that it was refused. So an Antigravity run without an answer is always a failure, never an empty answer. A used-up quota exits 3 with `result.status: ERROR` (`Individual quota reached … Resets in 2h23m`) and an `AGY_ERROR: {"short_error": "RESOURCE_EXHAUSTED (code 429): …"}` line on stderr: `rate-limited`, so the chain moves on; it can hit one model (Claude Opus) while another (Gemini Flash) still answers. An unknown model exits 1 (`is not recognized as a known model`): `model-unavailable`. No sign-in waits 60 seconds for a browser sign-in, then exits 1 (`authentication failed or timed out`): `auth`.

Known agy problems Pitroom cannot work around: a follow-up whose conversation id agy does not know starts a new conversation (stderr: `warning: conversation "…" not found`), which the run shows as a warning, as the earlier turns are then missing; a turn can end while a `run_command` it started is still running, which is then killed (issue 1044); a subagent's output may not reach the stream (issue 1077). A model can also refuse a task by itself (reading `.env`, or a `git commit` the worker contract forbids) before agy's rules come into it.

What is still open: Linux (the token file link, the secret-service keyring) and Windows. A stronger guard would be a `PreToolUse` hook that denies (agy honours a hook's `deny` in `-p` runs, issue 1053, though not its `allow`); the worker home would be the place for its `hooks.json`.

## Hermes Agent: not supported yet

[Hermes Agent](https://pypi.org/project/hermes-agent/) (Nous Research; looked at 0.19.0 from PyPI) was considered and left out, because it lacks the controls every other worker gets from its own CLI:

- **No read-only mode.** Tools come in toolsets, and the `file` toolset holds `read_file` together with `write_file` and `patch`; single tools cannot be turned off, and there is no plan or approval mode for files.
- **Writes outside the working directory are allowed.** The file tools warn when a path resolves outside the workspace and write anyway.
- **Dangerous shell commands are auto-approved without a person.** In a non-interactive run that is not its messaging gateway, the approval check lets them through (`-z` bypasses approvals outright); a fail-closed path exists in the code, but not as a CLI switch.
- **No event stream.** `chat -q -Q` prints the final answer and the session id, nothing about steps, tool calls or tokens (`--usage-file` only works with `-z`).

Pitroom's own guards (the git guard, isolated copies, the read snapshot) would still apply, but not the CLI-level confinement the other workers have, so it would be the one worker that can write anywhere. `-W hermes` therefore says it is not supported yet. What would change that: a read-only (or per-tool) switch, file tools confined to the working directory, a fail-closed approval switch for headless runs, and a JSON event stream; or its Docker terminal backend with the project mounted, which would need Docker on the user's machine.

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
