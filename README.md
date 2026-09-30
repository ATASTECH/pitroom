# Pitroom

**A free pit crew for your expensive coding agent.**

Claude Code, Codex and friends spend premium tokens *reading*: grepping, opening files, scanning code they'll never quote. Your agent stays in the driver's seat; `pitroom` sends that work to a pit crew — a worker agent CLI such as [OpenCode](https://opencode.ai), running **whatever model you already configured there** (a free tier, a local MLX/Ollama model, a cheap paid one) — and hands your main agent back only what it needs: the answer, the exact diff, and a receipt.

```text
$ pitroom run "Which function builds the read-only permission profile, and which bash commands does it allow?"
pitroom ✔ done · read · 30s · run 20260930-003902-3270
session ses_… · model opencode/muse-spark-1.3-contributor-free

SUMMARY: The read-only permission profile is built by `readProfile()` in src/profiles.ts:89.
Its bash allow-list is `READ_ONLY_BASH` in src/profiles.ts:29-46.
DETAILS:
- Allowed (src/profiles.ts:31-41): `git status*`:31, `git diff*`:32, … `rg *`:40, `wc *`:41.
- Explicit sub-denies: `rg *--pre*`:43, `git *--output*`:44, `git *--ext-diff*`:45.
FILES CHANGED: none

── receipt: worker processed 163k tokens in 6 steps (7 tool calls) · worker cost $0.000
   · returned ~554 tokens, 294× compression · est. saved $0.152 vs Claude Sonnet
```

A real run on a free OpenCode Zen model: your agent reads ~554 tokens instead of 163,000. Every run prints a receipt, and `pitroom savings` adds them up.

<p align="center"><img src="docs/card.svg" width="520" alt="Pitroom savings card"></p>

## Why Pitroom

- **Your model, not ours.** No model is hardcoded. Pitroom uses your worker CLI's default model; switch between free, paid and local models there and Pitroom follows.
- **Any worker CLI.** Workers are adapters behind one interface. OpenCode ships today; Codex, Claude Code and Gemini CLI are next ([how adapters work](docs/backends.md)). Safety, verification and receipts live in the core, so every worker gets them.
- **Verified answers.** Every `path:line` the worker cites is checked on disk (file exists, line in range, the named symbol is nearby): `── refs: 17/18 verified · bad: src/x.ts:400 (file has 120 lines)`. Your agent trusts what checks out and skips re-reading it.
- **Self-healing worker chain.** Free models get rate-limited or retired. List fallback workers once (`fallback`) and a run that hits "model not found", 429 or quota errors moves to the next model automatically. Still no model hardcoded: the chain is yours.
- **Receipts, not vibes.** Tokens the worker burned, tokens returned to your agent, compression ratio, and an estimate of what your primary model would have charged. `pitroom savings --card card.svg` makes a shareable card.
- **Safe by construction.** Each run gets the worker's own safety mechanism set to the mode (for OpenCode, a permission profile injected through `OPENCODE_CONFIG_CONTENT`): no commit/push/reset/checkout/stash/clean/rebase, no bulk deletes, no `sudo`, no `.env` or key files, no web tools unless you pass `--web`, no subagents, no recursive delegation. Only `allow`/`deny` rules, so a headless run never stalls on a prompt. A **git guard** on the worker's PATH also stops `sh -c "git push"`, `env git reset`, aliases and scripts from committing, pushing, resetting, stashing or touching your index. Your `opencode.json` is never touched.
- **A crew, not just one worker.** `pitroom crew` starts several workers at once, `pitroom watch --json` streams one line per change so your agent follows them live, `pitroom wait -g` collects every answer, `pitroom apply -g` lands isolated patches in order. A queue (`maxParallel`) keeps free tiers from rate-limiting you; parallel writers are refused.
- **Exact changes, even in a dirty tree.** Pitroom snapshots the working tree with a throwaway git index (your index, branches and stash are never touched), so it reports *only the worker's* edits and can undo exactly those: `pitroom revert <id>`.
- **Real isolation.** `--isolate` runs the worker in a private copy of your **current** state (its own repository, sharing your objects read-only), uncommitted and untracked files included, then hands you a patch: `pitroom apply <id>` (checked, refuses on conflict) or `pitroom discard <id>`.
- **Zero repo pollution.** No `.pitroom/` folder, no `.gitignore` edits, no branches. Records live in `~/.local/state/pitroom`.
- **Works with any agent.** Five [Agent Skills](https://agentskills.io) (`using-pitroom` decides when to delegate, then `pitroom-research`, `-crew`, `-implement`, `-review`) plus a CLI, and a Claude Code / Codex plugin whose session-start hook makes your agent consider delegating before it starts reading. Claude Code, Codex, Gemini CLI, Cursor, or anything that can run a shell command.
- **Small.** About 3,100 lines of TypeScript, one ~94 KB bundled file, zero runtime dependencies.

## Quick start

Requires [OpenCode](https://opencode.ai) v2+ (with a default model configured) and Node.js 18+.

```bash
npm i -g pitroom
pitroom install          # skills → ~/.agents/skills + ~/.claude/skills, launcher → ~/.local/bin/pitroom
pitroom doctor --probe   # worker CLI, models, permissions, skills, one live round trip
```

Or, in Claude Code, install it as a plugin (skills plus the session-start hook), from a clone or the repository:

```text
/plugin marketplace add /path/to/pitroom
/plugin install pitroom@pitroom
```

Use one or the other, not both (`doctor` warns if the skills load twice). Then just work: your agent delegates when it fits, or ask explicitly:

> Use pitroom to map how sessions are created and invalidated, then propose a fix.
> Split this into a pitroom crew: audit auth, billing and uploads for missing input validation.

## Modes

| | Flag | For | Your working tree |
|---|---|---|---|
| **read** | *(default)* | research, locating code, reviews | untouched; edit tools are denied |
| **isolate** | `-i` | code changes you want to review first | untouched until `pitroom apply` |
| **write** | `-w` | quick in-place edits | edited now; `pitroom revert` undoes exactly |

```bash
pitroom run "Find every place we build SQL strings by hand; file:line and risk"
pitroom run -i --link node_modules --verify "npm test" "Fix the off-by-one in paginate() and add a test"
pitroom run -w "Rename getUserById to findUserById in src/ and fix imports"
pitroom run --continue last "Now handle the empty-page case too"
```

Long jobs: `--bg` returns immediately; `pitroom wait <id>` blocks for up to 9 minutes (made for agents with 10-minute tool limits; exit code 75 means "call wait again").

## Crews

A real crew over this repository, four questions at once on a free OpenCode Zen model:

```bash
pitroom crew -g v04-demo \
  "Where does Pitroom enforce the maxParallel queue, and how does a waiting run react to pitroom stop? Cite file:line." \
  "How does the git guard shim resolve git aliases? Cite file:line." \
  "Which fields of OpenCode v2 events does the parser read for token usage, refused tool calls and errors? Cite file:line." \
  "How does pitroom apply -g decide which patches to apply and in what order? Cite file:line."
pitroom watch -g v04-demo --json   # what the primary agent follows, one line per change:
```

```text
{"event":"started","run":"20260930-102812-a65d","mode":"read","task":"Where does Pitroom enforce the maxParallel queue, and how d…"}
{"event":"progress","run":"20260930-102812-a65d","steps":3,"tools":4,"last":"grep SIGINT|SIGTERM|stop.*queued|stopped.*queued"}
{"event":"done","run":"20260930-102812-a563","time":"21s","worker":"opencode (default model)","summary":"The shim resolves `alias.<sub>` via `real git config --get` in a loop …","refs":"5/5"}
{"event":"all-done","runs":4,"ok":4,"failed":0}
```

```text
$ pitroom status -g v04-demo
RUN                   STATE  MODE  TIME  STEPS  WORKER                    NOW / RESULT
20260930-102812-0c0d  done   read  30s   5      opencode (default model)  Parser `src/backends/opencode/events.ts` reads …
20260930-102812-7642  done   read  27s   5      opencode (default model)  `pitroom apply -g NAME` applies finished isolat…
20260930-102812-a563  done   read  21s   2      opencode (default model)  The shim resolves `alias.<sub>` via `real git c…
20260930-102812-a65d  done   read  39s   7      opencode (default model)  maxParallel is enforced by file-based slots (`s…
```

Humans get the same table live with `pitroom watch -g NAME`; `pitroom wait -g NAME --brief` prints one line per worker, `pitroom show <run>` the full answer.

For changes, `pitroom crew -i …` gives every worker its own isolated copy of your current state and `pitroom apply -g NAME` lands the patches in order, stopping at the first conflict. At most `maxParallel` workers (default 4) run at once, the rest queue; only one `--write` run per repository is allowed. `pitroom stop -g NAME` stops running and queued workers.

## Skills

| Skill | Your agent uses it to |
|---|---|
| `using-pitroom` | decide whether to delegate at all, and which skill fits (injected at session start by the plugin) |
| `pitroom-research` | find, map or explain code through a read-only worker |
| `pitroom-crew` | split independent work across parallel workers, watch them, merge results |
| `pitroom-implement` | get a change made in an isolated copy, review the diff, apply it |
| `pitroom-review` | get a second opinion on a diff or pull request |

## Commands

```text
pitroom run [-r|-w|-i] [-W WORKER] [-m MODEL] [-d DIR] [-f FILE]… [-t 30m] [--verify CMD] [--link a,b] [--bg] "task"
pitroom run --continue <run|last> "follow-up"
pitroom crew [-i] [-g NAME] "task 1" "task 2" …   (or --task-file with --- separators)
pitroom status|wait|watch [run… | -g NAME]        wait: --any --brief --timeout · watch: --json --interval
pitroom show [run]                                --patch --events --full --json
pitroom apply [run | -g NAME] · pitroom discard|revert [run] · pitroom stop [run | -g NAME]
pitroom ls [--running] [-g NAME] · pitroom clean [--days 14] [--yes]
pitroom savings [--since 7d|30d|all] [--card file.svg] [--badge]
pitroom doctor [--probe] · pitroom config · pitroom install [--copy] [--force] · pitroom uninstall
```

Exit codes: `0` ok · `1` worker failed · `2` usage · `3` refused/setup · `4` timeout · `5` read-only violation · `6` verify failed · `75` still running.

## How it works

```text
primary agent ──(skill: "delegate?")──► pitroom run "task"
                                          │ snapshot tree (throwaway index)      [write]
                                          │ isolated copy of current state       [isolate]
                                          │ worker adapter: mode → the CLI's own permissions
                                          ▼
    worker CLI, e.g. opencode run --standalone --format json   (stdin closed, git guard, your default model)
                                          │ NDJSON events
                                          ▼
                     final answer · exact diff · receipt ──► primary agent verifies / applies
```

Known headless footguns handled for every worker: `opencode run` blocks forever on an open stdin pipe; `ask` permissions stall headless runs; default output carries ANSI and banners; and in OpenCode v2 a plain `run` attaches to the shared background service, where per-run permissions and the git guard would not apply. Pitroom closes stdin, uses allow/deny-only profiles, parses `--format json` and always runs a private `--standalone` server.

## Workers

A worker is named by a target: `backend[:model]`.

```bash
pitroom run "…"                                          # preferred worker (config "worker", default opencode)
pitroom run -W opencode:opencode/space-bunny-free "…"    # a specific backend and model
pitroom run -m nvidia/z-ai/glm-5.3 "…"                   # another model on the preferred worker
```

| Worker | Status | Read-only enforced by |
|---|---|---|
| OpenCode | ✅ | per-run permission rules |
| Codex CLI | planned | OS sandbox (`-s read-only`) |
| Claude Code | planned | permission mode + tool rules |
| Gemini CLI | planned | approval mode + policy engine |

Fallbacks may cross backends once more adapters land (e.g. OpenCode rate-limited → Codex). Follow-ups (`--continue`) always stay on the worker that owns the session. Writing an adapter: [docs/backends.md](docs/backends.md).

## Configuration

| Env | Default | |
|---|---|---|
| `PITROOM_WORKER` | `opencode` | Preferred worker target: `backend[:model]` |
| `PITROOM_MODEL` | the worker's default | Model for the preferred worker |
| `PITROOM_FALLBACK` | none | Comma-separated targets to fail over to on model/provider errors |
| `PITROOM_TIMEOUT` | `30m` | Per-run timeout |
| `PITROOM_MAX_PARALLEL` | `4` | Workers running at once; more queue |
| `PITROOM_PRIMARY` | `sonnet` | Pricing preset for the savings estimate: `sonnet`, `opus`, `haiku`, `gpt-5` |
| `PITROOM_PRICE` | | Custom primary price, USD per 1M tokens: `"in,out[,cachedIn]"` |
| `PITROOM_HOME` | `~/.local/state/pitroom` | Where run records and the ledger live |
| `PITROOM_<WORKER>_BIN` | on PATH | Path to a worker CLI, e.g. `PITROOM_OPENCODE_BIN` |

Or put defaults in `~/.config/pitroom/config.json` (flags and env still win); `pitroom config` shows every effective value and where it came from:

```json
{
  "worker": "opencode",
  "fallback": ["opencode:opencode/space-bunny-free", "opencode:nvidia/z-ai/glm-5.3"],
  "timeout": "20m",
  "primary": "opus",
  "link": ["node_modules"],
  "maxParallel": 3
}
```

## FAQ

**Where does my code go?** To whichever provider your worker's model uses. For private code, point the worker at a local model. `.env` files and private keys are blocked from the worker either way.

**How is "saved" computed?** It assumes your primary agent would have processed about the same tokens the worker did, priced at your primary's list prices (`PITROOM_PRIMARY` / `PITROOM_PRICE`), minus the worker's cost and the cost of reading the report. It is an estimate and is labelled as one.

**Can the worker break my repo?** It can't touch git history, refs or your index (permission profile + git guard), can't run bulk deletes, and write-mode edits are revertible with one command. The guard is not an OS sandbox: git called by absolute path from inside a script, or non-git tools, are outside its reach, which is why `--isolate` exists: nothing reaches your tree until you apply it.

**What if the worker fails?** Pitroom exits non-zero with the real cause (for example a default model that no longer exists) and your agent simply continues on its own. `pitroom doctor` diagnoses setup problems.

## Development

```bash
npm install
npm test          # end-to-end tests against a fake worker CLI + adapter contract tests on recorded real streams
npm run typecheck
```

MIT licensed.
