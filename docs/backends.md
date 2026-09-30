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
| **Gemini CLI** (soon; `-p -o stream-json`) | `--approval-mode plan` | `auto_edit` + policy engine rules | index/latest only → `resume: 'none'` | tokens only |

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
- **Node**: `codex` is a Node script (`#!/usr/bin/env node`); Pitroom runs such CLIs on its own Node 18+, since agents' shells often have an older Node first on `PATH`.

## Claude Code notes

- **Lockdown** (see the table): `--safe-mode` keeps the user's CLAUDE.md, skills, plugins, hooks and MCP out; `--restricted` removes command-running tools unless listed, confines file tools to the working directory and refuses `bypassPermissions`; `--permission-mode dontAsk` denies anything outside the allowlist instead of prompting. The init event of a real run lists exactly `Glob, Grep, Read` for a read-only worker, no MCP servers, and only Claude Code's built-in plugins.
- **Not `--bare`**: it disables OAuth, which would break Claude subscriptions.
- **Argument order**: `--tools`, `--allowedTools` and `--disallowedTools` take lists; non-list options follow them and the prompt comes after `--`, so no list can swallow it.
- **Errors**: an API error arrives as an assistant message with `is_api_error_message` (e.g. `authentication_failed`, "OAuth session expired"); it is not counted as work, so the fallback chain can move on.
- **Model**: the init event names it. The user's default is often an Opus-class model; `doctor` warns and suggests `-W claude:haiku`.

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
