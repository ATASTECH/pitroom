# Changelog

## Unreleased

### Answers
- **Complete lists and counts.** Audits kept finding answers whose references were right but whose lists left items out and whose counts were off (on PI-Desktop, 5 of 8 answers were partly right, mostly for that; one counted "about 40" tests where there are 59). The worker contract asked for none of it and told the worker to be economical. A read worker is now told, when the task asks for all of something, a list or a count, to search the whole scope instead of stopping at the first hits, to give the full list or the exact count in DETAILS and say how it found it, and to say under OPEN ISSUES what it did not cover; "be economical" no longer applies to such a search. The answer format is unchanged.
- **The auditor gets one reply form.** The audit's question was wrapped in the worker contract, so the auditor was also told to be economical (while asked to count again) and to end with the SUMMARY/DETAILS format (while asked to reply with `AUDIT:` and nothing else). It now gets the same rules without those two.

### Audits
- **A disputed answer can be corrected** (`"auditFix": true`, `PITROOM_AUDIT_FIX=1`; off by default). When an audit says PARTIAL or DISAGREE with disputed claims, the answer goes back to the worker that gave it, as a follow-up in its own session: check each disputed claim against the files (the auditor can be wrong too), answer again in full, and say which claims were accepted. One round: a correction is never sent back again. `pitroom show` and the card name the correction (`── fix: …`), and the correction says what it corrects.
- **A focused audit sample** (`"auditFocus": true`, `PITROOM_AUDIT_FOCUS=1`; off by default). The `audit` rate is doubled for a question that asks for all of something, a list or a count, doubled again for a worker whose audited answers were confirmed less than half the time (3 audits or more in 30 days), and halved for one whose last 5 or more were all confirmed. `--audit` / `--no-audit` win; the run records the chance it got and why (`auditFocus`).

### Evals
- **`pitroom eval QUESTIONS.json [-W worker]… [--json]`**: your own questions about your own code, with known answers, put to each worker as read runs of one group (no fallback, no audit, no cached answer) and scored the way `benchmarks/multi-repo` scores: a definition 1 for the exact `path:line` (0.5 for the right file), a count only for the exact number, a list the F1 of its paths. A truth is written down or looked up with `git grep` when the eval starts, so it stays right as the code changes. Prints one line per answer and a table per worker (score, per kind, failures, median time and tokens).

### Costs
- **A daily budget** (`"budgetDaily": 5`, `PITROOM_BUDGET_DAILY`; none by default): what the workers may cost per day, as reported or estimated, audits and corrections included. Past 80% a run warns; once it is spent only workers that cost nothing still run (a price of 0, or a worker whose recent runs all cost exactly 0), a run with none of them in its chain is refused (exit 3), and audits and corrections do not start. A run counts once it has ended.

### Workers
- **Qwen Code worker (beta)**: `-W qwen[:model]`, with the user's sign-in and model from `~/.qwen/settings.json` (any OpenAI-compatible provider, DashScope, a local model). Read runs use plan mode; write and isolate runs approve edits only inside the working directory (`auto-edit` would approve them anywhere: in a test an isolated run edited the real checkout), with the shell minus history-changing git. `--safe-mode` keeps the user's QWEN.md, hooks, skills and MCP servers out and stops the CLI's background memory extraction, which otherwise writes what a run saw into `~/.qwen/memories`; worktree, cron, memory, subagent and messaging tools are excluded (plan mode alone let `enter_worktree` make a branch). `--continue` works by session id. A used-up quota surfaces in about 80 s instead of after 10 × 60 s of retries. Checked against Qwen Code 0.25.0 with a scripted model endpoint (the fixtures are the real CLI's output); not yet with a real provider. See docs/backends.md.
- **Workers ranked by their record** (`"rankWorkers": true`, `PITROOM_RANK_WORKERS=1`; off by default): the worker and its fallbacks are ordered by the share of their runs that ended well in the last 30 days (rate limits left out) times the share of their audited answers that were confirmed. Only workers with 5 runs or more move, among the places such workers hold, in steps of 10%; a worker you name (`-W`, `-m`, a tier) is never reordered, and the run says when the first worker changed.

### Dashboard
- **Crew actions.** A crew's card has **Stop all** (its running and queued runs) and **Discard all** (its finished, unapplied isolated copies), each asking once more, and **Retry command**, which shows the `pitroom run … -g CREW --bg` commands that start its failed, timed-out or stopped runs again, to copy. The page still never starts a run itself.

### Tests
- The audited-run UI test is skipped without Chrome, like the other UI tests (it failed on machines without one).

## 0.22.0

### Workers
- **`--continue` works with Gemini.** It was refused ("cannot continue sessions") because Gemini CLI's `--resume` was known to take an index or `latest`, which is not safe with parallel workers. It takes the session id as well (checked live on 0.62: a follow-up remembered what the first run read), and the id is in the stream's first event, so Pitroom resumes by it like with the other workers: `pitroom run --continue last "…"`, or `continue` in `pitroom_run`.

### Dashboard
- **A crew is one card.** On the Live tab, runs that share a group (two or more: `pitroom run -g name`, a `pitroom_run` with `tasks`) now show as one card: the group name, the workers that are in it (`opencode ×3`), how many runs, how many are running, done or need attention, a progress bar, the tokens and the estimated saving of the crew, and when it started. It opens onto its runs, which are the usual cards; a crew that is still working is open by itself. A group of one run, and runs without a group, stay plain cards; the group picker still lists one crew's runs flat. A crew with a run among the newest is returned whole, so "Show older runs" never leaves it with fewer runs than it has.

## 0.21.0

### Windows
- **A real git guard on Windows.** Until now the guard (a worker may not commit, reset, push, `git add`, `clean` and so on) was a `sh` script and Windows had none. Now the ref and push guard (git's own env config with a `reference-transaction` hook) is on there too, and the `git` shim runs on the `sh.exe` that Git for Windows brings (`git.cmd` for cmd.exe and PowerShell, `git` for Git Bash). A worker that starts git without a shell skips the shim and is left with the config layer. The guard tests, which were skipped on Windows, run there now; `pitroom doctor` reports the shim as ready or says what is missing.

### Costs
- **A price catalog that keeps itself up to date (opt-in).** `"priceFeed": true` (or `PITROOM_PRICE_FEED=1`): at most once a day, in a background process after a run (a run never waits for it), Pitroom fetches the public models.dev price list (the one OpenCode reads; USD per 1M tokens of about 8,000 models) and keeps a trimmed copy (about 400 KB) in its state directory; a failed or implausible answer keeps the old copy and is not retried for an hour. It is a fallback behind your own `workerPrices`, and the receipt says which was used (`estimated from models.dev prices`). `"primary"` can then be any model id of the catalog for the savings comparison, so it no longer goes stale (before: four fixed presets). New command `pitroom prices [--refresh] [--json]`, a doctor line, and settings `priceFeedUrl` and `priceFeedHours`. **Off by default**, because until now Pitroom's own code made no network request at all: PRIVACY.md says what the request carries (nothing about you; a plain GET) and what it shows (your IP address to models.dev).
- **Prices for the CLIs that report no cost.** Codex and Gemini give tokens but no cost, so a run's `worker cost` was `n/a` and counted as free in the savings, which overstated them. The new config `"workerPrices": {"codex:gpt-6.1-sol": "1.25,10,0.125"}` (USD per 1M tokens, "in,out[,cachedIn]", keyed `backend:model` or `backend`) lets you say what they cost: the cost is then estimated from the tokens, shown as `~$0.016 (estimated from your workerPrices)` in the receipt and marked estimated in the dashboard, kept in the ledger and history, and taken off the savings. A cost the CLI reported always wins. `pitroom doctor` warns about a worker in your chain that reports no cost and has no price. Pitroom still knows no vendor prices and fetches none: the numbers are yours.

## 0.20.0

### Notifications
- **A desktop notification when a background run has ended.** Off by default; `"notify": true` in the config (or `PITROOM_NOTIFY=1`). A run that went to the background (`--bg`, a crew, an MCP call) says `Pitroom ✔ research done` with its task, time and changed files; a failed, timed-out or stopped one says so. Runs that went well but took less than `notifyAfter` seconds (default 15) and audits are left out (a failure is always announced), and a crew says so once, when its last run ends, judged as a whole (from its earliest start, by its worst run). A worker process that is killed outright never gets to say so. macOS (`osascript`) and Linux (`notify-send`) are built in; `notifyCommand` runs your own command in a shell with the text in `PITROOM_NOTIFY_TITLE` / `PITROOM_NOTIFY_BODY` (ntfy, a chat webhook, a sound), which is also how to get one on Windows.

### MCP
- **A live view for MCP clients.** A run that an MCP client starts and that is still going after a few seconds starts the dashboard (`pitroom dash --detach`, reused if it is up) and the "still running" result, also from `pitroom_wait`, carries its address with the instruction to open it in the app's own browser pane (the Claude Code and Codex apps have one), else to give it to the user. Before, only the skills told an agent about the dashboard, so an agent that used the MCP tools never mentioned it. A run that finishes quickly starts nothing; the system browser is never opened. The config's `"mcpDash": false` (or `PITROOM_MCP_DASH=0`) turns it off.

### Stats
- **Rate limits no longer count against a worker.** Runs that failed on a rate limit or quota are left out of `pitroom history stats` and the dashboard's Stats (run counts, success rates, times, tokens) and shown apart as rate-limited: they say nothing about the worker's work, and on free models they made good workers look bad (in one history, 257 of 286 failures were rate limits). The config's `"countRateLimits": true` counts them as before.
- A run records why its worker failed (`failureKind`: `rate-limited`, `model-unavailable`, `auth`, `other`); older records are recognised by the hint Pitroom adds to a rate-limit error.

### Fixes
- **Secret-looking files are recognised in any letter case.** `ID_RSA`, `.ENV`, `PROD.ENV`, `Credentials.json`, `SECRETS.YML`, `.NETRC` were not flagged (the check was case-sensitive for those names), though on macOS and Windows they are the same files as their lower-case spellings: a read run then ran in the project instead of a clean snapshot, and the heads-up did not mention them. Found by the worker that wrote the direct tests for `secrets.ts`.
- **A dashboard card could stay on its placeholder.** The page skipped every request while the browser said the page was hidden and waited for a `visibilitychange` that embedded browsers (the browser panes of the Claude Code and Codex apps) may never send; a card opened there showed grey boxes until the next poll, ten minutes later for a finished run. The first request is now always made; only the repeated ones are skipped while hidden.
- **An audit read the answer's paths as missing.** An answer is written for you, with the paths turned back into your project's (`/Users/me/proj/src/a.ts:3`); the auditor works in a clean snapshot of its own, where that path does not exist, and disputed it ("this path does not exist in this project"). The project's paths now reach the auditor relative to its working directory, and the prompt says so. In one history, 2 of 12 non-agreeing audits were this; re-auditing them: one now agrees, the other still disputes a real claim.

### Docs and tests
- The README's reference parts are folded into accordions (the first screen shows about half as much text; headings and links are unchanged), and the PI-Desktop benchmark says what a later audit found: of its eight answers 3 agreed and 5 were marked partly right, mostly lists that leave things out.
- Direct tests for the git guard, slots and locks, secret detection, receipts, the run store and process spawning, the MCP resources and prompts, and the doctor checks, which were only covered through the CLI; most were written by Pitroom workers in isolated copies and reviewed. A flaky MCP HTTP test was fixed at its cause (a blocked event loop reused sockets the server had closed).
- `benchmarks/outcome-prediction`: what Pitroom's own history can predict (whether a run will fail, whether an answer will be audited as right). Result so far: failures are rate-limit bursts a worker's recent record explains, and the labels about answers are too few to learn from.

## 0.19.0

### Doctor
- `pitroom doctor` has a **Use** section: with no runs yet it says so and how to start ("ask your agent to use Pitroom", or `pitroom run "where is <something> defined?"`); afterwards it says how many runs there have been and when the last one was. Skills can be installed and an agent may still never think of Pitroom: this is the first thing a new user sees.

### Fixes
- **`pitroom dash --detach` could not find a dash that was up.** The registry entry (`dash.json`) was deleted whenever the dash did not answer within 1.5 s, or when the file was read while the server was writing it; the command then reported "did not start" with the server running (seen as a flake on Windows and once on macOS). The entry is now removed only when its process is gone, and is written through a temp file.

### Docs
- Cursor has its own entry in the Quick start (`pitroom install --mcp --client cursor`), with what is and is not verified: Cursor's documentation lists `~/.agents/skills` and `~/.claude/skills`, where `pitroom install` links the skills; we have not run it in a Cursor session, and a forum report says its CLI does not load `~/.agents/skills`.

## 0.18.0

### Windows
- The test suite runs on `windows-latest` (Node 22 and 24) in CI. Ten tests that need `sh`, POSIX file modes or the git guard are skipped there.
- `pitroom install` makes a `pitroom.cmd` launcher; `pitroom doctor` starts it through a shell and warns that the git guard is not available.
- Fixes found by running there: a directory spelled `RUNNER~1` and the same one spelled `runneradmin` were taken for two places (isolate runs started in a directory that did not exist), so paths are compared as the file system names them; a bare `ipc.ts:12` reference was not matched to `src\main\ipc.ts`; the secret-looking files in a warning used backslashes; a missing `--verify` command (`is not recognized`) was shown as a failing test; `statusline --then` needs a shell that exists; the Tailwind build step used a symlink; run records could not be replaced while `watch` or the dashboard had them open (`EPERM`), so it retries.
- A spawn that fails because the working directory is missing says so, instead of "<command> not found".
- `.gitattributes` checks out with LF everywhere.

### Dashboard
- **Stop and Discard from the page.** A running card has a Stop button and a finished, not yet applied `--isolate` card has Discard, each with a confirmation. These are the dashboard's first writes, and the only ones: it still never starts a run or applies a patch. `POST /api/run/<id>/stop` and `/discard` need the secret the page was served with (random per start, compared in constant time) in `x-pitroom-token` and the dash's own `Origin`; anything else is 403, a POST elsewhere is 403, another method 405. A run that cannot be stopped or discarded (not active, not isolate, already applied or discarded) is 409.
- `pitroom stop` and the dashboard share one `stopRun`.

### Fixes
- A stop request is recorded in a file of its own (`stop-requested` in the run's folder), not only in `meta.json`: the run's process writes `meta.json` too, and its write could drop the flag, so a stopped run showed as "worker process exited unexpectedly" (found on Windows, where the process dies at once on the signal).
- `pitroom dash --detach` waits up to 20 s for the server (it was 6 s) while it imports old runs into the history.

## 0.17.0

### Answer cache
- The same read question on the same code gets the earlier answer back at once instead of a new worker run (`pitroom ⟲ cached answer · … · no worker ran`). The key is the question (whitespace does not count), where it was asked, the attached files' contents, where the worker reads (a clean snapshot or in place) and the project's exact state: HEAD and a tree of every working file, uncommitted and untracked included (made with git's own index, so unchanged files are not re-hashed). Only answers that held up are reused: a finished read run with an answer, every reference verified, nothing written, and no audit still running or disagreeing, for `cacheDays` (default 7; 0 turns it off; `PITROOM_CACHE_DAYS`). Follow-ups, web runs, plan tasks, reviews, audits, `--audit`, `--verify`, crews and changes are never cached; `--fresh` asks a worker anyway and its answer is reused from then on. Git-ignored files and the worker/model are not part of the key (documented; `--fresh` for those). With `--bg --json` the earlier run comes back already done, marked `"cached": true`.

### MCP server
- **Smaller tool definitions.** Ten tools instead of eighteen, nothing lost: parallel work is `pitroom_run` with `tasks` (was `pitroom_crew`), every report is `pitroom_info` with a `topic` (`runs`, `history`, `stats`, `savings`, `models`, `cooldown`, `config` (new), `doctor`; were seven tools), `pitroom_show` gives a running run's progress (was `pitroom_status`, and `run` now defaults to the latest), and `pitroom_stop` with `cooldowns` clears the cooldowns. Descriptions are shorter. The definitions sit in the client's context for the whole session: about 1.9k tokens now, 3.3k before. An option that does not go with a topic is an error that names the ones that do.
- **Run notifications.** A client can subscribe to a run's resource (`resources/subscribe` on `pitroom://run/<id>` or its `/patch`) and is told when the run changes state (for `/patch` also when it changed more files) or is gone (`notifications/resources/updated`); every client is told when the newest run changes (`notifications/resources/list_changed`; runs starting within one check are one notification). Read from the run records every 2 s, only while a client can be told; at most 100 subscriptions per client. An event stream nobody uses (no request, no event for an hour) is closed with its session. Over HTTP a GET with `Accept: text/event-stream` opens the session's event stream, where these arrive (one stream per session, kept alive with comments); a client without one is told once it opens it. Few clients act on these yet; the tools work the same without them.

### Fixes
- `pitroom review` in a linked git worktree: the review package was written to the worktree's git directory, which lies outside the worktree, and a sandboxed reviewer (OpenCode) was refused reading it, so the review had nothing to review. There it now goes to `<worktree>/.pitroom/` (added once to the repository's `info/exclude`, so `git status` stays clean) and is removed when the review ends. Found by having Pitroom review its own branches from a worktree.

### MCP Registry
- `server.json` describes Pitroom for the [MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.ATASTECH/pitroom`: the npm package, stdio, `pitroom mcp`), and `package.json` has the `mcpName` the registry checks. `npm run bump` keeps its version in step, and turns an `## Unreleased` CHANGELOG section into the version's entry.

### From real-world tests (Codex driving Pitroom over MCP)
- **`--verify` under an MCP client.** An app that starts Pitroom often passes a bare `PATH`, and `npm test` was "command not found" (exit 127). The verify command now also finds the Node running Pitroom (npm and npx sit next to it) and the usual install places, after your own `PATH`; a command that still is not found is reported as "could not run (exit 127: command not found)" with what to do, not as a failing test.
- **A failed `--verify` is no longer shown as success.** The report says `⚠ done · verify failed` instead of `✔ done`, an MCP result is an error (`isError`, as is a read-only violation), and the dashboard shows a warning icon on the card and lists the run under **Needs attention**.
- **Audits check the question, not only the references.** The auditor must check every condition the question sets (scope, exclusions, "all", "only", counts), look for missing and extra items in a list and recount a count; AGREE needs all of them. In the tests an answer that listed 8 files outside the asked directory got AGREE from two of three auditors, because its references were valid.
- **Skills over MCP.** An agent using the MCP tools did not think of Pitroom's skills. The server's instructions now name them and say to use the matching one, `pitroom_run` points to `using-pitroom`, and every skill is also a prompt of the same name (its text, with how the CLI commands in it map to the tools), for clients that have no skills.
- **`pitroom review --range A..B` shows the branch's own change**, from where it left A, as a pull request does. When A had moved on since (another PR merged), the diff also showed A's newer commits as if the branch undid them.
- An OpenCode model answering "Endpoint is unavailable" (HTTP 400) is treated as rate-limited: it cools down and the next worker runs (this already worked; it now has a test).

## 0.16.0

### MCP server
- **Progress notifications.** A call that waits for a run reports how it is doing every few seconds (`notifications/progress`, when the client sent a progress token), so the agent sees what the worker is doing; a client that resets its timeout when progress comes in (the protocol allows it, not every client does) does not give up on a long run.
- **Cancellation.** A client that cancels `pitroom_run`, `pitroom_crew`, `pitroom_review` or `pitroom_audit` (`notifications/cancelled`) stops the run or group it started and gets no answer, as the protocol says; a cancelled `pitroom_wait` only stops waiting. A client that sends its requests and closes the pipe still gets the answers.
- **Resources.** The latest runs are resources, `pitroom://run/<id>` (the report) and `pitroom://run/<id>/patch` (the exact diff), with resource templates; anything else is "not found" (-32002).
- **Prompts.** `research`, `implement`, `review` and `crew`, with their arguments checked.
- **Nine new tools** (18 in all): `pitroom_crew` (independent tasks in parallel as one group), `pitroom_list`, `pitroom_history` (search earlier answers), `pitroom_stats`, `pitroom_savings`, `pitroom_models`, `pitroom_cooldown`, `pitroom_doctor` and `pitroom_revert` (undo a write run); `pitroom_run` takes `continue` for a follow-up in the same worker session, and `pitroom_apply` can apply a group.
- **HTTP transport.** `pitroom mcp --http [--port N]` serves the same server over Streamable HTTP at `http://127.0.0.1:7117/mcp`, for clients that connect to a URL. Local by construction: 127.0.0.1 only, a bearer token (generated on first start into `<state dir>/mcp-token`, mode 0600, or `PITROOM_MCP_TOKEN`; compared in constant time), and a Host or Origin that is not local is refused with 403 (DNS rebinding). Sessions per client (`Mcp-Session-Id`), so a cancel only touches the cancelling client's request even when two clients use the same request id; a call that sends a progress token is answered as an event stream. Ending a session (DELETE) or stopping the server ends the waiting, not the runs. When 64 sessions are open, the one unused longest makes room for a new one. Checked with the real Claude Code client (`claude mcp add --transport http …`, `claude mcp list`: connected).
- `pitroom mcp -d DIR` (stdio or HTTP) works in that project, for clients such as Claude Desktop that start the server somewhere else; `--port` without `--http` is a usage error.
- The server is split into protocol (`mcp.ts`), tools (`mcp-tools.ts`), resources and prompts (`mcp-extras.ts`) and what they share (`mcp-support.ts`).

## 0.15.0

### `pitroom install --mcp`
- Registers `pitroom mcp` in the MCP clients found on the machine, so setting it up is one command: Claude Code, Codex and Gemini CLI are changed with their own `mcp add` command (user scope where they have one), Cursor and Claude Desktop have their JSON config merged (other servers and settings kept, a `.bak-pitroom` backup the first time, a file that is not valid JSON left alone). `--dry-run` only says what it would do, `--client cursor,claude-desktop` limits it, `--no-skills` skips linking the skills, and `pitroom uninstall` removes the registrations again (a client whose command is gone cannot be asked to, which is reported and exits 1).
- The command registered is the launcher by its full path (apps such as Claude Desktop start without your `PATH`), and only when that file really is a Pitroom launcher. Whether a client already has the server is read from its config file, never by starting the server; a client that runs a different command (a Codex entry included) is updated, and `--force` registers again.
- `pitroom doctor` has an MCP section: where `pitroom mcp` is registered, and a warning for a client that runs another command.
- Checked with the real `claude`, `codex` and `gemini` commands in a throwaway home: right entries written, a second run "already registered", `uninstall` removed exactly those. The change was reviewed by a free Pitroom worker before merging; its findings (a foreign file at the launcher path, unguarded writes, the Codex command not compared, uninstall failures, a few messages) are fixed.

## 0.14.1

### Docs
- The dashboard images and the GIF show audits (an `audited · agrees / disagrees` badge, the audit run's own card, the disputed claims on an opened card) and a worker skipped because its quota ran out ("Skipped … cooling down until 14:05"); the Stats image has the new Audited column (confirmed / audited per worker). The README's Dashboard section explains them. The npm page shows the README of the published package, so this is where it reaches it.

## 0.14.0

### MCP server
- `pitroom mcp` serves Pitroom as a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so any agent that speaks MCP (Cursor, Claude Desktop, Claude Code, Codex, Gemini CLI, …) can use it as tools instead of shell commands and skills: `pitroom_run` (read, isolate or write), `pitroom_wait`, `pitroom_status`, `pitroom_show`, `pitroom_review`, `pitroom_audit`, `pitroom_apply`, `pitroom_discard` and `pitroom_stop`, each with a JSON schema and hints (`apply` is marked destructive). Set it up with `claude mcp add pitroom -- pitroom mcp`, `codex mcp add pitroom -- pitroom mcp`, `gemini mcp add pitroom pitroom mcp`, or an `mcpServers` entry for Cursor and Claude Desktop (see the README).
- Each tool runs the matching `pitroom` command, so every rule of the CLI applies unchanged (permission profiles, git guard, isolation, read snapshots, cooldowns, audits) and the tools cannot drift from the CLI. A run is waited for up to `waitSeconds` (default 50, at most 540), then comes back as "still running" with its id for `pitroom_wait`. No new dependency: a small JSON-RPC implementation (protocol versions 2025-06-18, 2025-03-26 and 2024-11-05, batches, the standard error codes); only JSON reaches stdout.
- Tested against the protocol with a real server process, and with a real client: Gemini CLI connected, called `pitroom_run` for a question, got the worker's answer with its references verified and collected an audit. Limits: stdio only, no MCP resources, prompts or progress notifications yet (the agent polls with `pitroom_wait`).

### Fixes
- `pitroom stop` on a run whose process is still starting: the process has no signal handler yet and died on the signal, and the run showed "failed: worker process exited unexpectedly". `stop` now says first that a stop was asked for, and such a run is "stopped". This was the cause of a flaky test (`stop -g …`).

## 0.13.0

### Read snapshots
- A read run in a directory that holds secret-looking files (`.env`, `prod.env`, private keys and keystores, `.netrc`, `credentials.json`, `secrets.json`) now reads a **clean snapshot** of your project instead of the directory, so those files are simply not there, whatever the worker CLI would have allowed. Before, the only protection was the worker's prompt and a warning (OpenCode and Claude Code refuse `.env` in their file tools, Codex does not, Gemini CLI 0.62 ignores our deny rules). Checked live with Gemini: `server.pem` in the snapshot came back "File not found".
- The snapshot is your project's current state (uncommitted and untracked files included) minus git-ignored files and anything secret-looking, a tracked secret too. It is made from git objects, kept once per state and shared by every read run on it (twenty workers, one snapshot), and nothing is copied back: a read run has nothing to land. Its files are read-only. Unused ones are removed after three days, beyond the newest six, or by `pitroom clean`. On an 8,000-file repository the first snapshot took about 3 seconds (167 MB) and later runs 0.6 seconds.
- With no secret-looking files nothing changes: the worker runs in place. `--in-place` (or `"readIn": "project"`, env `PITROOM_READ_IN`) reads the directory itself, for example when a task needs build output; `"readIn": "snapshot"` always uses one. The paths a worker cites are turned back into your project's, follow-ups stay in the snapshot, and edits (`-i`, `-w`) and reviews are not affected. If a snapshot cannot be made the run falls back to the directory and says so.
- More names count as secret: names ending `.env`, `.key`, `.jks`, `.keystore`, and `secrets.json|yml|toml` (templates such as `.env.example` still do not).

### Tests
- The warning test covers both ways: a snapshot by default, the old heads-up when reading in place.

## 0.12.0

### Cooldowns
- A model that says "rate limited" (a free daily quota used up, an overloaded provider) is remembered for a while, so the next runs go straight to the fallback instead of each one trying the exhausted model first and waiting for it to fail. The wait comes from the provider's message when it gives one (`retry in 4h28m`), else a guess: 4 hours for a daily quota, 20 minutes for overload; at least a minute, at most a day.
- A model on cooldown is skipped only while another worker is left to run; if it is the only one it is still tried. Cooldowns expire on their own.
- The report says `skipped: … (cooling down until 14:05: …)`, the dashboard card shows "Skipped …", `pitroom doctor` warns with the time, and `pitroom cooldown` lists them (`--clear` tries them again). Only rate-limit failures count, not a missing model or a sign-in problem.

## 0.11.0

### Gemini CLI as your primary agent
- Pitroom installs into Gemini CLI as an extension: `gemini extensions install https://github.com/ATASTECH/pitroom` gives it the 14 skills and a short context file that introduces Pitroom (`gemini-extension.json`, `gemini-context.md`). Gemini CLI also still works as a worker (`-W gemini`); the two are separate. Gemini asks you to confirm the extension. Its session-start hook text did not reach a Gemini session in a test (Gemini probably runs extension hooks only once you trust them), so the context file is what introduces Pitroom there.
- `hooks/hooks.json` is now valid for both Claude Code and Gemini CLI (a Gemini extension reads that file too and warned about Claude Code's `PostToolUse` event on every session): it holds SessionStart only, with a command that fills `${CLAUDE_PLUGIN_ROOT}` in Claude Code and `${extensionPath}` in Gemini CLI. The card after each `pitroom` command is Claude Code's alone and moved to `hooks/claude-hooks.json`, named by `hooks` in the Claude plugin manifest. `npm run bump` and the release test keep `gemini-extension.json` in step with the version.

### Doctor
- Worker CLIs that are installed but not in your config now get a section ("Gemini CLI (installed, not in your config)") with how to use them, so a new worker is not invisible. They never count as warnings, and a CLI that is not installed stays out of the way.
- A Gemini API key that Gemini CLI keeps itself is no longer reported as "not signed in".
- Doctor warns when Pitroom is a Gemini extension and its skills are also linked into `~/.agents/skills`: Gemini would load them twice.

### Docs
- The README has a Gemini CLI install block and a row in the install table.

## 0.10.1

### Docs
- The README names Gemini CLI in the quick start (with the API-key requirement), the features, the examples and `pitroom models`; the Gemini star joins Claude and Codex in the hero image. The skills and the marketplace text list Gemini CLI too. The npm page shows the README of the published package, so this is where it reaches it.

## 0.10.0

### Audits
- A finished read run's answer can be re-checked in the background by another worker, which verifies the key claims against your project and replies `AGREE`, `PARTIAL` or `DISAGREE` with the claims it disputes. Pitroom already checked that every cited `path:line` exists; an audit checks that what is said about it is true.
- Ways to use it: `pitroom audit RUN [-W worker]` now; `pitroom run --audit` / `--no-audit` per run; `"audit": 0.1` in the config (or `PITROOM_AUDIT=0.1`) for about one read run in ten, chosen by a stable hash of the run id. The auditor is the `audit` tier, else `cheap`.
- **Off by default.** An audit costs about the rate times the answer's own tokens, runs detached after the run and never delays or fails it. The auditor is never the worker and model that gave the answer, and does not fall back to it; with no other worker nothing starts and `pitroom doctor` says so. Only read runs are audited, never reviews, changes or other audits.
- The verdict and the disputed claims are on the audited run (`pitroom show`, the dashboard card with an `audited · agrees/disagrees` badge and a note, History), and Stats has an Audited column per worker (confirmed/audited). Audits are not counted as runs and are not in the savings ledger.
- An audit is a sample, not a guarantee: the auditor is a model too and can share a blind spot.

### Tests
- Test cleanup retries when a background process (Chrome, a dash server, an audit) is still writing as a test directory is removed (an `ENOTEMPTY` flake seen on CI).

## 0.9.0

### Gemini CLI worker (beta)
- A fourth worker: `-W gemini` (or `gemini:<model>`). Read runs use Gemini's `plan` approval mode, isolate and write runs use `auto_edit`; never `--yolo`. Shell commands that change history or delete in bulk (`git commit`, `git push`, `rm -rf`, `sudo`, other agents) are refused by Pitroom's policy files (`policies/gemini`), which ship in the package.
- Workers run in a private Gemini home (`<pitroom home>/gemini-home`): your hooks, MCP servers, skills and global `GEMINI.md` are not loaded, and your sign-in method is carried over. Folders you trusted in Gemini stay trusted; `PITROOM_GEMINI_TRUST=1` trusts others (`--skip-trust`).
- Needs a Google AI Studio API key (`gemini` stores it, or `GEMINI_API_KEY`): Google refuses account sign-in for this CLI (`IneligibleTierError`). Pin a model, e.g. `-W gemini:gemini-3.8-flash`: the 2.5 models are no longer served to new keys, and the free tier has a small daily quota per model. Tokens are reported, cost is not.
- Tried against Gemini CLI 0.62; real runs are recorded as test fixtures. **Not enforced by Gemini 0.62, so do not rely on it:** the secret-file deny rules (`.env`, `*.pem`, keys): use `--isolate`. The web-tool rule was not verified. Details in `docs/backends.md`.
- The dashboard shows Gemini's logo and mascot, and `doctor` has a Gemini section.

### Tests and docs
- Browser tests for the dashboard (`test/ui.test.mjs`): system Chrome over the DevTools protocol, skipped when Chrome is missing. They cover opening and closing a card, a `#run-id` link, an isolate run's highlighted diff and the Stats logos.
- README screenshots and the GIF are regenerated: a file opened to its diff, Stats with worker logos, a running Gemini worker.
- The adapter test fixtures' `*.stderr.log` files were git-ignored by `*.log` and so missing from the repository (their tests were skipped there); they are tracked now.

## 0.8.1

### Dashboard
- The Stats table shows each worker's logo next to its badge.
- Stats no longer lists an `unknown` worker with no runs: an old savings record (from before pluggable workers: no backend, a model without its provider) now counts for its own worker row, so the per-worker figures still add up to the total.
- The step list's scroller stays mounted so the list animates closed with its content, and a tap on a touch screen no longer leaves auto-follow off while you are at the bottom. A file path containing `", "` still matches its edit step.

## 0.8.0

### Dashboard
- An edited file in a run card opens as its diff: line numbers, added and removed rows, syntax highlighting (Shiki: TypeScript, JavaScript, TSX, JSX, JSON, CSS, HTML, Python, Bash, YAML) and a copy button. Messages and tool results get their own rows with a status, and the step list has a scroller with a rail and a "Last step" button that follows new steps while you are at the bottom.
- The dashboard files grow from about 0.7 MB to 1.9 MB for the highlighter; the npm package from 422 kB to 592 kB.
- A renamed file whose path starts with `a/` or `b/` keeps its real name in the diff.

### Fixes
- `pitroom init` asks OpenCode for its models twice: the first call can come back empty while OpenCode's service starts, which made init see no models and suggest no fallback.

## 0.7.0

### Codex
- The Codex plugin registers hooks (`hooks/codex-hooks.json`, named in `.codex-plugin/plugin.json`): Pitroom is introduced at session start, so the agent knows it even when Codex drops skill descriptions because many skills are installed, and a job card follows each `pitroom` command. Codex asks you to trust the plugin's hooks once. The hooks go through `pitroom` on PATH (`pitroom hook-start` is new) and stay silent when it is missing. Checked against Codex 0.159.

### CLI
- `pitroom init` proposes a starter config from the worker CLIs and OpenCode models you have: a fallback chain from your free models, tiers when more than one CLI is installed. It never picks your model, and writes only with `--yes` (`--force` to replace a file, which is kept as `.bak`).
- `pitroom doctor` groups its checks (Setup, Worker chain, one section per worker CLI, Skills and agents), ends with one verdict line and a Next list of the commands the findings point to, and warns when the first `node` on PATH is too old. Colour only on a terminal (`NO_COLOR` and `FORCE_COLOR` are honoured); `ls`, `status`, `history` and run reports colour the state too.
- The `pitroom` command is now a small launcher that finds a Node 22.13+ (`PITROOM_NODE`, nvm, Homebrew, `/usr/local`) when the shell's own `node` is old, instead of crashing with a syntax error; without one it says how to fix it.
- A timed-out run's report says what to do: raise the limit with `-t` (or `PITROOM_TIMEOUT`) for a long job, or `--continue`.

### One figure for savings
- The Stats tab (and `pitroom history stats`) takes its saved figures, total, per worker and per day, from the ledger, the same ones the Live tab, `pitroom savings` and the status line add up. They used to be calculated twice and could differ.
- A run that finished while another process was marking it as crashed no longer loses its usage and savings.

### Dashboard
- Cards name the model the worker really ran (what the CLI reported), not just `opencode`; terminal cards do too.
- The close button closes the card (its click used to bubble into the card's open handler and re-open it). The step list scrolls by hand while a worker runs and follows new steps only while you are at the bottom.
- A `#run-id` link opens that run as the same expandable card the lists use, pinned above the page, and clears the link when closed; `/api/run/:id` carries the card. A page opened in a background tab fetched nothing until shown: fixed.
- The state icons explain themselves on hover and focus (a clock is a timeout).
- No `NaN%` for a worker the history has no run for.

## 0.6.10

### Verified answers
- A reference written as a bare file name or a partial path (`ipc.ts:218`, `src/main/ipc.ts:218`) is now looked up in the project, so it no longer counts as "file not found" just because the worker left out the directory. If several files match, one that holds up is enough.
- A call written like a reference (`Schema.parse:432`, `orchestrator.start:638`) is not a file reference and is no longer counted. On a real run this turned "7/18 verified" into "13/13"; the references that really did not match are still reported.

### Safety
- A run warns when the directory its worker runs in holds `.env` files, private keys (`*.pem`, `id_rsa`…) or `credentials.json`: the worker is told not to read them, but nothing stops it. The warning is on the report and when a run starts with `--bg`. For `-i` it names only the files the isolated copy would contain (a git-ignored `.env` is not copied). `PITROOM_NO_SECRET_WARNING=1` silences it.

### Smaller
- OpenCode with no pinned model no longer warns about `--effort` on every run: there is nothing to attach the level to, so it is left out quietly.
- A detached dashboard stops after an hour without a request (it was four hours).
- Every run card shows its worker's logo, and its animated mascot while it runs; the skills tell the agent to open the dashboard in the app's own browser pane (not with `--open`, which launches the system browser).

## 0.6.9

### Dashboard
- Every run card shows which worker ran it: its logo under the state icon, and while the worker is running its animated pixel mascot (Claude Code, Codex and OpenCode; the characters are from [CodeIsland](https://github.com/wxtsky/CodeIsland), MIT, credited in `THIRD_PARTY_NOTICES.md`).

### README
- A short screen recording of the dashboard at the top, and screenshots with the new cards. `scripts/demo-dash.mjs` records it too when `ffmpeg` is installed.

## 0.6.8

### Dashboard
- The History tab lists runs as the same expandable cards as the Live tab (with how long ago each started), so a past run opens in the same panel: task, steps, result, changes, details. The side sheet only remains for a `#run-id` link.
- The Stats tiles fit large amounts (a heavy week no longer overflows the "Est. saved" tile).

### README
- Screenshots of a livelier sample week; the Stats and Live screenshots are no longer captured with a card left open. The sample savings card now adds up with the sample history.

## 0.6.7

### Dashboard
- The expanded run card keeps its header in place and scrolls the rest (a shadcn `ScrollArea`), and its close button sits in the card's corner.
- Scrolling boxes fade out at their edges while there is more to scroll (the expanded card, the result and diff blocks), and so does the window itself.
- A review's card shows a short count of its findings instead of the raw verdict line, and its result starts at the findings; a Task block that only repeats the title is left out.
- The Live filter and the Stats period use the same sliding-pill tabs as the page tabs; the history timestamp tooltip is the themed, keyboard-focusable one; scrollbars are thin and in the theme's colours.
- "Saved" is labelled "Est. saved" with an (i) that says what it is: an estimate against the primary model's list price (`price` in `/api/state` and `/api/stats`), not money back.
- A dashboard left running serves the files of the build on disk: it re-reads them when they change, so an upgrade or rebuild no longer needs a restart to show up. The footer says it stops itself when left idle and how to stop it now.

### Savings card and README
- `pitroom savings --card` draws the card in the dashboard's look (dark surface, orange mark, green savings, bordered tiles).
- The README has a Dashboard section with screenshots of sample data (`scripts/demo-dash.mjs` makes them) and lists the dashboard and the history among the features.

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
