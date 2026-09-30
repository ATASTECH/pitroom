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
| **Codex** (`exec --json`) | `-s read-only` (OS sandbox) | `-s workspace-write` (sandbox, no network) | `exec resume <id>` | tokens only |
| **Claude Code** (`-p --output-format stream-json`) | `--permission-mode plan`, deny Edit/Write/Bash writes via `--settings` | `acceptEdits` + `--settings` deny rules (`Bash(git push:*)`…) | `--resume <id>` | `total_cost_usd` |
| **Gemini CLI** (`-p -o stream-json`) | `--approval-mode plan` | `auto_edit` + policy engine rules | index/latest only → `resume: 'none'` | tokens only |

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
