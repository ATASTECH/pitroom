#!/usr/bin/env node

// src/cli.ts
import fs38 from "node:fs";

// src/core/errors.ts
var UserError = class extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
};
var DeletionRefused = class extends UserError {
  constructor(message, files) {
    super(message, 3);
    this.files = files;
  }
};

// src/backends/claude/index.ts
import { spawnSync } from "node:child_process";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/backends/exec.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function findBinary(name, envVar, known = []) {
  const override = process.env[envVar];
  if (override) return override;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, `${name}${ext}`);
      if (isFile(p)) return p;
    }
  }
  return known.map((k) => k.replace(/^~/, os.homedir())).find(isFile) ?? name;
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveCommand(bin) {
  try {
    const real = fs.realpathSync(bin);
    const fd = fs.openSync(real, "r");
    const head = Buffer.alloc(128);
    const n = fs.readSync(fd, head, 0, 128, 0);
    fs.closeSync(fd);
    const firstLine = head.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    if (/^#!.*\bnode\b/.test(firstLine)) return { command: process.execPath, prefix: [real] };
  } catch {
  }
  return { command: bin, prefix: [] };
}

// src/backends/types.ts
var MAX_STEPS = 400;

// src/backends/claude/events.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var DENIED = /permission|not allowed|denied|blocked|disallowed/i;
function parseEvents(jsonl) {
  const usage2 = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    steps: 0,
    toolCalls: 0,
    denied: 0
  };
  const tools = {};
  const edits = [];
  const pendingEdits = /* @__PURE__ */ new Map();
  const timeline = [];
  const stepOf = /* @__PURE__ */ new Map();
  const steps = /* @__PURE__ */ new Set();
  let sessionId;
  let model;
  let lastText = "";
  let finalText;
  let lastActivity;
  let error;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= e.session_id;
    if (e.type === "system" && e.subtype === "init") {
      model = e.model;
    } else if (e.type === "assistant") {
      const content = e.message?.content ?? [];
      if (e.is_api_error_message || e.error) {
        error = content.map((c) => c.text).filter(Boolean).join(" ") || String(e.error);
        if (e.error) error = `${error} [${e.error}]`;
        continue;
      }
      steps.add(String(e.message?.id ?? e.uuid ?? steps.size));
      for (const c of content) {
        if (c.type === "text" && String(c.text ?? "").trim()) {
          lastText = String(c.text).trim();
          lastActivity = `says: ${oneLine(lastText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip(lastText, 600) });
        } else if (c.type === "tool_use") {
          usage2.toolCalls++;
          tools[c.name] = (tools[c.name] ?? 0) + 1;
          const target = c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? c.input?.command ?? c.input?.url;
          lastActivity = `${c.name} ${target ? oneLine(String(target), 60) : ""}`.trim();
          if (EDIT_TOOLS.has(c.name) && c.input?.file_path) pendingEdits.set(c.id, String(c.input.file_path));
          if (timeline.length < MAX_STEPS) {
            const step = { kind: EDIT_TOOLS.has(c.name) ? "edit" : c.name === "Bash" ? "shell" : "tool", name: c.name, text: clip(String(target ?? ""), 240) };
            timeline.push(step);
            stepOf.set(String(c.id), step);
          }
        }
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== "tool_result") continue;
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        const step = stepOf.get(String(c.tool_use_id));
        if (step) step.ok = !c.is_error;
        if (c.is_error) {
          if (DENIED.test(text)) usage2.denied++;
        } else if (pendingEdits.has(c.tool_use_id)) {
          edits.push(pendingEdits.get(c.tool_use_id));
        }
      }
    } else if (e.type === "result") {
      const u = e.usage ?? {};
      usage2.input += num(u.input_tokens);
      usage2.cacheRead += num(u.cache_read_input_tokens);
      usage2.cacheWrite += num(u.cache_creation_input_tokens);
      usage2.reasoning += num(u.output_tokens_details?.thinking_tokens);
      usage2.output += Math.max(0, num(u.output_tokens) - num(u.output_tokens_details?.thinking_tokens));
      usage2.total += num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
      usage2.cost = (usage2.cost ?? 0) + num(e.total_cost_usd);
      usage2.denied = Math.max(usage2.denied, Array.isArray(e.permission_denials) ? e.permission_denials.length : 0);
      if (e.is_error) {
        const tags = [e.terminal_reason, e.api_error_status && `HTTP ${e.api_error_status}`].filter(Boolean);
        error ??= `${String(e.result ?? e.subtype ?? "Claude Code error")}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
      } else if (typeof e.result === "string") {
        finalText = e.result.trim();
      }
    }
  }
  usage2.steps = steps.size;
  return { sessionId, model, finalText: finalText ?? (error ? "" : lastText), usage: usage2, tools, edits, lastActivity, timeline, error };
}
var clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

// src/backends/claude/index.ts
var binary = () => findBinary("claude", "PITROOM_CLAUDE_BIN", ["~/.local/bin/claude", "~/.claude/local/claude"]);
function cl(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var READ_TOOLS = ["Read", "Grep", "Glob"];
var WRITE_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash"];
var WEB_TOOLS = ["WebFetch", "WebSearch"];
var DENY_BASH = [
  "git commit",
  "git push",
  "git pull",
  "git reset",
  "git checkout",
  "git restore",
  "git clean",
  "git stash",
  "git rebase",
  "git merge",
  "git switch",
  "git branch",
  "git tag",
  "git rm",
  "git worktree",
  "git update-ref",
  "git config",
  "git remote",
  "git cherry-pick",
  "git revert",
  "git am",
  "git add",
  "rm -rf",
  "rm -fr",
  "sudo",
  "chown",
  "kill",
  "pkill",
  "killall",
  "gh",
  "npm publish",
  "pitroom",
  "opencode",
  "claude",
  "codex",
  "gemini"
].map((c) => `Bash(${c}:*)`);
var SECRETS = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "**/id_ed25519*"].map((p) => `Read(${p})`);
function toolsFor(mode, web2) {
  return [...mode === "read" ? READ_TOOLS : WRITE_TOOLS, ...web2 ? WEB_TOOLS : []];
}
function invocation(req) {
  const tools = toolsFor(req.mode, req.web).join(",");
  const args = [
    "-p",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    tools,
    "--allowedTools",
    tools
  ];
  if (req.mode !== "read") args.push("--disallowedTools", ...DENY_BASH);
  args.push(
    "--settings",
    JSON.stringify({ permissions: { deny: SECRETS } }),
    // Non-variadic options last, so no list above can swallow what follows.
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "stream-json",
    "--verbose"
  );
  const [model, effort] = (req.model ?? "").split("#");
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (req.sessionId) args.push("--resume", req.sessionId);
  args.push("--", req.prompt);
  const { command, prefix } = resolveCommand(binary());
  return { command, args: [...prefix, ...args], env: { DISABLE_AUTOUPDATER: "1" } };
}
function classify(message) {
  if (/authentication_failed|failed to authenticate|oauth|not logged in|\/login|invalid api key|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/rate.?limit|too many requests|\b429\b|\b529\b|overloaded|usage limit|limit reached|quota|capacity/i.test(message)) return "rate-limited";
  if (/model[^.]*(not found|does not exist|invalid|not available)|invalid model|not_found_error/i.test(message)) return "model-unavailable";
  return "other";
}
function failure(run2, stderr, exitCode) {
  if (exitCode === 0 && !run2.error) return void 0;
  const detail = stderr.trim().split("\n").filter(Boolean).pop();
  const message = run2.error ?? detail ?? `claude exited with code ${exitCode}`;
  return { kind: classify(message), message };
}
function defaultModel() {
  try {
    const settings2 = JSON.parse(fs2.readFileSync(path2.join(os2.homedir(), ".claude", "settings.json"), "utf8"));
    return typeof settings2.model === "string" ? settings2.model : void 0;
  } catch {
    return void 0;
  }
}
function doctor({ models, hasFallback }) {
  const version = cl(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `claude not runnable (${binary()}). Install Claude Code, or set PITROOM_CLAUDE_BIN` }];
  }
  const checks = [{ level: "ok", message: `Claude Code ${version.out.trim()} at ${binary()}` }];
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(cl(["auth", "status"]).out).loggedIn === true;
  } catch {
  }
  checks.push(
    loggedIn || process.env.ANTHROPIC_API_KEY ? { level: "ok", message: `Claude Code: ${loggedIn ? "logged in" : "ANTHROPIC_API_KEY set"}` } : { level: "fail", message: "Claude Code is not logged in (or the session expired): run `claude auth login`" }
  );
  for (const m of models) {
    const model = m ?? defaultModel();
    const pricey = model && /opus|fable/i.test(model);
    checks.push({
      level: pricey ? "warn" : "ok",
      message: pricey ? `Claude Code model: ${model} is the most expensive tier for a worker; consider -W claude:haiku or claude:sonnet` : model ? `Claude Code model: ${model}` : "Claude Code model: Claude Code's default (often the largest model; a cheaper worker is -W claude:haiku)"
    });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Claude Code runs" });
  return checks;
}
var CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function catalog() {
  const def = defaultModel();
  const models = ["haiku", "sonnet", "opus"].map((id) => ({ id, efforts: CLAUDE_EFFORTS }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def, efforts: CLAUDE_EFFORTS });
  return { models, source: "Claude Code aliases (latest of each size) and --effort levels from `claude --help`" };
}
var claude = {
  id: "claude",
  name: "Claude Code",
  capabilities: { readOnly: "tool-allowlist", resume: "by-id", reportsCost: true, attachFiles: false },
  binary,
  catalog,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  doctor
};

// src/backends/codex/index.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import fs3 from "node:fs";
import os3 from "node:os";
import path3 from "node:path";

// src/backends/codex/events.ts
var WORK = /* @__PURE__ */ new Set(["agent_message", "reasoning", "command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"]);
var TOOLS = /* @__PURE__ */ new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
function parseEvents2(jsonl) {
  const usage2 = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    steps: 0,
    toolCalls: 0,
    denied: 0
  };
  const tools = {};
  const edits = [];
  const timeline = [];
  let sessionId;
  let finalText = "";
  let lastActivity;
  let error;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    switch (e.type) {
      case "thread.started":
        sessionId ??= e.thread_id;
        break;
      case "item.completed": {
        const it = e.item ?? {};
        if (!WORK.has(it.type)) break;
        usage2.steps++;
        if (TOOLS.has(it.type)) {
          usage2.toolCalls++;
          tools[it.type] = (tools[it.type] ?? 0) + 1;
        }
        if (it.type === "agent_message" && String(it.text ?? "").trim()) {
          finalText = String(it.text).trim();
          lastActivity = `says: ${oneLine2(finalText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip2(finalText, 600) });
        } else if (it.type === "command_execution") {
          if (it.status === "declined" || /operation not permitted|sandbox/i.test(String(it.aggregated_output ?? ""))) usage2.denied++;
          lastActivity = `shell ${oneLine2(String(it.command ?? ""), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "shell", name: "shell", text: clip2(String(it.command ?? "").replace(/^\/bin\/\w+ -lc /, ""), 240), ok: it.exit_code === 0 });
        } else if (it.type === "file_change") {
          const paths = (it.changes ?? []).map((c) => String(c.path));
          if (it.status !== "failed" && it.status !== "declined") edits.push(...paths);
          else usage2.denied++;
          lastActivity = `edit ${oneLine2(paths.join(", "), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "edit", name: "edit", text: clip2(paths.join(", "), 240), ok: it.status !== "failed" && it.status !== "declined" });
        }
        break;
      }
      case "turn.completed": {
        const u = e.usage ?? {};
        const cached4 = num2(u.cached_input_tokens);
        const reasoning = num2(u.reasoning_output_tokens);
        usage2.input += Math.max(0, num2(u.input_tokens) - cached4);
        usage2.cacheRead += cached4;
        usage2.cacheWrite += num2(u.cache_write_input_tokens);
        usage2.output += Math.max(0, num2(u.output_tokens) - reasoning);
        usage2.reasoning += reasoning;
        usage2.total += num2(u.input_tokens) + num2(u.output_tokens);
        break;
      }
      case "error":
        error = describe(e.message);
        break;
      case "turn.failed":
        error = describe(e.error?.message ?? e.message);
        break;
    }
  }
  return { sessionId, finalText, usage: usage2, tools, edits, lastActivity, timeline, error };
}
function describe(raw) {
  const s = String(raw ?? "unknown Codex error");
  try {
    const j = JSON.parse(s);
    const inner = j.error ?? j;
    const tags = [inner.type, j.status && `HTTP ${j.status}`].filter(Boolean);
    return `${inner.message ?? s}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
  } catch {
    return s;
  }
}
function num2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine2(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}
var clip2 = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;

// src/backends/codex/index.ts
var binary2 = () => findBinary("codex", "PITROOM_CODEX_BIN");
var codexHome = () => process.env.CODEX_HOME ?? path3.join(os3.homedir(), ".codex");
function cx(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary2());
  const r = spawnSync2(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, missing: !!r.error };
}
var SANDBOX = { read: "read-only", write: "workspace-write", isolate: "workspace-write" };
var toml = (s) => JSON.stringify(s);
function splitModel(model) {
  if (!model) return {};
  const [m, effort] = model.split("#");
  return { model: m || void 0, effort: effort || void 0 };
}
function invocation2(req) {
  const { model, effort } = splitModel(req.model);
  const args = ["exec"];
  if (req.sessionId) args.push("resume", req.sessionId);
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-c",
    `sandbox_mode=${toml(SANDBOX[req.mode])}`,
    "-c",
    'approval_policy="never"'
  );
  if (req.web) args.push("-c", 'web_search="live"');
  if (model) args.push("--model", model);
  if (effort) args.push("-c", `model_reasoning_effort=${toml(effort)}`);
  args.push(req.prompt);
  const { command, prefix } = resolveCommand(binary2());
  return { command, args: [...prefix, ...args], env: {} };
}
function classify2(message) {
  if (/not supported|model[^.]*(not found|does not exist|unknown|unavailable)|unsupported model|no such model/i.test(message)) {
    return "model-unavailable";
  }
  if (/rate.?limit|too many requests|\b429\b|usage limit|quota|overloaded|\b50[23]\b|capacity/i.test(message)) return "rate-limited";
  if (/unauthori[sz]ed|\b40[13]\b|not logged in|log ?in|api.?key|credits?\b|billing|subscription/i.test(message)) return "auth";
  return "other";
}
function failure2(run2, stderr, exitCode) {
  if (exitCode === 0 && !run2.error) return void 0;
  const detail = stderr.split("\n").find((l) => /^Error[: ]|ERROR/.test(l) && !/rmcp|models cache/.test(l));
  let message = run2.error ?? (detail ? detail.trim() : `codex exited with code ${exitCode}`);
  if (/not supported when using Codex/i.test(message)) message += " (an outdated Codex CLI says this too: npm i -g @openai/codex@latest)";
  return { kind: classify2(message), message };
}
function resolveModel(sessionId) {
  const root = path3.join(codexHome(), "sessions");
  const day = (d) => path3.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  const now = /* @__PURE__ */ new Date();
  for (const dir of [day(now), day(new Date(now.getTime() - 864e5))]) {
    let files = [];
    try {
      files = fs3.readdirSync(dir).filter((f) => f.includes(sessionId));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /"model":"([^"]+)"/.exec(fs3.readFileSync(path3.join(dir, f), "utf8"));
      if (m) return m[1];
    }
  }
  return void 0;
}
function doctor2({ models, hasFallback }) {
  const version = cx(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `codex not runnable (${binary2()}). Install: npm i -g @openai/codex, or set PITROOM_CODEX_BIN` }];
  }
  const checks = [{ level: "ok", message: `${version.out.trim()} at ${binary2()}` }];
  const login = cx(["login", "status"]);
  checks.push(
    login.ok && /logged in/i.test(login.out) ? { level: "ok", message: `Codex: ${login.out.trim().split("\n")[0]}` } : { level: "fail", message: "Codex is not logged in: run `codex login`" }
  );
  for (const m of models) {
    const pinned = m?.replace(/#.*$/, "");
    checks.push({
      level: pinned ? "ok" : "warn",
      message: pinned ? `Codex model: ${pinned} (checked on first use; unsupported models fail over)` : 'Codex model: none pinned, so Codex runs its own default (it can change and cost more); set "models": {"codex": "<model>"} or use -W codex:<model>'
    });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Codex runs" });
  return checks;
}
function catalog2() {
  const file2 = path3.join(codexHome(), "models_cache.json");
  try {
    const raw = JSON.parse(fs3.readFileSync(file2, "utf8"));
    const models = (raw.models ?? []).filter((m) => m.visibility !== "hide" && typeof m.slug === "string").map((m) => ({
      id: m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map(
        (l) => typeof l === "string" ? l : l.effort ?? ""
      ).filter(Boolean),
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : void 0
    }));
    return { models, source: `Codex model cache${raw.fetched_at ? `, fetched ${raw.fetched_at.slice(0, 10)}` : ""}` };
  } catch {
    return { models: [], source: "no Codex model cache found (run codex once)" };
  }
}
var codex = {
  id: "codex",
  name: "Codex",
  catalog: catalog2,
  capabilities: { readOnly: "os-sandbox", resume: "by-id", reportsCost: false, attachFiles: false },
  binary: binary2,
  invocation: invocation2,
  parse: parseEvents2,
  failure: failure2,
  resolveModel,
  doctor: doctor2
};

// src/backends/gemini/index.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import fs6 from "node:fs";
import os5 from "node:os";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// src/core/store.ts
import fs5 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
import crypto from "node:crypto";

// src/core/fs-atomic.ts
import fs4 from "node:fs";
var BUSY = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
function renameOver(tmp, file2) {
  for (let attempt3 = 0; ; attempt3++) {
    try {
      fs4.renameSync(tmp, file2);
      return;
    } catch (e) {
      if (process.platform !== "win32" || !BUSY.has(e.code ?? "") || attempt3 >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// src/core/store.ts
var TERMINAL = ["done", "failed", "timeout", "stopped"];
var isActive = (s) => !TERMINAL.includes(s);
function home() {
  if (process.env.PITROOM_HOME) return path4.resolve(process.env.PITROOM_HOME);
  if (process.platform === "win32") {
    return path4.join(process.env.LOCALAPPDATA ?? path4.join(os4.homedir(), "AppData", "Local"), "pitroom");
  }
  return path4.join(process.env.XDG_STATE_HOME ?? path4.join(os4.homedir(), ".local", "state"), "pitroom");
}
var runsDir = () => path4.join(home(), "runs");
var worktreesDir = () => path4.join(home(), "worktrees");
var ledgerFile = () => path4.join(home(), "ledger.jsonl");
var runDir = (id) => path4.join(runsDir(), id);
var runFile = (id, name) => path4.join(runDir(id), name);
function newRunId(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp2 = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp2}-${crypto.randomBytes(2).toString("hex")}`;
}
var onFinished;
var archive;
function useArchive(hooks) {
  onFinished = hooks.onFinished;
  archive = { meta: hooks.meta, id: hooks.id };
}
function writeMeta(meta) {
  fs5.mkdirSync(runDir(meta.id), { recursive: true });
  const file2 = runFile(meta.id, "meta.json");
  const tmp = `${file2}.${process.pid}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameOver(tmp, file2);
  if (TERMINAL.includes(meta.state)) {
    try {
      onFinished?.(meta);
    } catch {
    }
  }
}
function readMeta(id) {
  const file2 = runFile(id, "meta.json");
  if (!fs5.existsSync(file2)) {
    const kept = archive?.meta(id);
    if (kept) return upgrade(kept);
  }
  return upgrade(JSON.parse(fs5.readFileSync(file2, "utf8")));
}
function upgrade(raw) {
  if (!raw.worker) raw.worker = raw.model ? { backend: "opencode", model: raw.model } : { backend: "opencode" };
  if (!Array.isArray(raw.fallback)) {
    raw.fallback = (raw.fallbackModels ?? []).map((m) => ({ backend: "opencode", model: m }));
  }
  raw.warnings ??= [];
  raw.files ??= [];
  raw.link ??= [];
  return raw;
}
function listRunIds() {
  if (!fs5.existsSync(runsDir())) return [];
  return fs5.readdirSync(runsDir()).filter((d) => fs5.existsSync(runFile(d, "meta.json"))).sort();
}
function resolveRun(ref) {
  const ids = listRunIds();
  if (!ref || ref === "latest" || ref === "last") {
    if (!ids.length) throw new UserError("no runs yet");
    return ids[ids.length - 1];
  }
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((id) => id.startsWith(ref) || id.endsWith(ref));
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    const kept = archive?.id(ref);
    if (kept) return kept;
  }
  throw new UserError(hits.length ? `ambiguous run "${ref}": ${hits.join(", ")}` : ids.length ? `unknown run "${ref}"` : "no runs yet");
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
var STOP_FILE = "stop-requested";
var requestStop = (id) => fs5.writeFileSync(runFile(id, STOP_FILE), "");
function freshMeta(id) {
  const meta = readMeta(id);
  if (!TERMINAL.includes(meta.state) && meta.pid && !isAlive(meta.pid)) {
    const latest = readMeta(id);
    if (TERMINAL.includes(latest.state)) return latest;
    const stopped = latest.stopRequested || fs5.existsSync(runFile(id, STOP_FILE));
    latest.state = stopped ? "stopped" : "failed";
    if (!stopped) latest.error ??= "worker process exited unexpectedly";
    latest.endedAt ??= (/* @__PURE__ */ new Date()).toISOString();
    writeMeta(latest);
    return latest;
  }
  return meta;
}

// src/backends/gemini/events.ts
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["replace", "write_file", "edit"]);
var DENIED2 = /policy|permission|not allowed|denied|blocked|disallowed|refus/i;
function parseEvents3(jsonl) {
  const usage2 = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    steps: 0,
    toolCalls: 0,
    denied: 0
  };
  const tools = {};
  const edits = [];
  const pendingEdits = /* @__PURE__ */ new Map();
  const timeline = [];
  const stepOf = /* @__PURE__ */ new Map();
  let sessionId;
  let model;
  let text = "";
  let lastText = "";
  let lastActivity;
  let error;
  let turns = 0;
  let inTurn = false;
  const flush = () => {
    const said = text.trim();
    text = "";
    if (!said) return;
    lastText = said;
    lastActivity = `says: ${oneLine3(said)}`;
    if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip3(said, 600) });
  };
  const startTurn = () => {
    if (!inTurn) turns++;
    inTurn = true;
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    if (e.type === "init") {
      sessionId ??= e.session_id;
      model ??= e.model;
    } else if (e.type === "message") {
      if (e.role !== "assistant") continue;
      startTurn();
      if (!e.delta && text) flush();
      text += String(e.content ?? "");
    } else if (e.type === "tool_use") {
      flush();
      lastText = "";
      startTurn();
      const name = String(e.tool_name ?? "tool");
      const p = e.parameters ?? {};
      usage2.toolCalls++;
      tools[name] = (tools[name] ?? 0) + 1;
      const target = p.file_path ?? p.absolute_path ?? p.path ?? p.dir_path ?? p.pattern ?? p.command ?? p.query ?? p.url ?? p.prompt;
      lastActivity = `${name} ${target ? oneLine3(String(target), 60) : ""}`.trim();
      const file2 = p.file_path ?? p.absolute_path ?? p.path;
      if (EDIT_TOOLS2.has(name) && file2) pendingEdits.set(String(e.tool_id), String(file2));
      if (timeline.length < MAX_STEPS) {
        const step = { kind: EDIT_TOOLS2.has(name) ? "edit" : name === "run_shell_command" ? "shell" : "tool", name, text: clip3(String(target ?? ""), 240) };
        timeline.push(step);
        stepOf.set(String(e.tool_id), step);
      }
    } else if (e.type === "tool_result") {
      inTurn = false;
      const ok = e.status === "success";
      const step = stepOf.get(String(e.tool_id));
      if (step) step.ok = ok;
      if (!ok && DENIED2.test(`${e.error?.type ?? ""} ${e.error?.message ?? ""}`)) usage2.denied++;
      if (ok && pendingEdits.has(String(e.tool_id))) edits.push(pendingEdits.get(String(e.tool_id)));
    } else if (e.type === "error") {
      if (e.severity === "error") error ??= String(e.message ?? "Gemini CLI error");
    } else if (e.type === "result") {
      const s = e.stats ?? {};
      const cached4 = num3(s.cached);
      usage2.cacheRead += cached4;
      usage2.input += s.input !== void 0 ? num3(s.input) : Math.max(0, num3(s.input_tokens) - cached4);
      usage2.output += num3(s.output_tokens);
      usage2.total += num3(s.total_tokens) || num3(s.input_tokens) + num3(s.output_tokens);
      usage2.toolCalls = Math.max(usage2.toolCalls, num3(s.tool_calls));
      model ??= Object.keys(s.models ?? {})[0];
      if (e.status === "error") error ??= String(e.error?.message ?? e.error?.type ?? "Gemini CLI error");
    }
  }
  flush();
  usage2.steps = turns;
  return { sessionId, model, finalText: error ? "" : lastText, usage: usage2, tools, edits, lastActivity, timeline, error };
}
var clip3 = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
function num3(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine3(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

// src/backends/gemini/index.ts
var binary3 = () => findBinary("gemini", "PITROOM_GEMINI_BIN", ["~/.local/bin/gemini"]);
function gem(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary3());
  const r = spawnSync3(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var policyDir = () => path5.resolve(path5.dirname(fileURLToPath(import.meta.url)), "..", "policies", "gemini");
function workerHome() {
  const root = path5.join(home(), "gemini-home");
  const dir = path5.join(root, ".gemini");
  const base2 = JSON.parse(fs6.readFileSync(path5.join(policyDir(), "worker-settings.json"), "utf8"));
  const auth = settings().security?.auth;
  const body = `${JSON.stringify(auth ? { ...base2, security: { ...base2.security, auth } } : base2, null, 2)}
`;
  const file2 = path5.join(dir, "settings.json");
  try {
    if (fs6.readFileSync(file2, "utf8") === body) return root;
  } catch {
  }
  fs6.mkdirSync(dir, { recursive: true });
  fs6.writeFileSync(file2, body);
  for (const name of ["oauth_creds.json", "google_accounts.json"]) {
    const from = path5.join(geminiHome(), name);
    const to = path5.join(dir, name);
    try {
      if (fs6.existsSync(from) && !fs6.existsSync(to)) fs6.symlinkSync(from, to);
    } catch {
    }
  }
  return root;
}
function invocation3(req) {
  const dir = policyDir();
  const policies = ["base.toml", ...req.web ? [] : ["no-web.toml"], ...req.mode === "read" ? [] : ["shell.toml"]];
  const args = [
    // A prompt that starts with "-" would be read as an option: a leading space keeps it a value.
    "--prompt",
    req.prompt.startsWith("-") ? ` ${req.prompt}` : req.prompt,
    "--output-format",
    "stream-json",
    "--approval-mode",
    req.mode === "read" ? "plan" : "auto_edit",
    "-e",
    "none"
  ];
  for (const p of policies) args.push("--policy", path5.join(dir, p));
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (process.env.PITROOM_GEMINI_TRUST === "1") args.push("--skip-trust");
  const [model] = (req.model ?? "").split("#");
  if (model) args.push("--model", model);
  const { command, prefix } = resolveCommand(binary3());
  const env = { GEMINI_CLI_HOME: workerHome() };
  const trusted = path5.join(geminiHome(), "trustedFolders.json");
  if (fs6.existsSync(trusted)) env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = trusted;
  return { command, args: [...prefix, ...args], env };
}
function classify3(message) {
  if (/IneligibleTier|no longer supported for Gemini|error authenticating|not logged in|please (log ?in|sign in)|credentials|api key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|exhausted your capacity|capacity/i.test(message)) return "rate-limited";
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unsupported|invalid)|\b404\b|NOT_FOUND|invalid model|is not supported/i.test(message)) return "model-unavailable";
  return "other";
}
var UNTRUSTED = "Gemini CLI does not trust this folder: open `gemini` in it once and trust it, or set PITROOM_GEMINI_TRUST=1 (the folder's own Gemini settings, hooks included, then load)";
function failure3(run2, stderr, exitCode) {
  if (exitCode === 0 && !run2.error) return void 0;
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const raw = run2.error ?? detail ?? `gemini exited with code ${exitCode}`;
  const message = /not running in a trusted directory/i.test(`${stderr} ${raw}`) ? UNTRUSTED : raw;
  return { kind: classify3(message), message };
}
function geminiHome() {
  return path5.join(process.env.GEMINI_CLI_HOME ?? os5.homedir(), ".gemini");
}
function settings() {
  try {
    return JSON.parse(fs6.readFileSync(path5.join(geminiHome(), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}
function defaultModel2() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const m = settings().model;
  const name = typeof m === "string" ? m : m?.name;
  return typeof name === "string" ? name : void 0;
}
function doctor3({ models, hasFallback }) {
  const version = gem(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `gemini not runnable (${binary3()}). Install Gemini CLI (npm i -g @google/gemini-cli), or set PITROOM_GEMINI_BIN` }];
  }
  const checks = [{ level: "ok", message: `Gemini CLI ${version.out.trim()} at ${binary3()}` }];
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const vertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" || process.env.GOOGLE_GENAI_USE_VERTEXAI === "1";
  const signedIn = fs6.existsSync(path5.join(geminiHome(), "oauth_creds.json"));
  const type = settings().security?.auth?.selectedType;
  if (key || vertex) {
    checks.push({ level: "ok", message: `Gemini CLI: ${key ? "an API key is set" : "Vertex AI is set up"}` });
  } else if (type === "gemini-api-key" || type === "vertex-ai") {
    checks.push({ level: "ok", message: `Gemini CLI: ${type === "vertex-ai" ? "Vertex AI" : "an API key"} is selected (kept by Gemini CLI)` });
  } else if (signedIn && type === "oauth-personal") {
    checks.push({
      level: "warn",
      message: "Gemini CLI is signed in with a Google account (oauth-personal). If a run fails with IneligibleTierError, Google no longer serves that sign-in to this CLI: set GEMINI_API_KEY (Google AI Studio) instead"
    });
  } else if (signedIn) {
    checks.push({ level: "ok", message: "Gemini CLI: signed in" });
  } else {
    checks.push({ level: "fail", message: "Gemini CLI is not signed in: run `gemini` once to sign in, or set GEMINI_API_KEY (Google AI Studio)" });
  }
  for (const m of models) {
    const model = m ?? defaultModel2();
    const pricey = model && /pro/i.test(model);
    checks.push({
      level: pricey ? "warn" : "ok",
      message: pricey ? `Gemini model: ${model} is the largest tier for a worker; consider -W gemini:gemini-3.8-flash` : model ? `Gemini model: ${model}` : "Gemini model: Gemini CLI's own choice (it may pick a Pro model; a cheaper worker is -W gemini:gemini-3.8-flash)"
    });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Gemini runs" });
  return checks;
}
function catalog3() {
  const def = defaultModel2();
  const models = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview"].map((id) => ({ id }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def });
  return { models, source: "Gemini CLI's built-in model names (it cannot list models); the effort suffix is not used" };
}
var gemini = {
  id: "gemini",
  name: "Gemini CLI",
  capabilities: { readOnly: "approval-mode", resume: "by-id", reportsCost: false, attachFiles: false },
  binary: binary3,
  catalog: catalog3,
  invocation: invocation3,
  parse: parseEvents3,
  failure: failure3,
  defaultModel: defaultModel2,
  doctor: doctor3
};

// src/backends/opencode/index.ts
import { spawnSync as spawnSync4 } from "node:child_process";

// src/backends/opencode/events.ts
var EDIT_TOOLS3 = /* @__PURE__ */ new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
var DENIED3 = /rule which prevents you|permission denied|permission\.rejected/i;
function parseEvents4(ndjson) {
  const usage2 = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    steps: 0,
    toolCalls: 0,
    denied: 0
  };
  const tools = {};
  const edits = [];
  const timeline = [];
  const textByMessage = /* @__PURE__ */ new Map();
  let sessionId;
  let lastActivity;
  let error;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= e.sessionID ?? e.part?.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "text": {
        const text = String(p.text ?? "");
        if (!text.trim()) break;
        const key = String(p.messageID ?? "");
        if (!textByMessage.has(key)) textByMessage.set(key, []);
        textByMessage.get(key).push(text);
        lastActivity = `says: ${oneLine4(text)}`;
        if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip4(text.trim(), 600), at: stamp(e.timestamp) });
        break;
      }
      case "tool_use": {
        const name = String(p.tool ?? "tool");
        const st = p.state ?? {};
        usage2.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === "error" && DENIED3.test(String(st.error ?? ""))) usage2.denied++;
        if (st.status === "completed" && EDIT_TOOLS3.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe2(st.input)}`.trim();
        if (timeline.length < MAX_STEPS) {
          const kind2 = EDIT_TOOLS3.has(name) ? "edit" : /^(bash|shell)$/.test(name) ? "shell" : "tool";
          const text = kind2 === "shell" ? String(st.input?.command ?? "") : String(st.input?.filePath ?? st.input?.path ?? st.input?.pattern ?? st.input?.url ?? "") || describe2(st.input);
          timeline.push({ kind: kind2, name, text: clip4(text, 240), ok: st.status === "completed" ? true : st.status === "error" ? false : void 0, at: stamp(e.timestamp) });
        }
        break;
      }
      case "step_finish": {
        const t = p.tokens ?? {};
        usage2.steps++;
        usage2.input += num4(t.input);
        usage2.output += num4(t.output);
        usage2.reasoning += num4(t.reasoning);
        usage2.cacheRead += num4(t.cache?.read);
        usage2.cacheWrite += num4(t.cache?.write);
        usage2.total += num4(t.total) || num4(t.input) + num4(t.output) + num4(t.reasoning) + num4(t.cache?.read);
        usage2.cost = (usage2.cost ?? 0) + num4(p.cost);
        break;
      }
      case "error": {
        error = describeError(e.error);
        break;
      }
    }
  }
  const groups = [...textByMessage.values()];
  const finalText = (groups[groups.length - 1] ?? []).join("\n").trim();
  return { sessionId, finalText, usage: usage2, tools, edits, lastActivity, timeline, error };
}
function describeError(err) {
  if (!err || typeof err !== "object") return "unknown OpenCode error";
  const message = String(err.data?.message ?? err.message ?? err.name ?? "unknown OpenCode error");
  let inner;
  try {
    inner = JSON.parse(err.response?.body ?? "{}")?.error?.type;
  } catch {
  }
  const tags = [err.type, inner, err.status && `HTTP ${err.status}`].filter(Boolean);
  return tags.length ? `${message} [${tags.join(", ")}]` : message;
}
var clip4 = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
var stamp = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function num4(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine4(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}
function describe2(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v ? oneLine4(String(v), 60) : "";
}

// src/backends/opencode/profiles.ts
import fs7 from "node:fs";
import os6 from "node:os";
import path6 from "node:path";
var AGENT = { read: "pitroom-read", write: "pitroom-write" };
var READ_FILES = {
  "*": "allow",
  // Keep secrets away from third-party / free model providers.
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
  "*.env.sample": "allow",
  "*.pem": "deny",
  "*id_rsa*": "deny",
  "*id_ed25519*": "deny"
};
var READ_ONLY_BASH = {
  "*": "deny",
  "git status*": "allow",
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git grep*": "allow",
  "git blame*": "allow",
  "git ls-files*": "allow",
  "ls*": "allow",
  pwd: "allow",
  "rg *": "allow",
  "wc *": "allow",
  // Flags that would let "read" commands execute or write.
  "rg *--pre*": "deny",
  "git *--output*": "deny",
  "git *--ext-diff*": "deny"
};
var FORBIDDEN_BASH = [
  // history, branches and anything that can discard uncommitted work
  "git commit*",
  "git push*",
  "git reset*",
  "git checkout*",
  "git restore*",
  "git clean*",
  "git stash*",
  "git rebase*",
  "git merge*",
  "git switch*",
  "git branch*",
  "git tag*",
  "git rm*",
  "git worktree*",
  "git update-ref*",
  "git filter-branch*",
  "git filter-repo*",
  "git gc*",
  "git prune*",
  "git reflog*",
  "git config*",
  "git remote*",
  "git cherry-pick*",
  "git revert*",
  "git am*",
  "git add*",
  "git mv*",
  "git pull*",
  "git -C*",
  "git --git-dir*",
  "git --work-tree*",
  // git by absolute path would bypass the PATH shim (see guard.ts)
  "/*/git*",
  // bulk deletion and privilege
  "rm -rf*",
  "rm -fr*",
  "rm -r *",
  "rm -R *",
  "rm --recursive*",
  "sudo *",
  "su *",
  "doas *",
  "chown *",
  "chmod -R*",
  "dd *",
  "mkfs*",
  "shutdown*",
  "reboot*",
  // killing processes could kill the primary agent
  "kill *",
  "pkill*",
  "killall*",
  // publishing / remote side effects
  "gh *",
  "npm publish*",
  "pnpm publish*",
  "yarn publish*",
  "cargo publish*",
  "twine upload*",
  // no recursive delegation
  "opencode*",
  "pitroom *",
  "*pitroom*"
];
function scratchDirs() {
  const data = process.env.XDG_DATA_HOME ?? path6.join(os6.homedir(), ".local", "share");
  const rules = {
    "*": "deny",
    [path6.join(data, "opencode", "tool-output", "*")]: "allow",
    [path6.join(data, "opencode", "shell", "*", "*")]: "allow"
  };
  for (const tmp of /* @__PURE__ */ new Set([os6.tmpdir(), realpath(os6.tmpdir())])) rules[path6.join(tmp, "opencode", "*")] = "allow";
  return rules;
}
function realpath(p) {
  try {
    return fs7.realpathSync(p);
  } catch {
    return p;
  }
}
var COMMON = {
  skill: { "*": "allow", "*pitroom*": "deny" },
  task: "deny",
  // subagents carry their own, broader permissions
  // v2 "execute" runs namespaced tools (browser automation, the OpenCode API itself).
  execute: "deny",
  question: "deny",
  // nobody is there to answer
  doom_loop: "deny"
};
var web = (on) => ({ webfetch: on ? "allow" : "deny", websearch: on ? "allow" : "deny" });
function readProfile(allowWeb = false) {
  return {
    "*": "deny",
    read: READ_FILES,
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    codesearch: "allow",
    todowrite: "allow",
    todoread: "allow",
    ...web(allowWeb),
    // v1 calls the shell tool "bash", v2 "shell"; both get the same rules.
    bash: READ_ONLY_BASH,
    shell: READ_ONLY_BASH,
    edit: "deny",
    external_directory: scratchDirs(),
    ...COMMON
  };
}
function writeProfile(allowWeb = false) {
  const bash = { "*": "allow" };
  for (const pattern of FORBIDDEN_BASH) bash[pattern] = "deny";
  return {
    "*": "allow",
    read: READ_FILES,
    ...web(allowWeb),
    bash,
    shell: bash,
    external_directory: scratchDirs(),
    ...COMMON
  };
}
function agentFor(mode) {
  return mode === "read" ? AGENT.read : AGENT.write;
}
function configContent(existing, allowWeb = false) {
  const ours = {
    agent: {
      [AGENT.read]: {
        mode: "primary",
        description: "pitroom: read-only worker (research, search, review)",
        permission: readProfile(allowWeb)
      },
      [AGENT.write]: {
        mode: "primary",
        description: "pitroom: editing worker (no git history changes, no bulk deletes)",
        permission: writeProfile(allowWeb)
      }
    }
  };
  let base2 = {};
  if (existing?.trim()) {
    try {
      base2 = JSON.parse(existing);
    } catch {
      base2 = {};
    }
  }
  return JSON.stringify(deepMerge(base2, ours));
}
function deepMerge(a, b) {
  if (!isObject(a) || !isObject(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// src/backends/opencode/index.ts
var binary4 = () => findBinary("opencode", "PITROOM_OPENCODE_BIN", ["~/.opencode/bin/opencode"]);
function oc(args, opts = {}) {
  const { command, prefix } = resolveCommand(binary4());
  const r = spawnSync4(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 6e4,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var jsonIn = (s) => JSON.parse(s.slice(s.indexOf("{")));
function invocation4(req) {
  const args = [
    "run",
    "--standalone",
    "--agent",
    agentFor(req.mode),
    "--format",
    "json",
    "--title",
    req.title,
    // Some failure causes only appear in the server logs.
    "--print-logs",
    "--log-level",
    "error"
  ];
  if (req.model) args.push("--model", req.model);
  if (req.sessionId) args.push("--session", req.sessionId);
  for (const f of req.files) args.push("--file", f);
  args.push(req.prompt);
  const { command, prefix } = resolveCommand(binary4());
  return {
    command,
    args: [...prefix, ...args],
    env: {
      OPENCODE_CONFIG_CONTENT: configContent(process.env.OPENCODE_CONFIG_CONTENT, req.web),
      // A worker run must not upgrade OpenCode underneath the user.
      OPENCODE_DISABLE_AUTOUPDATE: "1"
    }
  };
}
function majorVersion(output) {
  const m = /(\d+)\.\d+\.\d+/.exec(output);
  return m ? Number(m[1]) : void 0;
}
function classify4(message) {
  if (/model not found|ModelNotFound|unknown model|no such model|deprecated/i.test(message)) return "model-unavailable";
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded|\b50[23]\b|unavailable|capacity/i.test(message)) return "rate-limited";
  if (/provider\.auth|FreeTierError|free tier|unauthori[sz]ed|\b40[13]\b|api.?key|insufficient|credits?\b|billing|payment/i.test(message)) {
    return "auth";
  }
  return "other";
}
function failure4(run2, stderr, exitCode) {
  if (exitCode === 0 && !run2.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run2.error ?? `opencode exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify4(message), message };
}
function modelId(m) {
  if (typeof m === "string") return m;
  const id = m?.model ?? m?.id;
  return m?.providerID && id ? `${m.providerID}/${id}` : void 0;
}
function defaultModel3() {
  try {
    const out = oc(["debug", "config"], { timeout: 3e4 }).out;
    const json = JSON.parse(out.slice(out.search(/[[{]/)));
    if (Array.isArray(json)) {
      const withModel = json.filter((s) => s?.info?.model);
      return modelId(withModel[withModel.length - 1]?.info.model);
    }
    return modelId(json.model);
  } catch {
    return void 0;
  }
}
function resolveModel2(sessionId) {
  try {
    const json = jsonIn(oc(["session", "export", sessionId], { timeout: 2e4 }).out);
    const msgs = [...json.messages ?? []].reverse();
    const v2 = msgs.find((m) => m.type === "assistant" && m.model)?.model;
    if (v2) return modelId(v2);
    const v1 = msgs.find((m) => m.info?.role === "assistant")?.info;
    return v1?.providerID && v1?.modelID ? `${v1.providerID}/${v1.modelID}` : void 0;
  } catch {
    return void 0;
  }
}
function catalog4() {
  const ids = listModels();
  return {
    models: (ids.length ? ids : listModels()).map((id) => ({ id })),
    source: "`opencode models` (reasoning variants are provider-specific: provider/model#variant)"
  };
}
function listModels() {
  return oc(["models"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
}
function doctor4({ models, hasFallback }) {
  const checks = [];
  const version = oc(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `opencode not runnable (${binary4()}). Install: https://opencode.ai or set PITROOM_OPENCODE_BIN` }];
  }
  const v = version.out.trim().replace(/^opencode\s+/i, "");
  const major = majorVersion(v);
  if (major !== void 0 && major < 2) {
    return [{ level: "fail", message: `OpenCode ${v} is too old: Pitroom needs OpenCode v2 or newer (run \`opencode upgrade\`)` }];
  }
  checks.push({ level: "ok", message: `opencode ${v} at ${binary4()} (private --standalone server per run)` });
  const known = new Set(listModels());
  const def = defaultModel3();
  for (const m of models) {
    const model = m ?? def;
    const label = m ? "model" : "default model";
    if (!model) {
      checks.push({ level: "warn", message: 'OpenCode has no default model; it will pick one (set "model" in opencode.json)' });
    } else if (known.size && !known.has(model)) {
      checks.push({ level: "fail", message: `OpenCode ${label} "${model}" is not in \`opencode models\`` });
    } else {
      checks.push({ level: "ok", message: `OpenCode ${label}: ${model}` });
    }
  }
  if (!hasFallback) {
    const free = [...known].filter((m) => /-free$/.test(m) && m !== def).slice(0, 4);
    checks.push({
      level: "warn",
      message: `no fallback workers: if the model is rate-limited or removed, runs fail.${free.length ? ` Free OpenCode models you have: ${free.join(", ")}` : ""}`
    });
  }
  checks.push({ level: "ok", message: `permission profiles ${AGENT.read}/${AGENT.write} injected per run (verify: pitroom doctor --probe)` });
  return checks;
}
var opencode = {
  id: "opencode",
  name: "OpenCode",
  capabilities: { readOnly: "permission-rules", resume: "by-id", reportsCost: true, attachFiles: true },
  binary: binary4,
  invocation: invocation4,
  parse: parseEvents4,
  failure: failure4,
  defaultModel: defaultModel3,
  resolveModel: resolveModel2,
  listModels,
  catalog: catalog4,
  doctor: doctor4
};

// src/backends/index.ts
var REGISTRY = new Map([opencode, codex, claude, gemini].map((b) => [b.id, b]));
var DEFAULT_BACKEND = opencode.id;
var PLANNED = [];
var backendIds = () => [...REGISTRY.keys()];
var allBackends = () => [...REGISTRY.values()];
var isBackendId = (id) => REGISTRY.has(id) || PLANNED.includes(id);
function getBackend(id) {
  const backend = REGISTRY.get(id);
  if (backend) return backend;
  const available = backendIds().join(", ");
  throw new UserError(
    PLANNED.includes(id) ? `the "${id}" worker is not supported yet (available: ${available})` : `unknown worker "${id}" (available: ${available})`,
    3
  );
}

// src/cli/args.ts
import fs9 from "node:fs";

// src/core/config.ts
import fs8 from "node:fs";
import os7 from "node:os";
import path7 from "node:path";
var SCHEMA = {
  worker: "string",
  fallback: "string[]",
  timeout: "string",
  primary: "string",
  price: "string",
  link: "string[]",
  web: "boolean",
  maxParallel: "number",
  models: "record",
  tiers: "record",
  costs: "numbers",
  audit: "number",
  readIn: "string",
  cacheDays: "number",
  countRateLimits: "boolean",
  mcpDash: "boolean",
  notify: "boolean",
  notifyCommand: "string",
  notifyAfter: "number",
  workerPrices: "record",
  priceFeed: "boolean",
  priceFeedUrl: "string",
  priceFeedHours: "number"
};
function configPath() {
  if (process.env.PITROOM_CONFIG) return path7.resolve(process.env.PITROOM_CONFIG);
  const base2 = process.platform === "win32" ? process.env.APPDATA ?? path7.join(os7.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path7.join(os7.homedir(), ".config");
  return path7.join(base2, "pitroom", "config.json");
}
var cached;
function loadConfig() {
  if (cached) return cached;
  const file2 = configPath();
  const config = {};
  const warnings = [];
  if (fs8.existsSync(file2)) {
    let raw;
    try {
      raw = JSON.parse(fs8.readFileSync(file2, "utf8"));
    } catch (e) {
      warnings.push(`${file2}: invalid JSON (${e.message}); ignored`);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const type = SCHEMA[key];
        if (!type) {
          warnings.push(`${file2}: unknown key "${key}" ignored`);
        } else if (matches(value, type)) {
          config[key] = value;
        } else {
          warnings.push(`${file2}: "${key}" must be ${type}; ignored`);
        }
      }
    }
  }
  cached = { config, warnings };
  return cached;
}
function matches(v, type) {
  if (type === "string[]") return Array.isArray(v) && v.every((s) => typeof s === "string");
  if (type === "record") {
    return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");
  }
  if (type === "numbers") {
    return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  }
  if (type === "number") return typeof v === "number" && Number.isFinite(v) && v >= 0;
  return typeof v === type;
}
var DEFAULT_PARALLEL = 20;
var MAX_PARALLEL_LIMIT = 30;
var clampParallel = (s) => ({ ...s, value: Math.min(s.value, MAX_PARALLEL_LIMIT) });
var positiveInt = (v) => {
  const n = Number(v);
  return v !== void 0 && v !== "" && Number.isInteger(n) && n > 0 ? n : void 0;
};
var rate = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(n, 1) : void 0;
};
var days = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : void 0;
};
var flag01 = (v) => {
  const t = v?.trim().toLowerCase();
  return t === void 0 || t === "" ? void 0 : ["1", "true", "on", "yes"].includes(t) ? true : ["0", "false", "off", "no"].includes(t) ? false : void 0;
};
var readIn = (v) => v === "auto" || v === "snapshot" || v === "project" ? v : void 0;
var list = (s) => s?.split(",").map((x) => x.trim()).filter(Boolean);
function setting(flag2, env, conf, fallback) {
  if (flag2 !== void 0) return { value: flag2, source: "flag" };
  if (env !== void 0) return { value: env, source: "env" };
  if (conf !== void 0) return { value: conf, source: "config" };
  return { value: fallback, source: "default" };
}
function effective(flags = {}) {
  const c = loadConfig().config;
  const e = process.env;
  return {
    worker: setting(flags.worker, e.PITROOM_WORKER, c.worker, DEFAULT_BACKEND),
    /** Overrides the model of the preferred worker only. */
    model: setting(flags.model, e.PITROOM_MODEL, void 0, void 0),
    fallback: setting(void 0, list(e.PITROOM_FALLBACK), c.fallback, []),
    timeout: setting(flags.timeout, e.PITROOM_TIMEOUT, c.timeout, "30m"),
    primary: setting(void 0, e.PITROOM_PRIMARY, c.primary, "sonnet"),
    price: setting(void 0, e.PITROOM_PRICE, c.price, void 0),
    link: setting(void 0, void 0, c.link, []),
    web: setting(void 0, void 0, c.web, false),
    maxParallel: clampParallel(setting(void 0, positiveInt(e.PITROOM_MAX_PARALLEL), positiveInt(c.maxParallel), DEFAULT_PARALLEL)),
    models: setting(void 0, void 0, c.models, {}),
    tiers: setting(void 0, void 0, c.tiers, {}),
    costs: setting(void 0, void 0, c.costs, {}),
    audit: setting(void 0, rate(e.PITROOM_AUDIT), rate(c.audit), 0),
    readIn: setting(void 0, readIn(e.PITROOM_READ_IN), readIn(c.readIn), "auto"),
    cacheDays: setting(void 0, days(e.PITROOM_CACHE_DAYS), days(c.cacheDays), 7),
    countRateLimits: setting(void 0, void 0, c.countRateLimits, false),
    mcpDash: setting(void 0, flag01(e.PITROOM_MCP_DASH), c.mcpDash, true),
    notify: setting(void 0, flag01(e.PITROOM_NOTIFY), c.notify, false),
    notifyCommand: setting(void 0, e.PITROOM_NOTIFY_COMMAND?.trim() || void 0, c.notifyCommand?.trim() || void 0, void 0),
    notifyAfter: setting(void 0, days(e.PITROOM_NOTIFY_AFTER), days(c.notifyAfter), 15),
    workerPrices: setting(void 0, void 0, c.workerPrices, {}),
    priceFeed: setting(void 0, flag01(e.PITROOM_PRICE_FEED), c.priceFeed, false),
    priceFeedUrl: setting(void 0, e.PITROOM_PRICE_FEED_URL?.trim() || void 0, c.priceFeedUrl?.trim() || void 0, "https://models.dev/api.json"),
    priceFeedHours: setting(void 0, positiveInt(e.PITROOM_PRICE_FEED_HOURS), positiveInt(c.priceFeedHours), 24)
  };
}

// src/cli/args.ts
var VALUE_FLAGS = {
  "-d": "dir",
  "--dir": "dir",
  "-f": "file",
  "--file": "file",
  "-m": "model",
  "--model": "model",
  "-W": "worker",
  "--worker": "worker",
  "--tier": "tier",
  "--effort": "effort",
  "-g": "group",
  "--group": "group",
  "-t": "timeout",
  "--timeout": "timeout",
  "--verify": "verify",
  "--link": "link",
  "-c": "continue",
  "--continue": "continue",
  "--task-file": "task-file",
  "--since": "since",
  "--card": "card",
  "--days": "days",
  "--interval": "interval",
  "--range": "range",
  "--then": "then",
  "--port": "port",
  "--idle": "idle",
  "--state": "state",
  "--limit": "limit",
  "--plan": "plan",
  "--step": "step",
  "--fallback": "fallback",
  "--client": "client"
};
var BOOL_FLAGS = {
  "-r": "read",
  "--read": "read",
  "-w": "write",
  "--write": "write",
  "-i": "isolate",
  "--isolate": "isolate",
  "--bg": "bg",
  "--mcp": "mcp",
  "--no-skills": "no-skills",
  "--dry-run": "dry-run",
  "--in-place": "in-place",
  "--audit": "audit",
  "--no-audit": "no-audit",
  "--web": "web",
  "--no-fallback": "no-fallback",
  "--json": "json",
  "--allow-non-git": "allow-non-git",
  "--patch": "patch",
  "--events": "events",
  "--full": "full",
  "--badge": "badge",
  "--probe": "probe",
  "--clear": "clear",
  "--refresh": "refresh",
  "--quiet": "quiet",
  "--copy": "copy",
  "--all": "all",
  "--models": "models",
  "--force": "force",
  "--allow-delete": "allow-delete",
  "--yes": "yes",
  "--any": "any",
  "--brief": "brief",
  "--running": "running",
  "--detach": "detach",
  "--stop": "stop",
  "--open": "open",
  "--serve": "serve",
  "--fresh": "fresh",
  "--http": "http",
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version"
};
function parse(argv) {
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  const set = (k, v) => flags.set(k, [...flags.get(k) ?? [], v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const [name, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, void 0];
    if (VALUE_FLAGS[name]) {
      const v = inline ?? argv[++i];
      if (v === void 0) throw new UserError(`${name} needs a value`);
      set(VALUE_FLAGS[name], v);
    } else if (BOOL_FLAGS[name]) {
      set(BOOL_FLAGS[name], "true");
    } else if (a.startsWith("-") && a !== "-") {
      throw new UserError(`unknown option ${a} (see pitroom --help)`);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
var flag = (p, k) => p.flags.get(k)?.at(-1);
var has = (p, k) => p.flags.has(k);
function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(s.trim());
  if (!m) throw new UserError(`bad duration "${s}" (use e.g. 900, 20m, 1h)`);
  return Math.round(Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[(m[2] ?? "s").toLowerCase()] ?? 1));
}
function exitCodeFor(meta) {
  switch (meta.state) {
    case "queued":
    case "running":
      return 75;
    case "timeout":
      return 4;
    case "failed":
    case "stopped":
      return 1;
    default:
      if (meta.warnings.some((w) => w.startsWith("READ-ONLY VIOLATION"))) return 5;
      if (meta.verifyResult && !meta.verifyResult.ok) return 6;
      return 0;
  }
}
function readTask(p) {
  const file2 = flag(p, "task-file");
  if (file2) return fs9.readFileSync(file2, "utf8");
  const words = p.positional;
  if (words.length === 1 && words[0] === "-") return fs9.readFileSync(0, "utf8");
  return words.join(" ");
}
function runOptions(p, task) {
  const modes = ["read", "write", "isolate"].filter((m) => has(p, m));
  if (modes.length > 1) throw new UserError("choose one of --read, --write, --isolate");
  const cont = flag(p, "continue");
  if (has(p, "audit") && has(p, "no-audit")) throw new UserError("choose one of --audit, --no-audit");
  if (has(p, "audit") && (has(p, "write") || has(p, "isolate"))) throw new UserError("audits re-check the answer of a read run: drop -w/-i");
  return {
    mode: modes[0] ?? "read",
    auditRate: has(p, "no-audit") ? 0 : has(p, "audit") ? 1 : void 0,
    inPlace: has(p, "in-place"),
    task,
    dir: flag(p, "dir") ?? process.cwd(),
    files: p.flags.get("file") ?? [],
    link: p.flags.has("link") ? (p.flags.get("link") ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean) : effective().link.value,
    worker: flag(p, "worker"),
    model: flag(p, "model"),
    tier: flag(p, "tier"),
    effort: effortFlag(p),
    timeoutSec: parseDuration(effective({ timeout: flag(p, "timeout") }).timeout.value),
    verify: flag(p, "verify"),
    continueFrom: cont ? resolveRun(cont) : void 0,
    allowNonGit: has(p, "allow-non-git"),
    web: has(p, "web") || effective().web.value,
    noFallback: has(p, "no-fallback"),
    group: flag(p, "group")
  };
}
function planStep(p) {
  const file2 = flag(p, "plan");
  const step = flag(p, "step");
  if (!file2 && !step) return void 0;
  if (!file2 || !step) throw new UserError("--plan and --step go together: pitroom run -i --plan PLAN.md --step N");
  if (!/^\d+$/.test(step)) throw new UserError(`--step takes a task number, not "${step}"`);
  return { file: file2, step: Number(step) };
}
function effortFlag(p) {
  const v = flag(p, "effort");
  if (v !== void 0 && !/^[a-z][a-z0-9-]*$/i.test(v)) throw new UserError(`--effort takes a level such as low, medium, high or xhigh, not "${v}"`);
  return v?.toLowerCase();
}

// src/cli/mcp.ts
import readline from "node:readline";

// src/core/run.ts
import { spawn as spawn4, spawnSync as spawnSync6 } from "node:child_process";
import fs27 from "node:fs";
import path23 from "node:path";

// src/vcs/git.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import crypto2 from "node:crypto";
import fs10 from "node:fs";
import os8 from "node:os";
import path8 from "node:path";
var SAFE = [
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false"
];
function git(cwd, args, env) {
  const r = spawnSync5("git", [...SAFE, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function must(cwd, args, env) {
  const r = git(cwd, args, env);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.code}`);
  return r.stdout;
}
function gitAvailable() {
  return git(process.cwd(), ["--version"]).code === 0;
}
function canonical(dir) {
  try {
    return fs10.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
function repoRoot(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? canonical(path8.resolve(r.stdout.trim())) : void 0;
}
function snapshotTree(root, exclude = [], drop2 = []) {
  const tmp = path8.join(os8.tmpdir(), `pitroom-index-${process.pid}-${crypto2.randomBytes(4).toString("hex")}`);
  const real = path8.resolve(root, must(root, ["rev-parse", "--git-path", "index"]).trim());
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    if (fs10.existsSync(real)) fs10.copyFileSync(real, tmp);
    else must(root, ["read-tree", "--empty"], env);
    must(root, ["add", "-A", "--", ":/", ...exclude.map((p) => `:(top,exclude)${p}`), ...drop2.map((p) => `:(top,literal,exclude)${p}`)], env);
    if (drop2.length) {
      const r = spawnSync5("git", ["update-index", "--force-remove", "-z", "--stdin"], { cwd: root, env, input: `${drop2.join("\0")}\0`, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git update-index failed: ${r.stderr.trim()}`);
    }
    return must(root, ["write-tree"], env).trim();
  } finally {
    fs10.rmSync(tmp, { force: true });
    fs10.rmSync(`${tmp}.lock`, { force: true });
  }
}
var DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
function diffTrees(root, a, b) {
  const changes = [];
  if (a === b) return { changes, stats: { files: 0, insertions: 0, deletions: 0 }, patch: "" };
  const parts = must(root, [...DIFF, "--name-status", "-z", a, b]).split("\0").filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] });
  let insertions = 0;
  let deletions = 0;
  for (const line of must(root, [...DIFF, "--numstat", a, b]).split("\n")) {
    const [ins, del] = line.split("	");
    if (ins && ins !== "-") insertions += Number(ins);
    if (del && del !== "-") deletions += Number(del);
  }
  const patch = must(root, [...DIFF, "--binary", "--full-index", a, b]);
  return { changes, stats: { files: changes.length, insertions, deletions }, patch };
}
function createIsolatedCopy(root, tree, dest) {
  const objects = path8.join(path8.resolve(root, must(root, ["rev-parse", "--git-common-dir"]).trim()), "objects");
  fs10.mkdirSync(path8.dirname(dest), { recursive: true });
  must(path8.dirname(dest), ["init", "--quiet", dest]);
  fs10.writeFileSync(path8.join(dest, ".git", "objects", "info", "alternates"), `${objects}
`);
  must(dest, ["read-tree", tree]);
  must(dest, ["checkout-index", "--all", "--force"]);
}
function removeIsolatedCopy(dest, ownedBy) {
  const rel = path8.relative(ownedBy, dest);
  if (!rel || rel.startsWith("..") || path8.isAbsolute(rel)) throw new Error(`refusing to remove ${dest}`);
  fs10.rmSync(dest, { recursive: true, force: true });
}
function linkIntoWorktree(root, worktree, rels) {
  const linked = [];
  for (const rel of rels) {
    const src = path8.join(root, rel);
    const dst = path8.join(worktree, rel);
    if (!fs10.existsSync(src) || fs10.existsSync(dst)) continue;
    fs10.mkdirSync(path8.dirname(dst), { recursive: true });
    fs10.symlinkSync(src, dst, process.platform === "win32" ? "junction" : void 0);
    linked.push(rel);
  }
  return linked;
}
function applyPatch(root, patchFile, reverse) {
  const flags = reverse ? ["-R"] : [];
  const check = git(root, ["apply", "--check", "--whitespace=nowarn", ...flags, patchFile]);
  if (check.code !== 0) return { ok: false, message: check.stderr.trim() };
  const r = git(root, ["apply", "--whitespace=nowarn", ...flags, patchFile]);
  return { ok: r.code === 0, message: r.stderr.trim() };
}
function reviewDiff(root, a, b) {
  return `${must(root, [...DIFF, "--stat", a, b]).trim()}

${must(root, [...DIFF, "-U10", a, b])}`;
}
function rangeDiff(root, a, b) {
  const range = `${a}..${b}`;
  const since2 = git(root, ["merge-base", a, b]).code === 0 ? `${a}...${b}` : range;
  const log2 = must(root, ["log", "--oneline", "--no-decorate", range]).trim();
  return [
    `## COMMITS

${log2 || "(none)"}`,
    `## FILES CHANGED

${must(root, [...DIFF, "--stat", since2]).trim() || "(none)"}`,
    `## DIFF

${must(root, [...DIFF, "-U10", since2])}`
  ].join("\n\n");
}
function commitOf(root, ref) {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : void 0;
}
function gitDir(dir) {
  const r = git(dir, ["rev-parse", "--absolute-git-dir"]);
  return r.code === 0 ? r.stdout.trim() : void 0;
}

// src/core/target.ts
function parseTarget(spec, defaultBackend) {
  const s = spec.trim();
  if (!s) throw new UserError("empty worker target");
  const i = s.indexOf(":");
  if (i > 0 && isBackendId(s.slice(0, i))) {
    const model = s.slice(i + 1).trim();
    return model ? { backend: s.slice(0, i), model } : { backend: s.slice(0, i) };
  }
  if (isBackendId(s)) return { backend: s };
  return { backend: defaultBackend, model: s };
}
var formatTarget = (t) => t.model ? `${t.backend}:${t.model}` : t.backend;
var describeTarget = (t) => t.model ? formatTarget(t) : `${t.backend} (default model)`;
var sameTarget = (a, b) => a.backend === b.backend && a.model === b.model;

// src/core/chain.ts
function resolveChain(flags = {}) {
  const warnings = [];
  let spec = flags.worker;
  if (!spec && flags.tier) {
    const tiers = effective().tiers.value;
    spec = Object.hasOwn(tiers, flags.tier) ? tiers[flags.tier] : void 0;
    if (!spec) warnings.push(`tier "${flags.tier}" is not configured (config "tiers"); using the default worker`);
  }
  const eff = effective({ worker: spec, model: flags.model });
  const models = eff.models.value;
  const withDefault = (t) => {
    const pinned = models[t.backend];
    if (!pinned) return t;
    if (!t.model) return { ...t, model: pinned };
    return t.model.startsWith("#") ? { ...t, model: `${pinned}${t.model}` } : t;
  };
  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);
  if (flags.effort) {
    const base2 = (worker.model ?? "").split("#")[0];
    if (!(worker.backend === "opencode" && !base2)) {
      worker = { ...worker, model: `${base2}#${flags.effort}` };
    }
  }
  if ((worker.backend === "codex" || worker.backend === "claude" || worker.backend === "gemini") && !(worker.model ?? "").replace(/#.*$/, "")) {
    warnings.push(
      `${worker.backend} has no pinned model, so it runs its own default (which can change and cost more): set "models": {"${worker.backend}": "<model>"} in the pitroom config, or pass -W ${worker.backend}:<model>`
    );
  }
  const fallback = [];
  if (!flags.noFallback) {
    for (const s of eff.fallback.value) {
      const t = withDefault(parseTarget(s, worker.backend));
      try {
        getBackend(t.backend);
        fallback.push(t);
      } catch (e) {
        warnings.push(`fallback ${s} skipped: ${e.message}`);
      }
    }
  }
  return { worker, fallback, warnings };
}

// src/core/process.ts
import { spawn } from "node:child_process";
import fs12 from "node:fs";

// src/vcs/guard.ts
import fs11 from "node:fs";
import path9 from "node:path";
var VERSION = 2;
var WINDOWS = process.platform === "win32";
var fwd = (p) => WINDOWS ? p.replace(/\\/g, "/") : p;
var SHIM = `#!/bin/sh
# pitroom git guard v${VERSION}. Blocks git commands that change history, refs, the
# index or discard work. The primary agent reviews and commits, not the worker.
set -f
real="\${PITROOM_REAL_GIT:-}"
if [ -z "$real" ] || [ ! -x "$real" ]; then
  echo "pitroom: git guard cannot find the real git" >&2
  exit 127
fi
block() {
  echo "pitroom: 'git $1' is blocked for workers (the primary agent reviews and commits)" >&2
  exit 1
}
sub=""; skip=""; after=""
for a do
  if [ -n "$sub" ]; then after="$after $a"; continue; fi
  case "$skip" in
    c) skip=""; case "$a" in [Aa][Ll][Ii][Aa][Ss].*) block "-c $a" ;; esac; continue ;;
    v) skip=""; continue ;;
  esac
  case "$a" in
    -c|--config-env) skip=c ;;
    -C|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path) skip=v ;;
    -*) ;;
    *) sub="$a" ;;
  esac
done
[ -z "$sub" ] && exec "$real" "$@"

# Resolve aliases (also those injected via GIT_CONFIG_* env); shell aliases are refused.
depth=0
while def=$("$real" config --get "alias.$sub" 2>/dev/null) && [ -n "$def" ]; do
  depth=$((depth+1)); [ "$depth" -gt 5 ] && block "$sub (alias loop)"
  case "$def" in '!'*) block "$sub (shell alias)" ;; -*) block "$sub (alias with options)" ;; esac
  next=\${def%% *}
  [ "$next" != "$def" ] && after=" \${def#* }$after"
  sub="$next"
done

has() { for f in "$@"; do case " $after " in *" $f "*|*" $f="*) return 0 ;; esac; done; return 1; }
count() { n=0; for w in $after; do case "$w" in -*) ;; *) n=$((n+1)) ;; esac; done; echo "$n"; }

case "$sub" in
  commit|push|pull|reset|checkout|restore|clean|stash|rebase|merge|switch|cherry-pick|revert|am|\\
  worktree|update-ref|update-index|filter-branch|filter-repo|gc|prune|replace|notes|add|rm|mv|\\
  sparse-checkout|read-tree|commit-tree|write-tree|fast-import|bisect)
    block "$sub" ;;
  branch)
    has -d -D --delete -m -M --move -c -C --copy -f --force -u --set-upstream-to --unset-upstream --edit-description && block "branch$after"
    [ "$(count)" -gt 0 ] && ! has -l --list --contains --no-contains --merged --no-merged --points-at && block "branch$after" ;;
  tag)
    has -d --delete -a --annotate -s --sign -u --local-user -f --force -m --message -F --file && block "tag$after"
    [ "$(count)" -gt 0 ] && ! has -l --list --contains --no-contains --merged --no-merged --points-at && block "tag$after" ;;
  config)
    has --unset --unset-all --add --replace-all --rename-section --remove-section -e --edit set unset rename-section remove-section edit && block "config$after"
    [ "$(count)" -ge 2 ] && ! has get --get --get-all --get-regexp --get-urlmatch && block "config$after" ;;
  remote)
    for w in $after; do case "$w" in add|remove|rm|rename|set-url|set-head|set-branches|prune|update) block "remote $w" ;; esac; done ;;
  fetch)
    for w in $after; do case "$w" in -*) ;; *:*) block "fetch $w (writes a local ref)" ;; esac; done ;;
  apply)
    has --index --cached -3 --3way && block "apply$after" ;;
  reflog)
    has expire delete && block "reflog$after" ;;
  symbolic-ref)
    has -d --delete && block "symbolic-ref$after"
    [ "$(count)" -ge 2 ] && block "symbolic-ref$after" ;;
  submodule)
    for w in $after; do case "$w" in -*) ;; status|summary) break ;; *) block "submodule $w" ;; esac; done ;;
esac
exec "$real" "$@"
`;
function shimDir() {
  return path9.join(home(), "shim", `v${VERSION}`);
}
function findRealGit(skip) {
  const same2 = (a, b) => WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const dir of (process.env.PATH ?? "").split(path9.delimiter).filter(Boolean)) {
    if (same2(path9.resolve(dir), skip)) continue;
    const p = path9.join(dir, WINDOWS ? "git.exe" : "git");
    try {
      fs11.accessSync(p, fs11.constants.X_OK);
      if (fs11.statSync(p).isFile()) return p;
    } catch {
    }
  }
  return void 0;
}
function findGitSh(realGit) {
  let dir = path9.dirname(realGit);
  for (let i = 0; i < 4; i++) {
    for (const rel of ["bin/sh.exe", "usr/bin/sh.exe"]) {
      const p = path9.join(dir, rel);
      if (fs11.existsSync(p)) return p;
    }
    const up = path9.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return void 0;
}
var cmdShim = (sh) => `@echo off\r
set "MSYS2_ARG_CONV_EXCL=*"\r
"${sh}" "%~dp0git" %*\r
exit /b %errorlevel%\r
`;
var HOOK_VERSION = 1;
var REF_HOOK = `#!/bin/sh
# pitroom git guard (layer 2, v${HOOK_VERSION}): refuse ref updates made by workers.
[ "$1" = prepared ] || exit 0
echo "pitroom: git ref updates (commit, reset, branch, tag, stash, rebase, merge) are blocked for workers" >&2
exit 1
`;
var hooksDir = () => path9.join(home(), "git-hooks", `v${HOOK_VERSION}`);
function writeIfChanged(file2, content) {
  if (fs11.existsSync(file2) && fs11.readFileSync(file2, "utf8") === content) return;
  fs11.mkdirSync(path9.dirname(file2), { recursive: true });
  const tmp = `${file2}.${process.pid}.tmp`;
  fs11.writeFileSync(tmp, content, { mode: 493 });
  renameOver(tmp, file2);
}
function pathKey(env) {
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  return keys.includes("PATH") ? "PATH" : keys[0] ?? "PATH";
}
function onePath(env) {
  const key = pathKey(env);
  const out = { ...env };
  for (const k of Object.keys(out)) if (k !== key && k.toLowerCase() === "path") delete out[k];
  return out;
}
function withGitConfig(env, entries) {
  const out = { ...env };
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}
function guardEnv(env) {
  const quiet = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    PAGER: "cat"
  };
  writeIfChanged(path9.join(hooksDir(), "reference-transaction"), REF_HOOK);
  env = withGitConfig(onePath(env), [
    ["core.hooksPath", fwd(hooksDir())],
    ["url.pitroom-push-blocked://.pushInsteadOf", ""]
  ]);
  const dir = shimDir();
  const real = findRealGit(dir);
  if (!real) return { ...env, ...quiet };
  let sh;
  if (WINDOWS) {
    sh = findGitSh(real);
    if (!sh) return { ...env, ...quiet };
    writeIfChanged(path9.join(dir, "git.cmd"), cmdShim(sh));
  }
  writeIfChanged(path9.join(dir, "git"), SHIM);
  const key = pathKey(env);
  return { ...env, ...quiet, PITROOM_REAL_GIT: fwd(real), [key]: `${dir}${path9.delimiter}${env[key] ?? ""}` };
}
function shimReady() {
  const env = guardEnv({ ...process.env });
  return Boolean(env[pathKey(env)]?.startsWith(shimDir()));
}

// src/core/process.ts
async function spawnWorker(inv, opts) {
  const out = fs12.openSync(opts.stdoutFile, "w");
  const err = fs12.openSync(opts.stderrFile, "w");
  const res = { code: null, timedOut: false, stopped: false };
  const child = spawn(inv.command, inv.args, {
    cwd: opts.cwd,
    stdio: ["ignore", out, err],
    // OpenCode v2 takes its workspace from $PWD, not the process cwd: without this a worker
    // started in an isolated copy would read and edit the directory pitroom was launched from.
    env: guardEnv({ ...process.env, ...inv.env, PWD: opts.cwd, PITROOM_ACTIVE: "1" })
  });
  const stop = () => {
    res.stopped = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let killer;
  const timer2 = setTimeout(() => {
    res.timedOut = true;
    child.kill("SIGTERM");
    killer = setTimeout(() => child.kill("SIGKILL"), 1e4);
  }, opts.timeoutSec * 1e3);
  res.code = await new Promise((resolve2) => {
    child.on("error", (e) => {
      res.spawnError = e.code === "ENOENT" ? fs12.existsSync(opts.cwd) ? `${inv.command} not found` : `the working directory ${opts.cwd} does not exist` : e.message;
      resolve2(127);
    });
    child.on("close", (c) => resolve2(c));
  });
  clearTimeout(timer2);
  if (killer) clearTimeout(killer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  fs12.closeSync(out);
  fs12.closeSync(err);
  return res;
}

// src/core/answers.ts
var TASK_STATUSES = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];
function parseStatus(text) {
  const value = /^\s*STATUS:\s*([A-Za-z_]+)/im.exec(text)?.[1]?.toUpperCase() ?? "";
  return TASK_STATUSES.includes(value) ? value : "unknown";
}
function parseVerdict(text) {
  const line = /^\s*SUMMARY:.*\bSPEC:.*$/im.exec(text)?.[0] ?? /^.*\bSPEC:.*$/im.exec(text)?.[0] ?? "";
  const spec = /\bSPEC:\s*(PASS|FAIL)\b/i.exec(line)?.[1]?.toLowerCase();
  const quality = /\bQUALITY:\s*(APPROVED|NEEDS[_ -]?FIXES)\b/i.exec(line)?.[1]?.toUpperCase();
  const count = (k) => Number(new RegExp(`\\b${k}=(\\d+)`, "i").exec(line)?.[1] ?? 0);
  return {
    spec: spec === "pass" || spec === "fail" ? spec : "unknown",
    quality: quality === "APPROVED" ? "approved" : quality ? "needs-fixes" : "unknown",
    critical: count("critical"),
    important: count("important"),
    minor: count("minor")
  };
}
function parseAudit(text) {
  const word = /^\s*AUDIT:\s*(AGREE|PARTIAL|DISAGREE)\b/im.exec(text)?.[1]?.toLowerCase();
  const verdict = word === "agree" || word === "partial" || word === "disagree" ? word : "unclear";
  const after = /^\s*DISPUTED:\s*$/im.exec(text);
  const disputed = after ? text.slice(after.index + after[0].length).split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s+\S/.test(l)).map((l) => l.replace(/^[-*•]\s+/, "")).filter((l) => !/^\(?none\)?\.?$/i.test(l)).slice(0, 8) : [];
  return { verdict, disputed };
}

// src/core/cooldown.ts
import fs13 from "node:fs";
import path10 from "node:path";
var MAX_MS = 24 * 36e5;
var OVERLOAD_MS = 20 * 6e4;
var DAILY_MS = 4 * 36e5;
var file = () => path10.join(home(), "cooldowns.json");
function cooldownKey(target, backend) {
  const model = (target.model ?? backend.defaultModel?.() ?? "").split("#")[0];
  return `${target.backend}:${model}`;
}
function retryAfterMs(message) {
  const compact3 = /(?:retry|try again|resets?|available again)[^0-9]{0,24}((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i.exec(message)?.[1];
  const words = /(?:retry|try again|resets?)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i.exec(message);
  let ms = 0;
  if (compact3) {
    for (const [, n, unit] of compact3.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(n) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[unit.toLowerCase()];
  } else if (words) {
    ms = Number(words[1]) * { second: 1e3, minute: 6e4, hour: 36e5 }[words[2].toLowerCase()];
  }
  return ms > 0 ? ms : void 0;
}
function cooldownMs(message) {
  const told = retryAfterMs(message);
  if (told !== void 0) return Math.min(Math.max(told, 6e4), MAX_MS);
  return /daily|per.?day|per day|exhausted your/i.test(message) ? DAILY_MS : OVERLOAD_MS;
}
function read() {
  try {
    const raw = JSON.parse(fs13.readFileSync(file(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function write(all) {
  fs13.mkdirSync(path10.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs13.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}
`);
  renameOver(tmp, file());
}
function activeCooldowns(now = Date.now()) {
  return Object.fromEntries(Object.entries(read()).filter(([, c]) => Date.parse(c.until) > now));
}
var activeCooldown = (key, now = Date.now()) => activeCooldowns(now)[key];
function recordCooldown(key, targetName, message, now = Date.now()) {
  try {
    const all = activeCooldowns(now);
    all[key] = { until: new Date(now + cooldownMs(message)).toISOString(), reason: message.replace(/\s+/g, " ").trim().slice(0, 160), target: targetName };
    write(all);
  } catch {
  }
}
function clearCooldowns(key) {
  const all = read();
  const keys = key ? Object.keys(all).filter((k) => k === key) : Object.keys(all);
  for (const k of keys) delete all[k];
  if (keys.length) write(all);
  return keys.length;
}
function untilText(c, now = Date.now()) {
  const d = new Date(c.until);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(now).toDateString() ? `until ${time}` : `until ${d.toLocaleDateString()} ${time}`;
}

// src/core/snapshot.ts
import fs15 from "node:fs";
import path12 from "node:path";
import crypto3 from "node:crypto";

// src/core/secrets.ts
import { execFileSync } from "node:child_process";
import fs14 from "node:fs";
import path11 from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache"]);
var MAX_VISITED = 2e4;
var MAX_DEPTH = 4;
var TEMPLATE = /\.(example|sample|template|dist|defaults?|tpl)$/i;
function looksSecret(file2) {
  const name = file2.toLowerCase();
  if (TEMPLATE.test(name)) return false;
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return true;
  return /\.(pem|p12|pfx|key|jks|keystore)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || name === ".netrc" || name === "credentials.json" || /^secrets?\.(json|ya?ml|toml)$/.test(name);
}
function findSecretFiles(dir) {
  const found = [];
  let visited = 0;
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries;
    try {
      entries = fs14.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path11.join(d, e.name), depth + 1);
      } else if (e.isFile() && looksSecret(e.name)) {
        found.push(slash(path11.relative(dir, path11.join(d, e.name))));
      }
    }
  };
  walk(dir, 0);
  return found.sort();
}
function findSecretFilesInTree(root, dir) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return out.split("\0").filter((f) => f && looksSecret(path11.basename(f)) && !path11.relative(dir, path11.join(root, f)).startsWith("..")).map((f) => slash(path11.relative(dir, path11.join(root, f)))).sort();
  } catch {
    return [];
  }
}
function secretWarning(files, mode) {
  if (!files.length) return void 0;
  const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? `, +${files.length - 3} more` : "");
  const where = mode === "isolate" ? "would be copied into the isolated copy" : "sit in the directory the worker runs in";
  const fix = mode === "isolate" ? "add them to .gitignore, or" : "use an isolated copy (-i, git-ignored files are left out) or a clean checkout, or";
  return `secret-looking files ${where} (${shown}): the worker is told not to read them, but nothing stops it, and its model may be hosted by a third party; ${fix} set PITROOM_NO_SECRET_WARNING=1 to silence this`;
}
var slash = (p) => p.split(path11.sep).join("/");

// src/core/snapshot.ts
var READ_IN = ["auto", "snapshot", "project"];
var KEEP_MS = 24 * 36e5;
var PRUNE_AGE_MS = 3 * 24 * 36e5;
var KEEP_NEWEST = 6;
var JUST_USED_MS = 10 * 6e4;
var snapshotsDir = () => path12.join(home(), "snapshots");
function wantSnapshot(readIn2, root, dir) {
  if (!root || readIn2 === "project") return void 0;
  const secrets = findSecretFiles(dir);
  return readIn2 === "snapshot" || secrets.length ? { secrets } : void 0;
}
function readSnapshot(root) {
  const drop2 = findSecretFilesInTree(root, root);
  const tree = snapshotTree(root, [], drop2);
  const dest = path12.join(snapshotsDir(), tree);
  if (fs15.existsSync(path12.join(dest, ".git"))) {
    touch(dest);
    return { dir: dest, tree, created: false };
  }
  const tmp = path12.join(snapshotsDir(), `.tmp-${process.pid}-${crypto3.randomBytes(3).toString("hex")}`);
  try {
    createIsolatedCopy(root, tree, tmp);
    readOnly(tmp);
    try {
      fs15.renameSync(tmp, dest);
    } catch (e) {
      if (!fs15.existsSync(path12.join(dest, ".git"))) throw e;
      removeIsolatedCopy(tmp, snapshotsDir());
    }
  } catch (e) {
    try {
      removeIsolatedCopy(tmp, snapshotsDir());
    } catch {
    }
    throw e;
  }
  prune();
  return { dir: dest, tree, created: true };
}
function touch(dir) {
  try {
    const now = /* @__PURE__ */ new Date();
    fs15.utimesSync(dir, now, now);
  } catch {
  }
}
function readOnly(dir) {
  const walk = (d) => {
    for (const e of fs15.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path12.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) fs15.chmodSync(p, fs15.statSync(p).mode & ~146);
    }
  };
  try {
    walk(dir);
  } catch {
  }
}
function prune(now = Date.now(), maxAgeMs = PRUNE_AGE_MS, keepNewest = KEEP_NEWEST) {
  let names;
  try {
    names = fs15.readdirSync(snapshotsDir());
  } catch {
    return 0;
  }
  const inUse = /* @__PURE__ */ new Set();
  for (const id of listRunIds()) {
    try {
      const m = readMeta(id);
      if (m.snapshot?.dir && isActive(m.state)) inUse.add(path12.resolve(m.snapshot.dir));
    } catch {
    }
  }
  const entries = names.map((n) => {
    const dir = path12.join(snapshotsDir(), n);
    try {
      return { n, dir, age: now - fs15.statSync(dir).mtimeMs };
    } catch {
      return void 0;
    }
  }).filter((e) => !!e).sort((x, y) => x.age - y.age);
  let removed = 0;
  let rank = 0;
  for (const e of entries) {
    if (inUse.has(path12.resolve(e.dir))) continue;
    const half = e.n.startsWith(".tmp-");
    const old = e.age >= (half ? KEEP_MS : maxAgeMs);
    const surplus = !half && ++rank > keepNewest && e.age >= JUST_USED_MS;
    if (!old && !surplus) continue;
    try {
      makeWritable(e.dir);
      removeIsolatedCopy(e.dir, snapshotsDir());
      removed++;
    } catch {
    }
  }
  return removed;
}
function makeWritable(dir) {
  const walk = (d) => {
    for (const e of fs15.readdirSync(d, { withFileTypes: true })) {
      const p = path12.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) fs15.chmodSync(p, fs15.statSync(p).mode | 128);
    }
  };
  try {
    walk(dir);
  } catch {
  }
}
function backToProject(text, snapshotDir, root) {
  let real = snapshotDir;
  try {
    real = fs15.realpathSync(snapshotDir);
  } catch {
  }
  let out = text;
  for (const dir of /* @__PURE__ */ new Set([real, snapshotDir])) out = out.split(`${dir}${path12.sep}`).join(`${root}${path12.sep}`).split(dir).join(root);
  return out;
}

// src/core/audit.ts
import crypto4 from "node:crypto";
import path13 from "node:path";
var ANSWER_MAX = 8e3;
function auditRate(meta) {
  return meta.auditRate ?? effective().audit.value;
}
function draw(id) {
  return crypto4.createHash("sha256").update(id).digest().readUInt32BE(0) / 4294967296;
}
function auditable(meta, answer) {
  return meta.mode === "read" && meta.state === "done" && !meta.reviewOf && !meta.auditOf && !meta.audit && !!answer.trim();
}
function sampled(meta) {
  const rate2 = auditRate(meta);
  return rate2 > 0 && (rate2 >= 1 || draw(meta.id) < rate2);
}
function pickAuditor(meta) {
  const eff = effective();
  const tiers = eff.tiers.value;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const ran = meta.ran ?? meta.worker;
  const candidates = [tiers.audit, tiers.cheap, ...eff.fallback.value, eff.worker.value].filter((s) => !!s);
  return candidates.find((c) => !sameTarget(parseTarget(c, def), ran));
}
function relativeToAuditor(answer, meta) {
  let out = answer;
  const roots = [...new Set([meta.dir, meta.repoRoot].filter((r) => !!r))].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const rel = path13.relative(meta.dir, root);
    const prefix = rel ? `${rel.split(path13.sep).join("/")}/` : "";
    out = out.split(`${root}${path13.sep}`).join(prefix).replace(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g"), rel || ".");
  }
  return out;
}
function auditTask(meta, answer) {
  const text = relativeToAuditor(answer, meta).trim();
  const shown = text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}
\u2026 (cut: ${text.length - ANSWER_MAX} more characters)` : text;
  return [
    "You are auditing another worker's answer to a read-only question about this project. Do not take the answer on trust:",
    "check its key claims yourself against the files here (open the cited files and lines, search for what it says exists or is missing).",
    "Paths in the answer are relative to your working directory.",
    "Check the answer against the QUESTION, not only its own claims: every condition the question sets (a directory or scope,",
    'what to leave out, "all", "only", "exactly", a count) must hold. Valid references do not make an answer right:',
    "for a list, look for items that are missing and items that do not belong; for a count, count again yourself.",
    "Do not edit anything and do not run anything that changes files.",
    "",
    "QUESTION:",
    meta.task.trim(),
    "",
    "ANSWER TO AUDIT:",
    shown,
    "",
    "Reply in exactly this form and nothing else:",
    "AUDIT: AGREE | PARTIAL | DISAGREE",
    "CHECKED: <how many key claims you checked>",
    "DISPUTED:",
    "- <the claim> \u2014 <what is actually true, with path:line>",
    "",
    "AGREE: every key claim you checked holds and the answer meets every condition of the question (no extra or missing items, the right count). PARTIAL: some are wrong, unverified, or the answer goes beyond or falls short of the question's scope. DISAGREE: the main conclusion is wrong.",
    'Under DISPUTED list only claims you checked and found wrong or unsupported; write "- (none)" when there are none.'
  ].join("\n");
}
function auditLines(meta) {
  if (meta.auditOf) {
    return meta.state === "done" ? [`\u2500\u2500 audit of ${meta.auditOf}: ${(meta.auditVerdict ?? "unclear").toUpperCase()}${meta.auditDisputed?.length ? ` \xB7 ${meta.auditDisputed.length} disputed` : ""}`] : [];
  }
  const a = meta.audit;
  if (!a) return [];
  if (a.state === "done") {
    const head = `\u2500\u2500 audit (run ${a.id}): ${(a.verdict ?? "unclear").toUpperCase()}${a.verdict === "agree" ? "" : a.verdict === "unclear" ? " (the auditor did not answer in the expected form)" : ""}`;
    return [head, ...(a.disputed ?? []).map((d) => `   disputed: ${d}`)];
  }
  if (a.state === "running" || a.state === "queued") return [`\u2500\u2500 audit: another worker is re-checking this answer in the background (pitroom show ${a.id})`];
  return [`\u2500\u2500 audit (run ${a.id}) ${a.state}: no verdict`];
}
function auditBadge(meta) {
  const a = meta.audit;
  if (!a) return void 0;
  if (a.state === "done") return (a.verdict ?? "unclear").toUpperCase();
  return a.state === "running" || a.state === "queued" ? "PENDING" : "FAILED";
}

// src/core/notify.ts
import { spawn as spawn3 } from "node:child_process";
import crypto5 from "node:crypto";
import fs22 from "node:fs";
import path18 from "node:path";

// src/core/history.ts
import fs19 from "node:fs";
import { createRequire } from "node:module";
import path16 from "node:path";
import zlib from "node:zlib";

// src/core/receipt.ts
import fs17 from "node:fs";
import path15 from "node:path";

// src/core/prices.ts
import { spawn as spawn2 } from "node:child_process";
import fs16 from "node:fs";
import path14 from "node:path";
var DEFAULT_URL = "https://models.dev/api.json";
var RETRY_AFTER_FAILURE_MS = 60 * 6e4;
var MIN_MODELS = 100;
function catalogLabel() {
  const url = effective().priceFeedUrl.value;
  if (url === DEFAULT_URL) return "models.dev";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
var catalogFile = () => path14.join(home(), "prices.json");
var attemptFile = () => path14.join(home(), "prices.attempt");
function trim(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [provider, p] of Object.entries(raw)) {
    for (const [id, m] of Object.entries(p?.models ?? {})) {
      const c = m?.cost;
      const ok = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
      if (!c || !ok(c.input) || !ok(c.output)) continue;
      out[`${provider}/${id}`] = [c.input, c.output, ok(c.cache_read) ? c.cache_read : c.input / 10];
    }
  }
  return out;
}
var cached2;
function readCatalog() {
  const file2 = catalogFile();
  try {
    const { mtimeMs } = fs16.statSync(file2);
    if (cached2?.file === file2 && cached2.mtimeMs === mtimeMs) return cached2.catalog;
    const parsed = JSON.parse(fs16.readFileSync(file2, "utf8"));
    const catalog5 = parsed && typeof parsed.models === "object" && parsed.models && Number.isFinite(Date.parse(parsed.fetchedAt)) ? parsed : void 0;
    cached2 = { file: file2, mtimeMs, catalog: catalog5 };
    return catalog5;
  } catch {
    return void 0;
  }
}
var ageMs = (file2) => {
  try {
    return Date.now() - fs16.statSync(file2).mtimeMs;
  } catch {
    return Infinity;
  }
};
function refreshDue() {
  const eff = effective();
  if (!eff.priceFeed.value) return false;
  if (ageMs(catalogFile()) < eff.priceFeedHours.value * 36e5) return false;
  return ageMs(attemptFile()) > RETRY_AFTER_FAILURE_MS;
}
async function refreshCatalog() {
  const url = effective().priceFeedUrl.value;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3e4), headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const models = trim(await r.json());
    const n = Object.keys(models).length;
    if (n < MIN_MODELS) throw new Error(`only ${n} priced models in it (a catalog has thousands): not used`);
    fs16.mkdirSync(home(), { recursive: true });
    const tmp = `${catalogFile()}.${process.pid}.tmp`;
    const catalog5 = { fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), source: url, models };
    fs16.writeFileSync(tmp, JSON.stringify(catalog5));
    renameOver(tmp, catalogFile());
    fs16.rmSync(attemptFile(), { force: true });
    return { state: "updated", models: n };
  } catch (e) {
    try {
      fs16.mkdirSync(home(), { recursive: true });
      fs16.writeFileSync(attemptFile(), `${(/* @__PURE__ */ new Date()).toISOString()} ${e.message}
`);
    } catch {
    }
    return { state: "failed", error: e.message };
  }
}
function refreshInBackground() {
  try {
    if (!refreshDue()) return;
    const script = process.argv[1];
    if (!script) return;
    fs16.mkdirSync(home(), { recursive: true });
    fs16.writeFileSync(attemptFile(), `${(/* @__PURE__ */ new Date()).toISOString()} refresh started
`);
    const child = spawn2(process.execPath, [script, "prices", "--refresh", "--quiet"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => void 0);
    child.unref();
  } catch {
  }
}
var OWN = { codex: ["openai"], claude: ["anthropic"], gemini: ["google"] };
function catalogPrice(backend, ...models) {
  const catalog5 = readCatalog();
  if (!catalog5) return void 0;
  for (const raw of models) {
    const id = raw?.split("#")[0];
    if (!id) continue;
    const keys = [id, ...[...OWN[backend] ?? [], "anthropic", "openai", "google"].map((p) => `${p}/${id}`)];
    const any = keys.find((k) => catalog5.models[k]) ?? Object.keys(catalog5.models).filter((k) => k.endsWith(`/${id}`)).sort()[0];
    const triple = any ? catalog5.models[any] : void 0;
    if (any && triple && triple.length === 3 && triple.every((n) => Number.isFinite(n) && n >= 0)) {
      const [input, output, cachedInput] = triple;
      return { input, output, cachedInput, key: any };
    }
  }
  return void 0;
}
function catalogStatus() {
  const eff = effective();
  const c = readCatalog();
  let lastFailure;
  try {
    const t = fs16.readFileSync(attemptFile(), "utf8").trim();
    if (t && !t.endsWith("refresh started")) lastFailure = t;
  } catch {
  }
  return {
    enabled: eff.priceFeed.value,
    url: eff.priceFeedUrl.value,
    hours: eff.priceFeedHours.value,
    file: catalogFile(),
    models: c ? Object.keys(c.models).length : void 0,
    fetchedAt: c?.fetchedAt,
    ageHours: c ? (Date.now() - Date.parse(c.fetchedAt)) / 36e5 : void 0,
    lastFailure
  };
}

// src/core/receipt.ts
var PRESETS = {
  sonnet: { name: "Claude Sonnet", input: 3, output: 15, cachedInput: 0.3 },
  opus: { name: "Claude Opus", input: 5, output: 25, cachedInput: 0.5 },
  haiku: { name: "Claude Haiku", input: 1, output: 5, cachedInput: 0.1 },
  "gpt-5": { name: "GPT-5", input: 1.25, output: 10, cachedInput: 0.125 }
};
function primaryPrice() {
  const eff = effective();
  const custom = eff.price.value?.split(",").map(Number);
  if (custom && custom.length >= 2 && custom.every((n) => Number.isFinite(n) && n >= 0)) {
    return { name: "custom", input: custom[0], output: custom[1], cachedInput: custom[2] ?? custom[0] / 10 };
  }
  const named = eff.primary.value;
  const preset = PRESETS[named.toLowerCase()];
  if (preset) return preset;
  const c = eff.priceFeed.value ? catalogPrice("", named) : void 0;
  return c ? { name: named, source: "catalog", input: c.input, output: c.output, cachedInput: c.cachedInput } : PRESETS.sonnet;
}
var estimateTokens = (text) => Math.ceil(text.length / 4);
function parsePriceSpec(spec, name = "worker") {
  const parts = typeof spec === "string" ? spec.split(",").map((x) => Number(x.trim())) : [];
  if (parts.length < 2 || parts.length > 3 || !parts.every((n) => Number.isFinite(n) && n >= 0)) return void 0;
  return { name, source: "config", input: parts[0], output: parts[1], cachedInput: parts[2] ?? parts[0] / 10 };
}
function workerPrice(backend, ...models) {
  const prices = effective().workerPrices.value;
  for (const key of [...models.filter((m) => !!m).map((m) => `${backend}:${m.split("#")[0]}`), backend]) {
    if (prices[key] !== void 0) return parsePriceSpec(prices[key], key);
  }
  const c = effective().priceFeed.value ? catalogPrice(backend, ...models) : void 0;
  return c ? { name: c.key, source: "catalog", input: c.input, output: c.output, cachedInput: c.cachedInput } : void 0;
}
var costAt = (usage2, price) => (usage2.input * price.input + usage2.cacheRead * price.cachedInput + (usage2.output + usage2.reasoning) * price.output) / 1e6;
var workerCostOf = (usage2) => usage2?.cost ?? usage2?.costEstimate;
function savedUsd(usage2, returnedTokens, price = primaryPrice()) {
  const readingTheReport = returnedTokens * price.input / 1e6;
  return Math.max(0, costAt(usage2, price) - (workerCostOf(usage2) ?? 0) - readingTheReport);
}
function record(meta) {
  if (!meta.usage?.steps || meta.auditOf) return;
  const entry = {
    id: meta.id,
    at: meta.endedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    mode: meta.mode,
    state: meta.state,
    backend: (meta.ran ?? meta.worker).backend,
    model: meta.resolvedModel ?? (meta.ran ?? meta.worker).model,
    tokens: meta.usage.total,
    returned: meta.returnedTokens ?? 0,
    workerCost: workerCostOf(meta.usage) ?? 0,
    ...meta.usage.cost === void 0 && meta.usage.costEstimate !== void 0 ? { costEstimated: true, costSource: meta.usage.costSource } : {},
    saved: meta.savedUsd ?? 0,
    price: primaryPrice().name
  };
  fs17.mkdirSync(path15.dirname(ledgerFile()), { recursive: true });
  fs17.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}
`);
}
function readLedger(sinceMs2) {
  if (!fs17.existsSync(ledgerFile())) return [];
  return fs17.readFileSync(ledgerFile(), "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  }).filter((e) => !sinceMs2 || Date.parse(e.at) >= sinceMs2);
}
function totals(entries) {
  const t = entries.reduce(
    (a, e) => ({
      runs: a.runs + 1,
      tokens: a.tokens + e.tokens,
      returned: a.returned + e.returned,
      workerCost: a.workerCost + e.workerCost,
      saved: a.saved + e.saved
    }),
    { runs: 0, tokens: 0, returned: 0, workerCost: 0, saved: 0 }
  );
  return { ...t, ratio: t.returned ? t.tokens / t.returned : 0 };
}
var usd = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
function compact(n) {
  const fmt = (v) => v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, "");
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}k`;
  return String(Math.round(n));
}
function badgeUrl(t) {
  const msg = encodeURIComponent(`saved ${usd(t.saved)} \xB7 ${compact(t.tokens)} tokens offloaded`).replace(/-/g, "--");
  return `https://img.shields.io/badge/pitroom-${msg}-7c3aed`;
}
var esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function card(t, period) {
  const W = 720, H = 316, M = 32, GAP = 12;
  const tile = (i, value, label) => {
    const w = (W - 2 * M - 2 * GAP) / 3, x = M + i * (w + GAP);
    return `<rect x="${x}" y="196" width="${w}" height="72" rx="14" fill="#fff" fill-opacity=".035" stroke="#fff" stroke-opacity=".1"/>
<text x="${x + 18}" y="224" class="lab">${esc(label.toUpperCase())}</text><text x="${x + 18}" y="254" class="val">${esc(value)}</text>`;
  };
  const when2 = period.toUpperCase();
  const pill = 22 + when2.length * 7.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="pitroom saved ${esc(usd(t.saved))}">
<style>
text{font-family:ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;fill:#f4f4f5}
.name{font-size:20px;font-weight:650;letter-spacing:-.01em}
.sub{font-size:12.5px;fill:#a1a1aa}
.pill{font-size:11px;font-weight:600;letter-spacing:.1em;fill:#a1a1aa}
.lab{font-size:11px;font-weight:500;letter-spacing:.09em;fill:#a1a1aa}
.big{font-size:60px;font-weight:700;letter-spacing:-.03em;fill:#3ddc97}
.val{font-size:26px;font-weight:650;letter-spacing:-.02em}
.foot{font-size:11.5px;fill:#71717a}
</style>
<defs>
<radialGradient id="o" cx="1" cy="0" r=".7"><stop offset="0" stop-color="#ff6a2b" stop-opacity=".24"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></radialGradient>
<radialGradient id="b" cx="0" cy="0" r=".7"><stop offset="0" stop-color="#38bdf8" stop-opacity=".16"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
<linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6a2b"/><stop offset="1" stop-color="#ffa86b"/></linearGradient>
<clipPath id="c"><rect width="${W}" height="${H}" rx="20"/></clipPath>
</defs>
<g clip-path="url(#c)"><rect width="${W}" height="${H}" fill="#0b0b0f"/><rect width="${W}" height="${H}" fill="url(#o)"/><rect width="${W}" height="${H}" fill="url(#b)"/></g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="19.5" fill="none" stroke="#fff" stroke-opacity=".1"/>
<rect x="${M}" y="28" width="38" height="38" rx="11" fill="url(#m)"/>
<path d="M4 4h4v4H4zm8 0h4v4h-4zM8 8h4v4H8zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4zm-4 4h4v4H8zm8 0h4v4h-4z" fill="#fff" transform="translate(${M + 7} 35) scale(1)"/>
<text x="${M + 52}" y="45" class="name">Pitroom</text><text x="${M + 52}" y="63" class="sub">Your agent's pit crew</text>
<rect x="${W - M - pill}" y="34" width="${pill}" height="26" rx="13" fill="#fff" fill-opacity=".04" stroke="#fff" stroke-opacity=".14"/>
<text x="${W - M - pill / 2}" y="51" class="pill" text-anchor="middle">${esc(when2)}</text>
<text x="${M}" y="112" class="lab">SAVED ON YOUR MAIN CODING AGENT</text>
<text x="${M}" y="168" class="big">${esc(usd(t.saved))}</text>
${tile(0, compact(t.tokens), "Tokens offloaded")}${tile(1, t.ratio ? `${Math.round(t.ratio)}\xD7` : "\u2014", "Context compression")}${tile(2, String(t.runs), "Delegated tasks")}
<text x="${M}" y="296" class="foot">Estimated against ${esc(primaryPrice().name)} pricing \xB7 npx pitroom</text>
</svg>
`;
}

// src/core/ui.ts
import fs18 from "node:fs";
var WEEK_MS = 7 * 24 * 3600 * 1e3;
var RECENT = 40;
var RECENT_HOURS = 1;
var MAX_CARDS = 5;
function activeRuns() {
  const out = [];
  for (const id of listRunIds().slice(-RECENT)) {
    try {
      const m = readMeta(id);
      if (isActive(m.state) && (m.state === "queued" || isAlive(m.pid))) out.push(m);
    } catch {
    }
  }
  return out;
}
function statusLine() {
  const running = activeRuns();
  const saved = totals(readLedger(Date.now() - WEEK_MS)).saved;
  if (!running.length && !saved) return "";
  const parts = ["\u{1F3C1} pitroom"];
  if (running.length) {
    const who = [...new Set(running.map((m) => (m.ran ?? m.worker).backend))].join(", ");
    parts.push(`${running.length} running (${who})`);
  }
  if (saved) parts.push(`~${usd(saved)} saved this week`);
  return parts.join(" \xB7 ");
}
var RUN_ID = /\b\d{8}-\d{6}-[0-9a-f]{4}\b/g;
var PITROOM_CALL = /(^|[\s;&|(`])(\S*\/)?pitroom(\.mjs)?(\s|$)/;
var ICON = { done: "\u2714", failed: "\u2718", timeout: "\u23F1", stopped: "\u25A0" };
function kind(m) {
  if (m.auditOf) return "audit";
  if (m.reviewOf) return m.reviewKind === "range" ? "branch review" : m.reviewKind === "fix" ? "re-review" : "review";
  return m.mode === "read" ? "research" : m.mode === "isolate" ? "change (isolated copy)" : "change";
}
var SUBJECT_MAX = 48;
function short(text) {
  const s = text.replace(/`/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, "")}\u2026`;
}
var MODEL_MAX = 24;
function workerName(t) {
  if (!t.model) return t.backend;
  const model = (t.model.split("/").pop() ?? t.model).replace(/-(contributor-)?free$/, "").replace(/-\d+\.\d+$/, "");
  return `${t.backend} (${model.length > MODEL_MAX ? `${model.slice(0, MODEL_MAX - 1)}\u2026` : model})`;
}
function ranTarget(m) {
  const t = m.ran ?? m.worker;
  return t.model || !m.resolvedModel ? t : { ...t, model: m.resolvedModel };
}
function what(m) {
  if (m.plan) return short(`Task ${m.plan.step}: ${m.plan.title}`);
  if (m.auditOf) return `of ${m.auditOf}`;
  if (m.reviewOf) return `of ${m.reviewOf.replace(/\b([0-9a-f]{9})[0-9a-f]{31}\b/g, "$1")}`;
  const line = m.task.split("\n").find((l) => l.trim()) ?? "";
  const brief2 = /^You are implementing Task (\d+)\b.*?\bplan\s+(\S+)/i.exec(line);
  if (brief2) return short(`Task ${brief2[1]} \xB7 ${brief2[2].split("/").pop().replace(/\.md\W*$/, "")}`);
  return short(line);
}
function elapsed(m) {
  const s = Math.round((Date.parse(m.endedAt ?? "") - Date.parse(m.startedAt)) / 1e3);
  if (!Number.isFinite(s) || s < 0) return "";
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
var startedCard = (m) => `\u{1F3C1} Pitroom \u25B6 ${kind(m)} on ${workerName(m.worker)} \xB7 ${what(m)}  (${m.id})`;
function endedCard(m) {
  const v = m.verdict;
  const bits = [
    `\u{1F3C1} Pitroom ${ICON[m.state] ?? "\u2022"} ${kind(m)} ${m.state} on ${workerName(ranTarget(m))}`,
    what(m),
    elapsed(m),
    v && `SPEC ${v.spec.toUpperCase()} \xB7 QUALITY ${v.quality.toUpperCase()}`,
    m.auditVerdict && `${m.auditVerdict.toUpperCase()}${m.auditDisputed?.length ? ` \xB7 ${m.auditDisputed.length} disputed` : ""}`,
    m.changes?.length ? `${m.changes.length} file${m.changes.length === 1 ? "" : "s"} changed` : "",
    m.savedUsd ? `~${usd(m.savedUsd)} saved` : ""
  ];
  return `${bits.filter(Boolean).join(" \xB7 ")}  (${m.id})`;
}
function cardsFor(m) {
  const phases = [["started", () => startedCard(m)]];
  if (!isActive(m.state)) phases.push(["ended", () => endedCard(m)]);
  if (m.applied) {
    phases.push(["applied", () => `\u{1F3C1} Pitroom \u2935 applied ${m.changes?.length ?? 0} file(s) from ${m.id} to your tree`]);
  }
  const out = [];
  for (const [phase, text] of phases) {
    const marker = runFile(m.id, `card-${phase}`);
    if (fs18.existsSync(marker)) continue;
    if (!(phase === "started" && !isActive(m.state))) out.push(text());
    fs18.writeFileSync(marker, "");
  }
  return out;
}
function hookCards(input) {
  const event = JSON.parse(input);
  const command = event.tool_input?.command ?? "";
  if (event.tool_name !== "Bash" || !PITROOM_CALL.test(command)) return "";
  const response = event.tool_response;
  const output = typeof response === "string" ? response : [response?.stdout, response?.stderr].filter(Boolean).join("\n");
  const ids = [...new Set(`${command}
${output}`.match(RUN_ID) ?? [])].filter((id) => fs18.existsSync(`${runsDir()}/${id}`));
  const since2 = Date.now() - RECENT_HOURS * 36e5;
  for (const id of listRunIds().slice(-RECENT)) {
    if (ids.includes(id) || fs18.existsSync(runFile(id, "card-ended"))) continue;
    try {
      const m = readMeta(id);
      if (!isActive(m.state) && Date.parse(m.endedAt ?? m.startedAt) > since2) ids.push(id);
    } catch {
    }
  }
  const cards = [];
  for (const id of ids.slice(0, MAX_CARDS)) {
    try {
      cards.push(...cardsFor(readMeta(id)));
    } catch {
    }
  }
  return cards.join("\n");
}

// src/core/history.ts
var SCHEMA_VERSION = 1;
var PATCH_MAX = 1e6;
var ANSWER_MAX2 = 2e5;
var cached3;
var historyFile = () => path16.join(home(), "history.db");
function openDb() {
  const file2 = historyFile();
  if (cached3?.file === file2) return cached3.db;
  let db;
  try {
    const emit = process.emitWarning;
    process.emitWarning = ((w, ...rest) => /SQLite/i.test(String(w?.message ?? w)) ? void 0 : emit.call(process, w, ...rest));
    let DatabaseSync;
    try {
      ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
    } finally {
      process.emitWarning = emit;
    }
    fs19.mkdirSync(path16.dirname(file2), { recursive: true });
    db = new DatabaseSync(file2);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    migrate(db);
  } catch {
    db = void 0;
  }
  cached3 = { file: file2, db };
  return db;
}
function migrate(db) {
  const v = db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
  if (v >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL, mode TEXT, kind TEXT,
      backend TEXT, model TEXT, task TEXT, grp TEXT, dir TEXT, review_of TEXT, verdict TEXT,
      seconds INTEGER, steps INTEGER, tool_calls INTEGER, tokens INTEGER, returned_tokens INTEGER,
      cost REAL, saved REAL, files_changed INTEGER, applied INTEGER, error TEXT,
      answer TEXT, patch TEXT, meta_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
    CREATE INDEX IF NOT EXISTS runs_model ON runs(backend, model);
    CREATE INDEX IF NOT EXISTS runs_grp ON runs(grp);
    CREATE TABLE IF NOT EXISTS steps (
      run_id TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT, name TEXT, text TEXT, ok INTEGER, at INTEGER,
      PRIMARY KEY (run_id, n)
    ) WITHOUT ROWID;
    CREATE VIRTUAL TABLE IF NOT EXISTS runs_fts USING fts5(id UNINDEXED, task, answer, steps);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
function readRunFile(id, name) {
  const f = runFile(id, name);
  try {
    if (fs19.existsSync(f)) return fs19.readFileSync(f, "utf8");
    if (fs19.existsSync(`${f}.gz`)) return zlib.gunzipSync(fs19.readFileSync(`${f}.gz`)).toString("utf8");
  } catch {
  }
  return void 0;
}
function gzipFile(f) {
  if (!fs19.existsSync(f)) return;
  fs19.writeFileSync(`${f}.gz`, zlib.gzipSync(fs19.readFileSync(f)));
  fs19.rmSync(f);
}
function compactRun(meta) {
  if (!TERMINAL.includes(meta.state)) return;
  const dir = path16.dirname(runFile(meta.id, "meta.json"));
  let names;
  try {
    names = fs19.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (/^events(\.attempt-\d+)?\.jsonl$/.test(n)) gzipFile(path16.join(dir, n));
    else if (/^stderr(\.attempt-\d+)?\.log$/.test(n)) {
      if (meta.state === "done" && !/attempt/.test(n)) fs19.rmSync(path16.join(dir, n), { force: true });
      else gzipFile(path16.join(dir, n));
    }
  }
}
var clip5 = (s, n) => s && s.length > n ? s.slice(0, n) : s;
function timelineOf(meta) {
  const raw = readRunFile(meta.id, "events.jsonl");
  if (!raw) return [];
  try {
    return getBackend((meta.ran ?? meta.worker).backend).parse(raw).timeline ?? [];
  } catch {
    return [];
  }
}
function recordRun(meta) {
  if (!TERMINAL.includes(meta.state)) return;
  const db = openDb();
  if (!db) return;
  try {
    const u = meta.usage;
    const known = db.prepare("SELECT answer IS NOT NULL AS has FROM runs WHERE id = ?").get(meta.id);
    const answer = known?.has ? void 0 : clip5(readRunFile(meta.id, "summary.md")?.trim(), ANSWER_MAX2);
    const patch = known?.has ? void 0 : clip5(readRunFile(meta.id, "changes.patch"), PATCH_MAX);
    const seconds = meta.endedAt ? Math.max(0, Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1e3)) : null;
    const t = meta.ran ?? meta.worker;
    const fields = {
      id: meta.id,
      started_at: meta.startedAt,
      ended_at: meta.endedAt ?? null,
      state: meta.state,
      mode: meta.mode,
      kind: kind(meta),
      backend: t.backend,
      model: meta.resolvedModel ?? t.model ?? null,
      task: clip5(meta.task, 2e4) ?? "",
      grp: meta.group ?? null,
      dir: meta.dir,
      review_of: meta.reviewOf ?? meta.auditOf ?? null,
      verdict: meta.verdict ? `SPEC ${meta.verdict.spec.toUpperCase()} \xB7 QUALITY ${meta.verdict.quality.toUpperCase()}` : meta.auditVerdict ? `AUDIT ${meta.auditVerdict.toUpperCase()}` : null,
      seconds,
      steps: u?.steps ?? null,
      tool_calls: u?.toolCalls ?? null,
      tokens: u?.total ?? null,
      returned_tokens: meta.returnedTokens ?? null,
      cost: u?.cost ?? u?.costEstimate ?? null,
      saved: meta.savedUsd ?? null,
      files_changed: meta.changes?.length ?? 0,
      applied: meta.applied ? 1 : 0,
      error: clip5(meta.error, 2e3) ?? null,
      meta_json: JSON.stringify(meta)
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      const cols = Object.keys(fields);
      db.prepare(`INSERT INTO runs (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
        ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",")}`).run(...Object.values(fields));
      if (!known?.has) {
        const steps = timelineOf(meta);
        db.prepare("UPDATE runs SET answer = ?, patch = ? WHERE id = ?").run(answer ?? "", patch ?? null, meta.id);
        db.prepare("DELETE FROM steps WHERE run_id = ?").run(meta.id);
        const ins = db.prepare("INSERT INTO steps (run_id, n, kind, name, text, ok, at) VALUES (?,?,?,?,?,?,?)");
        steps.forEach((s, n) => ins.run(meta.id, n, s.kind, s.name ?? null, s.text, s.ok === void 0 ? null : s.ok ? 1 : 0, s.at ?? null));
        db.prepare("DELETE FROM runs_fts WHERE id = ?").run(meta.id);
        db.prepare("INSERT INTO runs_fts (id, task, answer, steps) VALUES (?,?,?,?)").run(meta.id, fields.task, answer ?? "", steps.map((s) => s.text).join("\n"));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    compactRun(meta);
  } catch {
  }
}
function importRuns() {
  const db = openDb();
  if (!db) return { imported: 0, known: 0 };
  const have = new Set(db.prepare("SELECT id FROM runs").all().map((r) => r.id));
  let imported = 0;
  for (const id of listRunIds()) {
    if (have.has(id)) continue;
    try {
      const m = readMeta(id);
      if (!TERMINAL.includes(m.state)) continue;
      recordRun(m);
      imported++;
    } catch {
    }
  }
  return { imported, known: have.size };
}
function archivedRun(id) {
  const db = openDb();
  if (!db) return void 0;
  try {
    const r = db.prepare("SELECT meta_json, answer, patch, started_at FROM runs WHERE id = ?").get(id);
    if (!r) return void 0;
    const start = Date.parse(r.started_at);
    const steps = db.prepare("SELECT kind, name, text, ok, at FROM steps WHERE run_id = ? ORDER BY n").all(id).map((s) => ({
      kind: s.kind,
      name: s.name ?? void 0,
      text: s.text,
      ok: s.ok === null ? void 0 : !!s.ok,
      at: s.at ?? void 0,
      t: s.at && Number.isFinite(start) ? Math.max(0, Math.round((s.at - start) / 1e3)) : void 0
    }));
    return { meta: JSON.parse(r.meta_json), answer: r.answer ?? "", patch: r.patch ?? void 0, patchTruncated: r.patch?.length >= PATCH_MAX, steps };
  } catch {
    return void 0;
  }
}
function archivedId(ref) {
  const db = openDb();
  if (!db || !/^[\w-]{3,}$/.test(ref)) return void 0;
  try {
    const rows = db.prepare("SELECT id FROM runs WHERE id = ? OR id LIKE ? OR id LIKE ? ORDER BY id").all(ref, `${ref}%`, `%${ref}`);
    return rows.length === 1 ? rows[0].id : rows.find((r) => r.id === ref)?.id;
  } catch {
    return void 0;
  }
}
var VERIFY_FAILED = "(r.state = 'done' AND json_extract(r.meta_json, '$.verifyResult.ok') = 0)";
var ftsQuery = (text) => text.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ");
function listHistory(q = {}) {
  const db = openDb();
  if (!db) return { rows: [], total: 0 };
  const where = [];
  const args = [];
  if (q.text?.trim()) {
    where.push("r.id IN (SELECT id FROM runs_fts WHERE runs_fts MATCH ?)");
    args.push(ftsQuery(q.text));
  }
  if (q.model) {
    where.push("r.model = ?");
    args.push(q.model);
  }
  if (q.backend) {
    where.push("r.backend = ?");
    args.push(q.backend);
  }
  if (q.state) {
    where.push(q.state === "problem" ? `(r.state IN ('failed','timeout','stopped') OR ${VERIFY_FAILED})` : "r.state = ?");
    if (q.state !== "problem") args.push(q.state);
  }
  if (q.group) {
    where.push("r.grp = ?");
    args.push(q.group);
  }
  if (q.sinceMs) {
    where.push("r.started_at >= ?");
    args.push(new Date(q.sinceMs).toISOString());
  }
  const base2 = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM runs r ${base2}`).get(...args).n;
    const page2 = q.beforeId ? `${base2 ? `${base2} AND` : "WHERE"} r.id < ?` : base2;
    const rows = db.prepare(`SELECT r.*, json_extract(r.meta_json, '$.audit.state') AS audit_state, json_extract(r.meta_json, '$.audit.verdict') AS audit_verdict, ${VERIFY_FAILED} AS verify_failed FROM runs r ${page2} ORDER BY r.id DESC LIMIT ?`).all(...args, ...q.beforeId ? [q.beforeId] : [], Math.min(Math.max(q.limit ?? 30, 1), 200));
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        state: r.state,
        kind: r.kind,
        backend: r.backend,
        model: r.model ?? void 0,
        task: r.review_of ? `of ${r.review_of.replace(/\b([0-9a-f]{9})[0-9a-f]{31}\b/g, "$1")}` : r.task.split("\n").find((l) => l.trim()) ?? "",
        group: r.grp ?? void 0,
        verdict: r.verdict ?? void 0,
        audit: auditBadge({ audit: r.audit_state ? { id: "", state: r.audit_state, verdict: r.audit_verdict ?? void 0 } : void 0 }),
        verifyFailed: r.verify_failed ? true : void 0,
        seconds: r.seconds ?? void 0,
        steps: r.steps ?? void 0,
        tokens: r.tokens ?? void 0,
        saved: r.saved ?? void 0,
        files: r.files_changed ?? 0,
        applied: !!r.applied
      }))
    };
  } catch {
    return { rows: [], total: 0 };
  }
}
var NOT_AUDIT = "json_extract(meta_json, '$.auditOf') IS NULL";
function auditStats(db, since2) {
  const total = { runs: 0, agree: 0, partial: 0, disagree: 0, unclear: 0, tokens: 0 };
  const byWorker = /* @__PURE__ */ new Map();
  try {
    const t = db.prepare("SELECT COUNT(*) runs, COALESCE(SUM(tokens),0) tokens FROM runs WHERE started_at >= ? AND json_extract(meta_json, '$.auditOf') IS NOT NULL").get(since2);
    total.runs = t.runs;
    total.tokens = t.tokens;
    const rows = db.prepare(`SELECT r.backend, r.model, json_extract(a.meta_json, '$.auditVerdict') v, COUNT(*) n
      FROM runs a JOIN runs r ON r.id = json_extract(a.meta_json, '$.auditOf')
      WHERE a.started_at >= ? AND a.state = 'done' AND json_extract(a.meta_json, '$.auditOf') IS NOT NULL
      GROUP BY r.backend, r.model, v`).all(since2);
    for (const r of rows) {
      const v = r.v ?? "unclear";
      if (v in total && v !== "runs" && v !== "tokens") total[v] += r.n;
      const k = `${r.backend ?? ""}\0${r.model ?? ""}`;
      const w = byWorker.get(k) ?? { audited: 0, agreed: 0 };
      w.audited += r.n;
      if (r.v === "agree") w.agreed += r.n;
      byWorker.set(k, w);
    }
  } catch {
  }
  return { total, byWorker };
}
function workerRows(rows, ledger, audited) {
  const out = rows.map((r) => ({ backend: r.backend, model: r.model ?? void 0, runs: r.runs, ok: r.ok ?? 0, limited: r.limited ?? 0, avgSeconds: r.avg_s, avgTokens: r.avg_t, saved: 0, audited: 0, agreed: 0 }));
  const key = (backend, model) => `${backend ?? ""}\0${model ?? ""}`;
  const index = new Map(out.map((r) => [key(r.backend, r.model), r]));
  for (const e of ledger) {
    const backend = e.backend ?? "opencode";
    let row = index.get(key(backend, e.model)) ?? (e.model ? out.find((r) => r.backend === backend && r.model?.endsWith(`/${e.model}`)) : void 0);
    if (!row) {
      row = { backend, model: e.model, runs: 0, ok: 0, limited: 0, avgSeconds: null, avgTokens: null, saved: 0, audited: 0, agreed: 0 };
      index.set(key(backend, e.model), row);
      out.push(row);
    }
    row.saved += e.saved;
  }
  for (const r of out) {
    const a = audited.get(key(r.backend, r.model));
    if (a) Object.assign(r, a);
  }
  return out;
}
var LIMITED = `(state='failed' AND (json_extract(meta_json,'$.failureKind')='rate-limited' OR error LIKE '%the model is rate-limited or overloaded%'))`;
function historyStats(sinceMs2) {
  const counted = effective().countRateLimits.value === true;
  const K = counted ? "1" : `NOT ${LIMITED}`;
  const empty = { rateLimits: counted ? "counted" : "excluded", totals: { runs: 0, ok: 0, failed: 0, limited: 0, seconds: 0, tokens: 0, saved: 0 }, audits: { runs: 0, agree: 0, partial: 0, disagree: 0, unclear: 0, tokens: 0 }, byWorker: [], byDay: [] };
  const db = openDb();
  if (!db) return empty;
  const since2 = sinceMs2 ? new Date(sinceMs2).toISOString() : "";
  try {
    const t = db.prepare(`SELECT COALESCE(SUM(${K}),0) runs, COALESCE(SUM(state='done'),0) ok, COALESCE(SUM(${LIMITED}),0) limited, COALESCE(SUM(CASE WHEN ${K} THEN seconds END),0) seconds, COALESCE(SUM(CASE WHEN ${K} THEN tokens END),0) tokens, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT}`).get(since2);
    const w = db.prepare(`SELECT backend, model, SUM(${K}) runs, SUM(state='done') ok, SUM(${LIMITED}) limited, AVG(CASE WHEN ${K} THEN seconds END) avg_s, AVG(CASE WHEN ${K} THEN tokens END) avg_t, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT} GROUP BY backend, model ORDER BY runs DESC LIMIT 40`).all(since2);
    const d = db.prepare(`SELECT substr(started_at,1,10) day, SUM(${K}) runs, SUM(state='done') ok, SUM(${LIMITED}) limited, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT} GROUP BY day ORDER BY day DESC LIMIT 60`).all(since2);
    const audits = auditStats(db, since2);
    const ledger = readLedger(sinceMs2);
    const byDay = /* @__PURE__ */ new Map();
    for (const e of ledger) byDay.set(e.at.slice(0, 10), (byDay.get(e.at.slice(0, 10)) ?? 0) + e.saved);
    return {
      rateLimits: counted ? "counted" : "excluded",
      totals: { runs: t.runs, ok: t.ok, failed: t.runs - t.ok, limited: t.limited, seconds: t.seconds, tokens: t.tokens, saved: totals(ledger).saved },
      audits: audits.total,
      byWorker: workerRows(w, ledger, audits.byWorker),
      byDay: d.reverse().map((r) => ({ day: r.day, runs: r.runs, ok: r.ok ?? 0, limited: r.limited ?? 0, saved: byDay.get(r.day) ?? 0 }))
    };
  } catch {
    return empty;
  }
}

// src/core/report.ts
import fs21 from "node:fs";

// src/core/plan.ts
import fs20 from "node:fs";
import path17 from "node:path";
var FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
var RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
function structure(lines) {
  const headings = [];
  const rules = [];
  const fenced = [];
  let open;
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (f) {
      fenced[i] = true;
      const mark = f[1];
      if (!open) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !f[2].trim()) open = void 0;
      return;
    }
    fenced[i] = !!open;
    if (open) return;
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ line: i, level: h[1].length, text: h[2] });
    else if (RULE.test(l)) rules.push(i);
  });
  return { headings, rules, fenced };
}
function parsePlan(text, file2 = "") {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const { headings, rules, fenced } = structure(lines);
  const after = (line) => Math.min(headings.find((h) => h.line > line)?.line ?? lines.length, rules.find((r) => r > line) ?? lines.length);
  const titleHeading = headings.find((h) => h.level === 1);
  const start = titleHeading ? titleHeading.line + 1 : 0;
  const header = lines.slice(start, after(start - 1)).filter((l) => !/^\s*>/.test(l)).join("\n").trim();
  const gc = headings.find((h) => /^global constraints\b/i.test(h.text));
  const constraints = gc ? lines.slice(gc.line + 1, after(gc.line)).join("\n").trim() : "";
  const tasks = [];
  for (const h of headings) {
    const m = /^Task\s+(\d+)\b\s*[:.)\-–—]?\s*(.*)$/i.exec(h.text);
    if (!m) continue;
    const end = headings.find((o) => o.line > h.line && o.level <= h.level)?.line ?? lines.length;
    const body = lines.slice(h.line, end).join("\n").replace(/(\n\s*(?:---|\*\*\*|___)\s*)+$/, "").trimEnd();
    const unfenced = lines.slice(h.line, end).filter((_, j) => !fenced[h.line + j]).join("\n");
    const tier = /^\s*[-*]?\s*\*\*Worker:\*\*\s*`?([\w-]+)`?/m.exec(unfenced)?.[1]?.toLowerCase();
    tasks.push({ step: Number(m[1]), title: m[2].trim(), text: body, ...tier ? { tier } : {} });
  }
  return { file: file2, title: titleHeading?.text ?? "", header, constraints, tasks };
}
function loadPlan(file2) {
  const abs = path17.resolve(file2);
  if (!fs20.existsSync(abs) || !fs20.statSync(abs).isFile()) throw new UserError(`plan not found: ${file2}`);
  const plan = parsePlan(fs20.readFileSync(abs, "utf8"), fs20.realpathSync(abs));
  if (!plan.tasks.length) throw new UserError(`${file2} has no "Task N" headings (see pitroom-writing-plans)`);
  return plan;
}
function planTask(plan, step) {
  const t = plan.tasks.find((x) => x.step === step);
  if (!t) throw new UserError(`no Task ${step} in ${plan.file}; it has ${plan.tasks.map((x) => `Task ${x.step}`).join(", ")}`);
  return t;
}
function brief(plan, task) {
  return `${[
    `# ${plan.title || planName(plan.file)}`,
    plan.header,
    "## Global Constraints",
    plan.constraints || "(none stated in the plan)",
    task.text
  ].filter(Boolean).join("\n\n")}
`;
}
var planName = (file2) => path17.basename(file2).replace(/\.md$/i, "");

// src/core/style.ts
var enabled = () => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY && process.env.TERM !== "dumb";
};
var wrap = (open, close) => (text) => enabled() ? `\x1B[${open}m${text}\x1B[${close}m` : text;
var bold = wrap(1, 22);
var dim = wrap(2, 22);
var red = wrap(31, 39);
var green = wrap(32, 39);
var yellow = wrap(33, 39);
var blue = wrap(34, 39);
var cyan = wrap(36, 39);
function stateColour(state, text = state) {
  if (state === "done") return green(text);
  if (state === "running") return blue(text);
  if (state === "queued") return yellow(text);
  if (state === "failed") return red(text);
  if (state === "timeout") return yellow(text);
  return dim(text);
}
function wrapText(text, indent) {
  const columns = process.stdout.isTTY ? process.stdout.columns : void 0;
  if (!columns || text.length + indent <= columns) return text;
  const width = Math.max(40, Math.min(columns, 110) - indent);
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`
${" ".repeat(indent)}`);
}

// src/core/report.ts
var ICON2 = {
  queued: "\u22EF",
  running: "\u2026",
  done: "\u2714",
  failed: "\u2718",
  timeout: "\u23F1",
  stopped: "\u25A0"
};
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function duration(meta) {
  const end = meta.endedAt ? Date.parse(meta.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(meta.startedAt)) / 1e3));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
function readSummary(meta) {
  const f = runFile(meta.id, "summary.md");
  return fs21.existsSync(f) ? fs21.readFileSync(f, "utf8").trim() : archivedRun(meta.id)?.answer ?? "";
}
function formatReport(meta, finalText = readSummary(meta), maxLines = 400) {
  const out = [];
  const verifyFailed = meta.state === "done" && meta.verifyResult && !meta.verifyResult.ok;
  const head = verifyFailed ? stateColour("failed", "\u26A0 done \xB7 verify failed") : stateColour(meta.state, `${ICON2[meta.state]} ${meta.state}`);
  out.push(`${bold("pitroom")} ${head} \xB7 ${meta.mode} \xB7 ${duration(meta)} \xB7 run ${dim(meta.id)}`);
  const ran = meta.ran ?? meta.worker;
  const ids = [`worker ${ran.backend}`, meta.resolvedModel && `model ${meta.resolvedModel}`, meta.sessionId && `session ${meta.sessionId}`];
  out.push(ids.filter(Boolean).join(" \xB7 "));
  if (meta.reviewOf) {
    const v = meta.verdict;
    const verdict = v ? ` \xB7 SPEC ${v.spec.toUpperCase()} \xB7 QUALITY ${v.quality.toUpperCase()} \xB7 critical ${v.critical} \xB7 important ${v.important} \xB7 minor ${v.minor}` : "";
    out.push(`review of ${meta.reviewOf} (${meta.reviewKind})${verdict}`);
  } else if (meta.plan) {
    const status = meta.taskStatus ? ` \xB7 STATUS ${meta.taskStatus}` : "";
    out.push(`plan: ${planName(meta.plan.file)} \xB7 Task ${meta.plan.step}: ${meta.plan.title}${status}`);
  }
  for (const a of meta.attempts ?? []) out.push(a.skipped ? `skipped: ${a.target} (${a.error.slice(0, 160)})` : `fallback: ${a.target} failed (${a.error.slice(0, 160)})`);
  if (meta.error) out.push(`error: ${meta.error}`);
  for (const w of meta.warnings) out.push(`warning: ${w}`);
  if (meta.state === "timeout") {
    const limit = meta.timeoutSec >= 60 ? `${Math.round(meta.timeoutSec / 60)}m` : `${meta.timeoutSec}s`;
    out.push(
      `hint: the worker hit its time limit (${limit}). What it did is kept. Most runs finish in minutes, so first check it was not going in circles; for a genuinely long job raise the limit with -t 1h (or PITROOM_TIMEOUT, or "timeout" in the config)${meta.sessionId ? `, or carry on: pitroom run --continue ${meta.id} "\u2026"` : ""}`
    );
  }
  if (finalText) {
    const lines = finalText.split("\n");
    out.push("", ...lines.slice(0, maxLines));
    if (lines.length > maxLines) out.push(`\u2026 (${lines.length - maxLines} more lines: pitroom show ${meta.id} --full)`);
  }
  out.push("");
  out.push(...auditLines(meta));
  if (meta.refs) {
    const r = meta.refs;
    const bad = r.invalid.slice(0, 8).map((i) => `${i.ref} (${i.reason})`).join(", ");
    out.push(`\u2500\u2500 refs: ${r.valid}/${r.total} verified${bad ? ` \xB7 bad: ${bad}` : ""}${r.invalid.length > 8 ? " \u2026" : ""}`);
  }
  const u = meta.usage;
  if (u && u.steps) {
    const ratio = meta.returnedTokens ? `, ${Math.max(1, Math.round(u.total / meta.returnedTokens))}\xD7 compression` : "";
    out.push(
      `\u2500\u2500 receipt: worker processed ${compact(u.total)} tokens in ${plural(u.steps, "step")} (${plural(u.toolCalls, "tool call")}${u.denied ? `, ${u.denied} blocked` : ""}) \xB7 worker cost ${u.cost !== void 0 ? usd(u.cost) : u.costEstimate !== void 0 ? `~${usd(u.costEstimate)} (estimated from ${u.costSource === "catalog" ? `${catalogLabel()} prices` : "your workerPrices"})` : "n/a"} \xB7 returned ~${compact(meta.returnedTokens ?? 0)} tokens${ratio}` + (meta.savedUsd !== void 0 ? ` \xB7 est. saved ${usd(meta.savedUsd)} vs ${primaryPrice().name}` : "")
    );
  }
  if (meta.changes) {
    const s = meta.stats;
    const where = meta.mode === "isolate" ? "in the isolated copy, NOT applied yet" : "in your working tree";
    const flag2 = meta.applied ? " [applied]" : meta.reverted ? " [reverted]" : meta.discarded ? " [discarded]" : "";
    out.push(
      meta.changes.length ? `\u2500\u2500 changes (${where})${flag2}: ${s.files} files, +${s.insertions} \u2212${s.deletions}` : `\u2500\u2500 changes: none`
    );
    for (const c of meta.changes.slice(0, 50)) out.push(`   ${c.status} ${c.path}`);
    if (meta.changes.length > 50) out.push(`   \u2026 ${meta.changes.length - 50} more`);
    const deleted = meta.changes.filter((c) => c.status === "D").length;
    if (deleted && !meta.applied && !meta.reverted && !meta.discarded) {
      out.push(
        meta.mode === "isolate" ? `   \u26A0 deletes ${deleted} file${deleted === 1 ? "" : "s"}: check they are wanted before applying (apply refuses without --allow-delete)` : `   \u26A0 deleted ${deleted} file${deleted === 1 ? "" : "s"} in your tree: check they are wanted (undo: pitroom revert ${meta.id})`
      );
    }
    if (meta.changes.length) {
      out.push(`   diff:    pitroom show ${meta.id} --patch`);
      out.push(`   review:  pitroom review ${meta.id}`);
      if (meta.mode === "isolate" && !meta.applied && !meta.discarded) {
        out.push(`   apply:   pitroom apply ${meta.id}`, `   discard: pitroom discard ${meta.id}`);
      }
      if (meta.mode === "write" && !meta.reverted) out.push(`   undo:    pitroom revert ${meta.id}`);
    }
  }
  if (meta.verifyResult) {
    const v = meta.verifyResult;
    const notFound = !v.ok && v.code === 127 && /not found|no such file|is not recognized as an internal or external command/i.test(v.tail);
    out.push(`\u2500\u2500 verify: \`${meta.verify}\` ${v.ok ? "\u2714 passed" : notFound ? "\u2718 could not run (exit 127: command not found)" : `\u2718 failed (exit ${v.code})`}`);
    if (notFound) out.push("   the command is not on the PATH Pitroom runs with (an app such as an MCP client may start it without your shell's PATH): give its full path, or set PATH in the command");
    if (!v.ok && v.tail) out.push(...v.tail.split("\n").map((l) => `   ${l}`));
  }
  if (isActive(meta.state)) {
    out.push(`\u2500\u2500 still running: pitroom wait ${meta.id}   (stop: pitroom stop ${meta.id})`);
  } else if (meta.sessionId && !meta.applied && !meta.discarded && !meta.reviewOf) {
    out.push(`\u2500\u2500 follow up: pitroom run --continue ${meta.id} "\u2026"`);
  }
  return out.join("\n");
}
function live(meta) {
  const f = runFile(meta.id, "events.jsonl");
  if (!fs21.existsSync(f)) return { steps: 0, toolCalls: 0 };
  const p = getBackend((meta.ran ?? meta.worker).backend).parse(fs21.readFileSync(f, "utf8"));
  return { steps: p.usage.steps, toolCalls: p.usage.toolCalls, last: p.lastActivity };
}
function progress(meta) {
  if (meta.state === "queued") return `pitroom \u22EF queued \xB7 ${meta.mode} \xB7 waiting for a free worker slot \xB7 run ${meta.id}`;
  const l = live(meta);
  const last = l.last ? ` \xB7 last: ${l.last}` : "";
  return `pitroom \u2026 running \xB7 ${meta.mode} \xB7 ${duration(meta)} \xB7 ${l.steps} steps, ${l.toolCalls} tool calls${last} \xB7 run ${meta.id}`;
}

// src/core/group.ts
function groupIds(group) {
  return listRunIds().filter((id) => {
    try {
      return readMeta(id).group === group;
    } catch {
      return false;
    }
  });
}
var oneLine5 = (s, max) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
function headline(meta, max = 160) {
  const text = readSummary(meta);
  const line = text.split("\n").find((l) => /^SUMMARY:/i.test(l.trim())) ?? text.split("\n").find((l) => l.trim()) ?? "";
  return oneLine5(line.replace(/^SUMMARY:\s*/i, ""), max);
}
function table(metas) {
  if (!metas.length) return "no runs";
  const rows = metas.map((m) => {
    const l = m.state === "running" ? live(m) : void 0;
    const steps = l ? String(l.steps) : m.usage ? String(m.usage.steps) : "-";
    const note = l?.last ? oneLine5(l.last, 48) : isActive(m.state) ? oneLine5(m.task, 48) : headline(m, 48) || oneLine5(m.error ?? m.task, 48);
    return [m.id, m.state, m.mode, duration(m), steps, describeTarget(m.ran ?? m.worker), note];
  });
  const head = ["RUN", "STATE", "MODE", "TIME", "STEPS", "WORKER", "NOW / RESULT"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r, header = false) => r.map((c, i) => {
    const cell2 = i === r.length - 1 ? c : c.padEnd(widths[i]);
    return header ? dim(cell2) : i === 1 ? stateColour(r[1], cell2) : cell2;
  }).join("  ");
  return [fmt(head, true), ...rows.map((r) => fmt(r))].join("\n");
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitMany(ids, opts) {
  const deadline = Date.now() + opts.timeoutMs;
  for (; ; ) {
    const metas = ids.map((id) => freshMeta(id));
    const done = metas.filter((m) => TERMINAL.includes(m.state)).length;
    if (opts.any ? done > 0 : done === metas.length) return { metas, timedOut: false };
    if (Date.now() >= deadline) return { metas, timedOut: true };
    await sleep(1500);
  }
}
async function watch(select, opts) {
  const seen = /* @__PURE__ */ new Map();
  const line = (s) => opts.write(`${s}
`);
  const emit = (e, m) => {
    if (!opts.brief) return opts.write(`${JSON.stringify(e)}
`);
    if (e.event === "started" && m) line(startedCard(m));
    else if (e.event === "fallback" && m) line(`\u{1F3C1} Pitroom \u21BB ${m.id} fell back from ${String(e.failed)}: ${String(e.reason)}`);
    else if (m && TERMINAL.includes(m.state)) line(endedCard(m));
    else if (e.event === "all-done") line(`\u{1F3C1} Pitroom: ${String(e.runs)} run${e.runs === 1 ? "" : "s"} finished (${String(e.ok)} ok${e.failed ? `, ${String(e.failed)} not ok` : ""})`);
  };
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;
  for (; ; ) {
    const metas = select().map((id) => freshMeta(id));
    if (opts.json || opts.brief) {
      for (const m of metas) {
        const prev = seen.get(m.id);
        const l = m.state === "running" ? live(m) : { steps: m.usage?.steps ?? 0, toolCalls: m.usage?.toolCalls ?? 0 };
        const attempts = m.attempts?.length ?? 0;
        const base2 = { run: m.id, mode: m.mode, task: oneLine5(m.task, 60) };
        if (!prev) emit({ event: m.state === "queued" ? "queued" : "started", ...base2 }, m);
        else if (prev.state === "queued" && m.state === "running") emit({ event: "started", ...base2 }, m);
        if (attempts > (prev?.attempts ?? 0)) {
          const a = m.attempts[attempts - 1];
          emit({ event: "fallback", run: m.id, failed: a.target, reason: oneLine5(a.error, 120) }, m);
        }
        if (m.state === "running" && l.steps > (prev?.steps ?? 0)) {
          emit({ event: "progress", run: m.id, steps: l.steps, tools: l.toolCalls, last: "last" in l && l.last ? oneLine5(String(l.last), 80) : void 0 });
        }
        if (TERMINAL.includes(m.state) && prev?.state !== m.state) {
          emit({
            event: m.state,
            run: m.id,
            time: duration(m),
            worker: describeTarget(m.ran ?? m.worker),
            summary: headline(m) || void 0,
            error: m.error ? oneLine5(m.error, 160) : void 0,
            refs: m.refs ? `${m.refs.valid}/${m.refs.total}` : void 0,
            changes: m.changes?.length || void 0
          }, m);
        }
        seen.set(m.id, { state: m.state, steps: l.steps, attempts });
      }
    } else {
      opts.write(`\x1B[H\x1B[2J${table(metas)}

${(/* @__PURE__ */ new Date()).toLocaleTimeString()} \xB7 Ctrl-C to stop watching (workers keep running)
`);
    }
    const allDone = metas.length > 0 && metas.every((m) => TERMINAL.includes(m.state));
    if (allDone || metas.length === 0 && seen.size === 0) {
      if (opts.json || opts.brief) {
        const ok = metas.filter((m) => m.state === "done").length;
        emit({ event: "all-done", runs: metas.length, ok, failed: metas.length - ok });
      }
      return { metas, timedOut: false };
    }
    if (Date.now() >= deadline) return { metas, timedOut: true };
    await sleep(opts.intervalMs);
  }
}

// src/core/notify.ts
var MARK = { done: "\u2714", failed: "\u2718", timeout: "\u23F1", stopped: "\u25A0" };
function noticeFor(meta) {
  const group = meta.group ? safeGroup(meta.group) : [];
  if (group.length > 1) {
    const count = (state) => group.filter((m) => m.state === state).length;
    const worse = group.length - count("done");
    const parts = [`${count("done")} done`, ...["failed", "timeout", "stopped"].filter(count).map((s) => `${count(s)} ${s}`)];
    const changed2 = group.reduce((n, m) => n + (m.changes?.length ?? 0), 0);
    return {
      title: `Pitroom ${worse ? "\u26A0" : "\u2714"} group ${meta.group}`,
      body: `${group.length} runs ended: ${parts.join(", ")}${changed2 ? ` \xB7 ${changed2} file${changed2 === 1 ? "" : "s"} changed` : ""}`
    };
  }
  const changed = meta.changes?.length ? ` \xB7 ${meta.changes.length} file${meta.changes.length === 1 ? "" : "s"} changed` : "";
  return { title: `Pitroom ${MARK[meta.state] ?? "\u2022"} ${kind(meta)} ${meta.state}`, body: `${what(meta)} \xB7 ${elapsed(meta)}${changed}` };
}
function safeGroup(name) {
  try {
    return groupIds(name).map((id) => readMeta(id));
  } catch {
    return [];
  }
}
function shouldNotify(meta) {
  const eff = effective();
  if (!eff.notify.value || !meta.background || meta.auditOf || !TERMINAL.includes(meta.state)) return false;
  const runs = meta.group ? safeGroup(meta.group) : [meta];
  if (!runs.length || !runs.every((m) => TERMINAL.includes(m.state))) return false;
  if (runs.every((m) => m.state === "done" || m.state === "stopped")) {
    const start = Math.min(...runs.map((m) => Date.parse(m.startedAt)));
    const end = Math.max(...runs.map((m) => Date.parse(m.endedAt ?? "")));
    if (Number.isFinite(end - start) && (end - start) / 1e3 < eff.notifyAfter.value) return false;
    if (runs.every((m) => m.state === "stopped")) return false;
  }
  return true;
}
function claimGroup(group) {
  try {
    const ids = groupIds(group).sort();
    if (ids.length < 2) return true;
    const dir = path18.join(home(), "notified");
    fs22.mkdirSync(dir, { recursive: true });
    for (const f of fs22.readdirSync(dir)) {
      if (Date.now() - fs22.statSync(path18.join(dir, f)).mtimeMs > 30 * 864e5) fs22.rmSync(path18.join(dir, f), { force: true });
    }
    fs22.writeFileSync(path18.join(dir, crypto5.createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function send(notice, meta) {
  const command = effective().notifyCommand.value;
  const env = { ...process.env, PITROOM_NOTIFY_TITLE: notice.title, PITROOM_NOTIFY_BODY: notice.body, PITROOM_NOTIFY_RUN: meta.id, PITROOM_NOTIFY_STATE: meta.state };
  try {
    let child;
    if (command) {
      child = spawn3(command, { shell: true, env, detached: true, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      child = spawn3("osascript", ["-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", notice.title, notice.body], { env, detached: true, stdio: "ignore" });
    } else if (process.platform === "linux") {
      const plain2 = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      child = spawn3("notify-send", ["--", plain2(notice.title), plain2(notice.body)], { env, detached: true, stdio: "ignore" });
    } else {
      return;
    }
    child.on("error", () => void 0);
    child.unref();
  } catch {
  }
}
function notifyEnded(meta) {
  try {
    if (shouldNotify(meta) && (!meta.group || claimGroup(meta.group))) send(noticeFor(meta), meta);
  } catch {
  }
}

// src/core/templates.ts
import fs24 from "node:fs";
import path20 from "node:path";

// src/core/install.ts
import fs23 from "node:fs";
import os9 from "node:os";
import path19 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var LEGACY = ["pitroom", "opencode-worker"];
function packageRoot() {
  return path19.resolve(path19.dirname(fileURLToPath2(import.meta.url)), "..");
}
function skillNames(root = packageRoot()) {
  const dir = path19.join(root, "skills");
  if (!fs23.existsSync(dir)) return [];
  return fs23.readdirSync(dir).filter((d) => fs23.existsSync(path19.join(dir, d, "SKILL.md"))).sort();
}
function skillTargets() {
  const home3 = os9.homedir();
  const targets = [path19.join(home3, ".agents", "skills")];
  if (fs23.existsSync(path19.join(home3, ".claude"))) targets.push(path19.join(home3, ".claude", "skills"));
  return targets;
}
var launcherPath = () => path19.join(os9.homedir(), ".local", "bin", process.platform === "win32" ? "pitroom.cmd" : "pitroom");
var LAUNCHER_MARK = "# pitroom launcher";
function launcherScript(bundle) {
  if (process.platform === "win32") {
    const q2 = (v) => v.replace(/%/g, "%%");
    return `@echo off\r
rem ${LAUNCHER_MARK} (created by \`pitroom install\`; \`pitroom uninstall\` removes it)\r
if defined PITROOM_NODE (\r
  "%PITROOM_NODE%" "${q2(bundle)}" %*\r
) else (\r
  "${q2(process.execPath)}" "${q2(bundle)}" %*\r
)\r
exit /b %ERRORLEVEL%\r
`;
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
${LAUNCHER_MARK} (created by \`pitroom install\`; \`pitroom uninstall\` removes it)
cli=${q(bundle)}
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
for n in "\${PITROOM_NODE:-}" ${q(process.execPath)} "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if ok "$n"; then exec "$n" "$cli" "$@"; fi
done
echo "pitroom: needs Node.js 22.13 or newer (set PITROOM_NODE to its path)" >&2
exit 127
`;
}
function isOurLauncher(file2, root) {
  if (linksInto(file2, root)) return true;
  try {
    const s = fs23.readFileSync(file2, "utf8");
    return s.includes(LAUNCHER_MARK) && s.includes(root);
  } catch {
    return false;
  }
}
function isPitroomLauncher(file2) {
  try {
    return fs23.readFileSync(file2, "utf8").includes(LAUNCHER_MARK);
  } catch {
    return false;
  }
}
function placeLauncher(bundle, root, force) {
  const dest = launcherPath();
  fs23.mkdirSync(path19.dirname(dest), { recursive: true });
  const exists = fs23.lstatSync(dest, { throwIfNoEntry: false });
  if (exists && !isOurLauncher(dest, root)) {
    if (!force) return `! ${dest} exists and is not Pitroom's launcher; kept (use --force to back it up and replace)`;
    fs23.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (exists) {
    fs23.rmSync(dest, { force: true });
  }
  fs23.writeFileSync(dest, launcherScript(bundle), { mode: 493 });
  return `\u2714 ${dest} \u2192 launcher for ${bundle} (Node 22.13+)`;
}
function linksInto(link, dir) {
  const st = fs23.lstatSync(link, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) return false;
  const target = path19.resolve(path19.dirname(link), fs23.readlinkSync(link));
  const rel = path19.relative(dir, target);
  return !rel.startsWith("..") && !path19.isAbsolute(rel);
}
function place(src, dest, opts) {
  fs23.mkdirSync(path19.dirname(dest), { recursive: true });
  const st = fs23.lstatSync(dest, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    if (!opts.force) return `! ${dest} exists and is not a link; kept (use --force to back it up and replace)`;
    fs23.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (st) {
    fs23.unlinkSync(dest);
  }
  if (opts.copy) fs23.cpSync(src, dest, { recursive: true });
  else fs23.symlinkSync(src, dest, process.platform === "win32" ? "junction" : fs23.statSync(src).isDirectory() ? "dir" : "file");
  return `\u2714 ${dest} \u2192 ${opts.copy ? "copied" : src}`;
}
function install(opts) {
  const root = packageRoot();
  const skills2 = opts.skills === false ? [] : skillNames(root);
  if (opts.skills !== false && !skills2.length) throw new Error(`no skills found under ${path19.join(root, "skills")}`);
  const out = [];
  for (const base2 of opts.skills === false ? [] : skillTargets()) {
    for (const legacy of LEGACY) {
      const l = path19.join(base2, legacy);
      if (!skills2.includes(legacy) && linksInto(l, root)) {
        fs23.unlinkSync(l);
        out.push(`\u2714 removed old link ${l}`);
      }
    }
    for (const name of skills2) out.push(place(path19.join(root, "skills", name), path19.join(base2, name), opts));
  }
  const bundle = path19.join(root, "dist", "pitroom.mjs");
  if (fs23.existsSync(bundle)) {
    out.push(placeLauncher(bundle, root, opts.force));
    const onPath = (process.env.PATH ?? "").split(path19.delimiter).some((d) => path19.resolve(d) === path19.dirname(launcherPath()));
    if (!onPath) out.push(`! ${path19.dirname(launcherPath())} is not on PATH; add it, or run ${launcherPath()} directly`);
  }
  return out;
}
function uninstall() {
  const root = packageRoot();
  const out = [];
  for (const base2 of skillTargets()) {
    if (!fs23.existsSync(base2)) continue;
    for (const name of fs23.readdirSync(base2)) {
      const l = path19.join(base2, name);
      if (linksInto(l, root)) {
        fs23.unlinkSync(l);
        out.push(`\u2714 removed ${l}`);
      }
    }
  }
  if (isOurLauncher(launcherPath(), root)) {
    fs23.rmSync(launcherPath(), { force: true });
    out.push(`\u2714 removed ${launcherPath()}`);
  }
  return out.length ? out : ["nothing to remove"];
}
function installedSkills() {
  const names = skillNames();
  return skillTargets().map((base2) => ({ base: base2, names: names.filter((n) => fs23.existsSync(path19.join(base2, n, "SKILL.md"))) }));
}

// src/core/templates.ts
var FILES = {
  implementer: "pitroom-driven-development/implementer-prompt.md",
  "task-reviewer": "pitroom-driven-development/task-reviewer-prompt.md",
  "re-review": "pitroom-driven-development/re-review-prompt.md",
  "code-reviewer": "pitroom-review/code-reviewer.md"
};
function loadTemplate(name, root = packageRoot()) {
  const file2 = path20.join(root, "skills", FILES[name]);
  if (!fs24.existsSync(file2)) throw new UserError(`template missing: ${file2} (broken install? run pitroom doctor)`, 3);
  return fs24.readFileSync(file2, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}
function fill(template, values) {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in values));
  if (missing.length) throw new UserError(`no value for template placeholder(s): ${[...new Set(missing)].join(", ")}`, 3);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key]);
}

// src/core/slots.ts
import crypto6 from "node:crypto";
import fs25 from "node:fs";
import path21 from "node:path";
var slotsDir = () => path21.join(home(), "slots");
var locksDir = () => path21.join(home(), "locks");
var STARTUP_GRACE_MS = 3e4;
function holderActive(runId, self) {
  if (!runId || runId === self) return false;
  try {
    const m = freshMeta(runId);
    if (!isActive(m.state)) return false;
    if (m.pid) return isAlive(m.pid);
    return Date.now() - Date.parse(m.startedAt) < STARTUP_GRACE_MS;
  } catch {
    return false;
  }
}
function tryClaim(file2, runId) {
  fs25.mkdirSync(path21.dirname(file2), { recursive: true });
  try {
    fs25.writeFileSync(file2, runId, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let owner = "";
  try {
    owner = fs25.readFileSync(file2, "utf8").trim();
  } catch {
  }
  if (owner === runId) return true;
  if (holderActive(owner, runId)) return false;
  fs25.rmSync(file2, { force: true });
  try {
    fs25.writeFileSync(file2, runId, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseIfOwner(file2, runId) {
  if (!file2) return;
  try {
    if (fs25.readFileSync(file2, "utf8").trim() === runId) fs25.rmSync(file2, { force: true });
  } catch {
  }
}
function tryAcquireSlot(runId, maxParallel) {
  for (let n = 0; n < Math.max(1, maxParallel); n++) {
    const file2 = path21.join(slotsDir(), `slot-${n}`);
    if (tryClaim(file2, runId)) return file2;
  }
  return void 0;
}
var releaseSlot = (file2, runId) => releaseIfOwner(file2, runId);
var lockFile = (repoRoot2) => path21.join(locksDir(), `write-${crypto6.createHash("sha1").update(path21.resolve(repoRoot2)).digest("hex").slice(0, 16)}`);
function acquireWriteLock(repoRoot2, runId) {
  const file2 = lockFile(repoRoot2);
  if (tryClaim(file2, runId)) return;
  let owner = "";
  try {
    owner = fs25.readFileSync(file2, "utf8").trim();
  } catch {
  }
  throw new UserError(`another --write run (${owner}) is active in this repo; use --isolate for parallel changes`, 3);
}
var releaseWriteLock = (repoRoot2, runId) => releaseIfOwner(lockFile(repoRoot2), runId);

// src/core/prompt.ts
var RULES = {
  read: ["READ-ONLY task: do not create, modify or delete any file. Read, search and analyse only."],
  write: [
    "You may edit files that the task requires. Make the smallest correct change; no drive-by refactors.",
    "Run the relevant tests, type checks or linters if they are cheap and available, and report the result."
  ],
  isolate: [
    "You are in an isolated copy of the project. Edit files as the task requires; the primary agent reviews your diff before anything reaches the real tree.",
    "Make the smallest correct change; no drive-by refactors. Dependency folders (node_modules, virtualenvs, build output) may be missing unless linked.",
    "Run the relevant tests, type checks or linters if they are cheap and available, and report the result."
  ]
};
function buildPrompt(mode, task, followUp) {
  if (followUp) return `Follow-up from the primary agent. Same rules and answer format as before.

${task}`;
  return `You are a worker agent. A primary coding agent delegated this bounded task to you. Your answer is draft work that the primary agent will verify, and it is the only thing the primary sees, so make it self-contained.

Rules:
- ${RULES[mode].join("\n- ")}
- Stay inside the task scope and the project directory.
- Never commit, push, reset, checkout, restore, stash, clean, rebase or merge, and never discard or overwrite uncommitted work you did not create.
- Never read or reveal secrets (.env files, keys, tokens).
- Delete a file only when the task explicitly asks for it, and name every file you delete under FILES CHANGED. Whether anything else should be deleted or overwritten is the primary agent's decision: propose it under OPEN ISSUES and leave the file alone.
- Do not ask questions. If something is ambiguous, choose the safest reasonable interpretation and state the assumption.
- Be economical: open only what you need.

End with this answer format (plain text, no preamble):
SUMMARY: 1-5 lines that directly answer the task.
DETAILS: key findings with file:line references; only what the primary agent needs.
FILES CHANGED: paths, or "none".
VERIFICATION: commands you ran and their results, or "not run".
OPEN ISSUES: risks, uncertainties, follow-ups, or "none".

Task:
${task}`;
}

// src/core/refs.ts
import fs26 from "node:fs";
import path22 from "node:path";
var FILE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rst py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs fs php lua r jl sh bash zsh fish ps1 bat yml yaml toml ini cfg conf env html htm css scss sass less vue svelte astro sql graphql gql proto lock xml svg csv tsv gradle tf hcl dart ex exs erl hs ml scala clj vim el mk cmake dockerfile gitignore gitattributes editorconfig npmrc nvmrc".split(" ")
);
var SKIP_DIRS2 = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache"]);
var MAX_INDEXED = 6e4;
var EXTENSIONLESS = "Makefile|Dockerfile|Containerfile|Gemfile|Rakefile|Procfile|Justfile|Vagrantfile|BUILD|WORKSPACE";
var REF = new RegExp(
  String.raw`(?<![\w/:.-])(\.{0,2}/?(?:[\w@.+-]+/)*(?:[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7}|${EXTENSIONLESS})):(\d+)(?:[-–](\d+))?`,
  "g"
);
var IDENT = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g;
var CLAUSE = /[;|—]|\.\s|:\s/g;
var MAX_BYTES = 5 * 1024 * 1024;
var WINDOW = 5;
var DEFINITION_LOOKBACK = 80;
function looksLikeSymbol(m) {
  const name = m[1];
  return m[0].includes("(") || /[A-Z_$0-9]/.test(name) || name.length >= 5;
}
function extractRefs(answer) {
  const seen = /* @__PURE__ */ new Map();
  for (const line of answer.split("\n")) {
    const matches2 = [...line.matchAll(REF)];
    const seps = [...line.matchAll(CLAUSE)].map((s) => s.index ?? 0);
    const sepBetween = (a, b) => seps.some((s) => s >= a && s < b);
    const idents = [...line.matchAll(IDENT)].filter((i) => {
      if (!looksLikeSymbol(i)) return false;
      const pos = i.index ?? 0;
      const before = matches2.filter((m) => (m.index ?? 0) + m[0].length <= pos).at(-1);
      const after = matches2.find((m) => (m.index ?? 0) >= pos + i[0].length);
      return !(before && after && !sepBetween((before.index ?? 0) + before[0].length, after.index ?? 0));
    });
    matches2.forEach((m, k) => {
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      if (start < 1 || end < start) return;
      const at = m.index ?? 0;
      const prev = matches2[k - 1];
      const next = matches2[k + 1];
      const from = Math.max(at - 80, prev ? (prev.index ?? 0) + prev[0].length : 0, ...seps.filter((s) => s < at).map((s) => s + 1));
      const to = Math.min(at + m[0].length + 40, next?.index ?? Infinity, ...seps.filter((s) => s >= at + m[0].length));
      const near = new Set(idents.filter((i) => (i.index ?? 0) >= from && (i.index ?? 0) < to).map((i) => i[1]));
      const symbol = near.size === 1 ? [...near][0] : void 0;
      const key = `${m[1]}:${start}-${end}:${symbol ?? ""}`;
      if (!seen.has(key)) seen.set(key, { text: m[0], file: m[1], start, end, symbol });
    });
  }
  return [...seen.values()];
}
function verifyRefs(refs, dirs) {
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path22.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file2) => {
    if (!lineCache.has(file2)) {
      const size = fs26.statSync(file2).size;
      const lines = size > MAX_BYTES ? null : fs26.readFileSync(file2, "utf8").split("\n");
      if (lines && lines[lines.length - 1] === "") lines.pop();
      lineCache.set(file2, lines);
    }
    return lineCache.get(file2);
  };
  let index;
  const byName = () => index ??= indexFiles(roots);
  const candidates = (ref) => {
    const direct = resolve(ref.file, roots);
    if (direct) return [direct];
    if (path22.isAbsolute(ref.file)) return [];
    const wanted = ref.file.replace(/^(\.{1,2}\/)+/, "");
    return (byName().get(path22.basename(wanted)) ?? []).filter((f) => f.split(path22.sep).join("/").endsWith(`/${wanted}`) || path22.basename(f) === wanted).slice(0, 20);
  };
  const check = (file2, ref) => {
    const lines = load(file2);
    if (!lines) return void 0;
    if (ref.end > lines.length) return `file has ${lines.length} lines`;
    if (ref.symbol && !mentions(lines, ref) && !enclosedBy(lines, ref)) return `\`${ref.symbol}\` not near line ${ref.start}`;
    return void 0;
  };
  let total = 0;
  for (const ref of refs) {
    const files = candidates(ref);
    if (!files.length) {
      if (!ref.file.includes("/") && !isFileName(ref.file)) continue;
      total++;
      invalid.push({ ref: ref.text, reason: path22.isAbsolute(ref.file) && !inside(ref.file, roots) ? "outside the project" : "file not found" });
      continue;
    }
    total++;
    const reasons = files.map((f) => check(f, ref));
    if (!reasons.some((r) => r === void 0)) invalid.push({ ref: ref.text, reason: files.length > 1 ? `${reasons[0]} (${files.length} files match)` : reasons[0] });
  }
  return { total, valid: total - invalid.length, invalid };
}
function mentions(lines, ref) {
  const near = lines.slice(Math.max(0, ref.start - 1 - WINDOW), ref.end + WINDOW).join("\n");
  return new RegExp(`(^|[^\\w$])${escape(ref.symbol)}([^\\w$]|$)`).test(near);
}
function enclosedBy(lines, ref) {
  const name = escape(ref.symbol);
  const def = new RegExp(
    `\\b(function|def|fn|func|class|interface|struct|impl|type|const|let|var)\\s+\\*?${name}\\b|^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(static\\s+)?${name}\\s*[(:=]`
  );
  return lines.slice(Math.max(0, ref.start - 1 - DEFINITION_LOOKBACK), ref.start).some((l) => def.test(l));
}
var isFileName = (name) => {
  const base2 = path22.basename(name);
  return !base2.includes(".") || new RegExp(`^(${EXTENSIONLESS})$`).test(base2) || FILE_EXTENSIONS.has(base2.split(".").pop().toLowerCase());
};
function indexFiles(roots) {
  const index = /* @__PURE__ */ new Map();
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs26.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_INDEXED) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS2.has(e.name)) walk(path22.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
        const list2 = index.get(e.name);
        if (list2) list2.push(path22.join(dir, e.name));
        else index.set(e.name, [path22.join(dir, e.name)]);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}
function resolve(ref, roots) {
  const candidates = path22.isAbsolute(ref) ? inside(ref, roots) ? [ref] : [] : roots.map((r) => path22.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs26.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}
function inside(file2, roots) {
  return roots.some((r) => {
    const rel = path22.relative(r, path22.resolve(file2));
    return rel !== "" && !rel.startsWith("..") && !path22.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// src/core/run.ts
var VERSION2 = true ? "0.21.0" : "0.0.0-dev";
function planWork(o) {
  if (!o.plan) return { task: o.task.trim(), tier: o.tier };
  if (o.continueFrom) throw new UserError("a follow-up continues its parent's task; drop --plan/--step");
  if (o.mode === "read") throw new UserError("--plan runs implement a task: add -i (an isolated copy, recommended) or -w");
  const plan = loadPlan(o.plan.file);
  const t = planTask(plan, o.plan.step);
  const text = brief(plan, t);
  const task = fill(loadTemplate("implementer"), {
    PLAN_FILE: plan.file,
    STEP: String(t.step),
    TITLE: t.title,
    BRIEF: text.trim(),
    NOTES: o.task.trim() || "(none)"
  });
  const tier = o.tier ?? (o.worker ? void 0 : t.tier);
  return { task, tier, plan: { file: plan.file, step: t.step, title: t.title }, brief: text };
}
function prepareRun(o) {
  if (process.env.PITROOM_ACTIVE === "1") {
    throw new UserError("refusing to delegate from inside a Pitroom worker (no recursive delegation)", 3);
  }
  const work = planWork(o);
  if (!work.task) throw new UserError("empty task");
  const warnings = [];
  let parent;
  let worker;
  let fallback;
  if (o.continueFrom) {
    parent = readMeta(o.continueFrom);
    if (o.worker || o.tier || o.effort) throw new UserError("a follow-up runs on the same worker as its parent; drop --worker/--tier/--effort");
    if (!parent.sessionId) throw new UserError(`run ${parent.id} has no worker session to continue`, 3);
    if (parent.mode === "isolate" && (!parent.worktree || !fs27.existsSync(parent.worktree))) {
      throw new UserError(`the isolated copy of run ${parent.id} is gone (applied or discarded)`, 3);
    }
    const ran = parent.ran ?? parent.worker;
    worker = o.model ? { ...ran, model: o.model } : ran;
    fallback = o.noFallback ? [] : parent.fallback.filter((t) => t.backend === ran.backend);
  } else {
    const chain = resolveChain({ worker: o.worker, model: o.model, tier: work.tier, effort: o.effort, noFallback: o.noFallback });
    ({ worker, fallback } = chain);
    warnings.push(...chain.warnings);
  }
  const backend = getBackend(worker.backend);
  if (parent && backend.capabilities.resume === "none") {
    throw new UserError(`the ${backend.name} worker cannot continue sessions`, 3);
  }
  if (o.files.length && !backend.capabilities.attachFiles) {
    throw new UserError(`the ${backend.name} worker cannot attach files; put the content in the task`);
  }
  const mode = parent?.mode ?? o.mode;
  const dir = canonical(path23.resolve(parent?.dir ?? o.dir));
  if (!fs27.existsSync(dir) || !fs27.statSync(dir).isDirectory()) throw new UserError(`not a directory: ${dir}`);
  const root = repoRoot(dir);
  if (mode === "isolate" && !root) throw new UserError("--isolate needs a git repository", 3);
  if (mode === "write" && !root && !o.allowNonGit) {
    throw new UserError("--write outside a git repo cannot be tracked or reverted; pass --allow-non-git to accept that", 3);
  }
  const files = o.files.map((f) => path23.resolve(f));
  for (const f of files) if (!fs27.existsSync(f)) throw new UserError(`file not found: ${f}`);
  const readIn2 = READ_IN.includes(effective().readIn.value) ? effective().readIn.value : "auto";
  const snap = mode === "read" && !o.review && !o.inPlace && !parent ? wantSnapshot(readIn2, root, dir) : void 0;
  if (parent?.snapshot?.dir && !fs27.existsSync(parent.snapshot.dir)) {
    throw new UserError(`the read snapshot of run ${parent.id} is gone (cleaned up); ask the question again as a new run`, 3);
  }
  if (!parent && !snap && !process.env.PITROOM_NO_SECRET_WARNING) {
    const secrets = mode === "isolate" && root ? findSecretFilesInTree(root, dir) : findSecretFiles(dir);
    const note = secretWarning(secrets, mode);
    if (note) warnings.push(note);
  }
  const meta = {
    id: newRunId(),
    version: VERSION2,
    mode,
    task: work.task,
    dir,
    cwd: parent?.cwd ?? dir,
    repoRoot: root,
    worker,
    fallback,
    parent: parent?.id,
    group: o.group ?? parent?.group ?? (work.plan ? planName(work.plan.file) : void 0),
    sessionId: parent?.sessionId,
    files,
    link: parent?.link ?? o.link,
    timeoutSec: o.timeoutSec,
    verify: o.verify,
    web: o.web || !!parent?.web,
    state: "queued",
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    warnings,
    // Follow-ups in an isolated copy accumulate into one patch against the original snapshot.
    baseTree: parent?.mode === "isolate" ? parent.baseTree : void 0,
    worktree: parent?.mode === "isolate" ? parent.worktree : void 0,
    reviewOf: o.review?.of,
    auditOf: o.audit?.of,
    auditRate: o.auditRate,
    inPlace: o.inPlace || void 0,
    cache: o.cache,
    snapshot: parent?.snapshot ?? (snap ? { dir: "", tree: "", left: snap.secrets } : void 0),
    plan: work.plan ?? o.review?.plan ?? parent?.plan,
    reviewKind: o.review?.kind,
    packageFile: o.review?.packageFile
  };
  writeMeta(meta);
  if (mode === "write" && root) {
    try {
      acquireWriteLock(root, meta.id);
    } catch (e) {
      fs27.rmSync(runDir(meta.id), { recursive: true, force: true });
      throw e;
    }
  }
  fs27.writeFileSync(runFile(meta.id, "task.md"), `${meta.task}
`);
  if (work.brief) fs27.writeFileSync(runFile(meta.id, "brief.md"), work.brief);
  return meta;
}
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForSlot(meta) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const max = effective().maxParallel.value;
    for (; ; ) {
      const slot = tryAcquireSlot(meta.id, max);
      if (slot) return slot;
      if (stopped) return void 0;
      await sleep2(1e3);
      if (stopped) return void 0;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
function startInBackground(meta) {
  const script = process.argv[1];
  if (!script) throw new Error("cannot locate the pitroom executable");
  meta.background = true;
  writeMeta(meta);
  const child = spawn4(process.execPath, [script, "__exec", meta.id], {
    detached: true,
    stdio: "ignore",
    cwd: meta.dir,
    env: process.env
  });
  child.unref();
  meta.pid = child.pid;
  writeMeta(meta);
  return meta;
}
async function execute(meta) {
  meta.pid = process.pid;
  meta.state = "queued";
  writeMeta(meta);
  let result = { code: null, timedOut: false, stopped: false };
  const slot = await waitForSlot(meta);
  if (!slot) return finalize(meta, { code: null, timedOut: false, stopped: true });
  meta.state = "running";
  meta.startedAt = (/* @__PURE__ */ new Date()).toISOString();
  writeMeta(meta);
  try {
    prepareTree(meta);
    writeMeta(meta);
    const chain = [];
    for (const t of [meta.worker, ...meta.fallback]) if (!chain.some((c) => sameTarget(c, t))) chain.push(t);
    for (let i = 0; i < chain.length; i++) {
      const target = chain[i];
      const backend = getBackend(target.backend);
      const cooling = activeCooldown(cooldownKey(target, backend));
      if (cooling && chain.slice(i + 1).some((t) => !activeCooldown(cooldownKey(t, getBackend(t.backend))))) {
        (meta.attempts ??= []).push({ target: describeTarget(target), error: `cooling down ${untilText(cooling)}: ${cooling.reason}`, skipped: true });
        writeMeta(meta);
        continue;
      }
      meta.ran = target;
      writeMeta(meta);
      result = await attempt(meta, backend, target);
      if (result.timedOut || result.stopped || result.spawnError) break;
      const why = retryableFailure(meta, backend, result);
      if (!why) break;
      if (why.kind === "rate-limited") recordCooldown(cooldownKey(target, backend), describeTarget(target), why.message);
      if (!target.model && backend.defaultModel) {
        const failed = backend.defaultModel();
        for (let j = chain.length - 1; j > i; j--) {
          if (chain[j].backend === target.backend && chain[j].model === failed) chain.splice(j, 1);
        }
      }
      if (i === chain.length - 1) break;
      (meta.attempts ??= []).push({ target: describeTarget(target), error: why.message });
      for (const f of ["events.jsonl", "stderr.log"]) {
        const from = runFile(meta.id, f);
        if (fs27.existsSync(from)) fs27.renameSync(from, runFile(meta.id, f.replace(".", `.attempt-${i + 1}.`)));
      }
      writeMeta(meta);
    }
    if (result.spawnError) {
      const b = getBackend((meta.ran ?? meta.worker).backend);
      meta.error = `${result.spawnError} (install ${b.name} or set PITROOM_${b.id.toUpperCase()}_BIN)`;
    }
  } catch (e) {
    meta.error ??= e.message;
  } finally {
    releaseSlot(slot, meta.id);
  }
  const done = finalize(meta, result);
  autoAudit(done);
  return done;
}
function autoAudit(meta) {
  try {
    if (!auditable(meta, read2(runFile(meta.id, "summary.md"))) || !sampled(meta)) return;
    startAudit(meta);
  } catch {
  }
}
function startAudit(meta, worker) {
  const answer = read2(runFile(meta.id, "summary.md"));
  const auditor = worker ?? pickAuditor(meta);
  if (!auditor) return void 0;
  const a = prepareRun({
    mode: "read",
    task: auditTask(meta, answer),
    dir: meta.dir,
    files: [],
    link: [],
    worker: auditor,
    timeoutSec: Math.min(meta.timeoutSec, 15 * 60),
    allowNonGit: true,
    web: false,
    // never fall back to the worker being audited
    noFallback: true,
    group: meta.group,
    audit: { of: meta.id }
  });
  meta.audit = { id: a.id, state: "running" };
  writeMeta(meta);
  startInBackground(a);
  return a;
}
function settleAudit(a) {
  try {
    const target = readMeta(a.auditOf);
    target.audit = { id: a.id, state: a.state, verdict: a.state === "done" ? a.auditVerdict : void 0, disputed: a.state === "done" ? a.auditDisputed : void 0 };
    writeMeta(target);
  } catch {
  }
}
function prepareTree(meta) {
  const root = meta.repoRoot;
  if (root && meta.mode === "read" && meta.snapshot && !meta.snapshot.dir) {
    const shown = meta.snapshot.left.slice(0, 3).join(", ") + (meta.snapshot.left.length > 3 ? `, +${meta.snapshot.left.length - 3} more` : "");
    try {
      const s = readSnapshot(root);
      meta.snapshot.dir = s.dir;
      meta.snapshot.tree = s.tree;
      meta.cwd = path23.join(s.dir, path23.relative(root, meta.dir));
      if (!fs27.existsSync(meta.cwd)) meta.cwd = s.dir;
      if (shown) meta.warnings.push(`read in a clean snapshot of your project: the secret-looking files (${shown}) and git-ignored files are not in it; --in-place reads the directory itself`);
    } catch (e) {
      meta.snapshot = void 0;
      meta.warnings.push(`could not make a clean snapshot (${e.message.slice(0, 120)}): the worker reads the directory itself${shown ? `, where secret-looking files sit (${shown})` : ""}`);
    }
  }
  if (root && meta.mode === "write") meta.baseTree = snapshotTree(root);
  if (root && meta.mode === "isolate" && !meta.worktree) {
    meta.baseTree = snapshotTree(root);
    meta.worktree = path23.join(worktreesDir(), meta.id);
    createIsolatedCopy(root, meta.baseTree, meta.worktree);
    meta.cwd = path23.join(meta.worktree, path23.relative(root, meta.dir));
    const linked = linkIntoWorktree(root, meta.worktree, meta.link);
    if (linked.length) meta.warnings.push(`linked into the isolated copy (shared with your tree): ${linked.join(", ")}`);
  }
}
function attempt(meta, backend, target) {
  const inv = backend.invocation({
    mode: meta.mode,
    prompt: buildPrompt(meta.mode, meta.task, !!meta.parent),
    cwd: meta.cwd,
    model: target.model,
    sessionId: meta.sessionId,
    files: meta.files,
    web: !!meta.web,
    title: `pitroom ${meta.mode}: ${meta.task.replace(/\s+/g, " ").slice(0, 60)}`
  });
  return spawnWorker(inv, {
    cwd: meta.cwd,
    stdoutFile: runFile(meta.id, "events.jsonl"),
    stderrFile: runFile(meta.id, "stderr.log"),
    timeoutSec: meta.timeoutSec
  });
}
var read2 = (f) => fs27.existsSync(f) ? fs27.readFileSync(f, "utf8") : "";
function retryableFailure(meta, backend, res) {
  const run2 = backend.parse(read2(runFile(meta.id, "events.jsonl")));
  if (run2.usage.steps > 0) return void 0;
  const f = backend.failure(run2, read2(runFile(meta.id, "stderr.log")), res.code);
  return f && f.kind !== "other" ? f : void 0;
}
var HINTS = {
  "model-unavailable": "the model is not available; fix the worker config, pass --worker/--model, or configure fallback workers (see `pitroom doctor`)",
  "rate-limited": "the model is rate-limited or overloaded; configure fallback workers to fail over automatically",
  auth: "authentication or billing problem with the worker's provider",
  other: ""
};
function finalize(meta, res) {
  const ran = meta.ran ?? meta.worker;
  const backend = getBackend(ran.backend);
  const run2 = backend.parse(read2(runFile(meta.id, "events.jsonl")));
  if (meta.snapshot?.dir && meta.repoRoot) run2.finalText = backToProject(run2.finalText, meta.snapshot.dir, meta.repoRoot);
  meta.sessionId = run2.sessionId ?? meta.sessionId;
  meta.usage = run2.usage;
  fs27.writeFileSync(runFile(meta.id, "summary.md"), `${run2.finalText}
`);
  if (meta.plan && !meta.reviewOf) meta.taskStatus = parseStatus(run2.finalText);
  if (meta.reviewOf) {
    meta.verdict = parseVerdict(run2.finalText);
    if (meta.packageFile) fs27.rmSync(meta.packageFile, { force: true });
  }
  if (!res.timedOut && !res.stopped && !meta.error) {
    const f = backend.failure(run2, read2(runFile(meta.id, "stderr.log")), res.code);
    if (f) {
      meta.error = HINTS[f.kind] ? `${f.message} (${HINTS[f.kind]})` : f.message;
      meta.failureKind = f.kind;
    }
  }
  try {
    captureChanges(meta);
  } catch (e) {
    meta.warnings.push(`could not compute changes: ${e.message}`);
  }
  if (meta.mode === "read" && run2.edits.length) {
    meta.warnings.push(`READ-ONLY VIOLATION: worker modified ${[...new Set(run2.edits)].join(", ")}`);
  }
  if (meta.sessionId && backend.resolveModel) meta.resolvedModel = backend.resolveModel(meta.sessionId);
  meta.resolvedModel ??= run2.model ?? ran.model;
  const refs = extractRefs(run2.finalText);
  if (refs.length) {
    meta.refs = verifyRefs(refs, [meta.cwd, meta.repoRoot ?? "", meta.dir]);
    if (meta.refs.invalid.length) {
      meta.warnings.push(`${meta.refs.invalid.length} of ${meta.refs.total} file references in the answer did not check out`);
    }
  }
  meta.state = res.timedOut ? "timeout" : res.stopped ? "stopped" : meta.error ? "failed" : "done";
  if (meta.auditOf && meta.state === "done") {
    const found = parseAudit(run2.finalText);
    meta.auditVerdict = found.verdict;
    meta.auditDisputed = found.disputed;
  }
  if (meta.state === "done" && !run2.finalText) meta.warnings.push("worker finished without a written answer");
  if (meta.state === "done" && meta.verify) meta.verifyResult = runVerify(meta);
  meta.endedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (meta.usage && meta.usage.cost === void 0) {
    const price = workerPrice(ran.backend, meta.resolvedModel ?? run2.model, ran.model);
    if (price) {
      meta.usage.costEstimate = costAt(meta.usage, price);
      meta.usage.costSource = price.source ?? "config";
    }
  }
  meta.returnedTokens = estimateTokens(formatReport(meta, run2.finalText));
  meta.savedUsd = meta.auditOf ? 0 : savedUsd(meta.usage, meta.returnedTokens);
  writeMeta(meta);
  if (meta.mode === "write" && meta.repoRoot) releaseWriteLock(meta.repoRoot, meta.id);
  record(meta);
  if (meta.auditOf) settleAudit(meta);
  notifyEnded(meta);
  refreshInBackground();
  return meta;
}
function captureChanges(meta) {
  const root = meta.repoRoot;
  if (!root || !meta.baseTree || meta.mode === "read") return;
  const target = meta.mode === "isolate" ? meta.worktree : root;
  meta.afterTree = snapshotTree(target, meta.mode === "isolate" ? meta.link : []);
  const d = diffTrees(target, meta.baseTree, meta.afterTree);
  meta.changes = d.changes;
  meta.stats = d.stats;
  fs27.writeFileSync(runFile(meta.id, "changes.patch"), d.patch);
}
function verifyPath() {
  const extra = [path23.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = (process.env.PATH ?? "").split(path23.delimiter).filter(Boolean);
  for (const d of process.platform === "win32" ? [path23.dirname(process.execPath)] : extra) if (!parts.includes(d)) parts.push(d);
  return parts.join(path23.delimiter);
}
function runVerify(meta) {
  const r = spawnSync6(meta.verify, {
    cwd: meta.cwd,
    shell: true,
    encoding: "utf8",
    timeout: 15 * 6e4,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: verifyPath(), PWD: meta.cwd, PITROOM_ACTIVE: "1" }
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  fs27.writeFileSync(runFile(meta.id, "verify.log"), output);
  const notFound = process.platform === "win32" && r.status === 1 && /is not recognized as an internal or external command/.test(output);
  return { ok: r.status === 0, code: notFound ? 127 : r.status, tail: output.trimEnd().split("\n").slice(-25).join("\n") };
}
function applyRun(meta, allowDelete = false) {
  if (meta.mode !== "isolate") throw new UserError(`run ${meta.id} edited your tree directly (${meta.mode}); nothing to apply`);
  if (meta.applied) throw new UserError(`run ${meta.id} was already applied`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
  const deleted = meta.changes.filter((c) => c.status === "D").map((c) => c.path);
  if (deleted.length && !allowDelete) {
    const list2 = deleted.slice(0, 10).map((f) => `  ${f}`).join("\n") + (deleted.length > 10 ? `
  \u2026 ${deleted.length - 10} more` : "");
    throw new DeletionRefused(
      `run ${meta.id} deletes ${deleted.length} file${deleted.length === 1 ? "" : "s"}; nothing was applied:
${list2}
Check that the deletion is what the user asked for: if so apply with --allow-delete, otherwise ask the user or discard the run.`,
      deleted
    );
  }
  const res = applyPatch(meta.repoRoot, runFile(meta.id, "changes.patch"), false);
  if (!res.ok) throw new UserError(`patch does not apply cleanly (your tree changed since the snapshot):
${res.message}`, 1);
  meta.applied = true;
  cleanupWorktree(meta);
  writeMeta(meta);
  return `applied ${meta.changes.length} file(s) from ${meta.id} to ${meta.repoRoot}`;
}
function revertRun(meta) {
  if (meta.mode !== "write") throw new UserError(`only --write runs can be reverted (this is ${meta.mode})`);
  if (meta.reverted) throw new UserError(`run ${meta.id} was already reverted`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
  const res = applyPatch(meta.repoRoot, runFile(meta.id, "changes.patch"), true);
  if (!res.ok) throw new UserError(`cannot revert cleanly (files changed after the run):
${res.message}`, 1);
  meta.reverted = true;
  writeMeta(meta);
  return `reverted ${meta.changes.length} file(s) changed by ${meta.id}`;
}
function stopRun(id) {
  const meta = freshMeta(id);
  if (!isActive(meta.state) || !isAlive(meta.pid)) return void 0;
  requestStop(meta.id);
  meta.stopRequested = true;
  writeMeta(meta);
  process.kill(meta.pid, "SIGTERM");
  return meta;
}
function discardRun(meta) {
  if (meta.mode !== "isolate") throw new UserError("only --isolate runs have an isolated copy to discard");
  cleanupWorktree(meta);
  meta.discarded = true;
  writeMeta(meta);
  return `discarded the isolated copy of ${meta.id}; the patch stays in ${runFile(meta.id, "changes.patch")}`;
}
function cleanupWorktree(meta) {
  if (meta.worktree && fs27.existsSync(meta.worktree)) removeIsolatedCopy(meta.worktree, worktreesDir());
}

// src/cli/mcp-extras.ts
import fs28 from "node:fs";
import path24 from "node:path";

// src/cli/mcp-support.ts
import { spawn as spawn5 } from "node:child_process";
var MAX_OUTPUT = 12e4;
var DEFAULT_WAIT = 50;
var MAX_WAIT = 540;
var MAX_TASKS = 20;
var PROGRESS_EVERY_MS = 5e3;
var ToolError = class extends Error {
};
var str = (a, key, required = false) => {
  const v = a[key];
  if (v === void 0 || v === null || v === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return void 0;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
};
var strs = (a, key) => {
  const v = a[key];
  if (v === void 0 || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ToolError(`"${key}" must be a list of strings`);
  return v;
};
var bool = (a, key) => {
  const v = a[key];
  if (v === void 0 || v === null) return false;
  if (typeof v !== "boolean") throw new ToolError(`"${key}" must be true or false`);
  return v;
};
var waitSeconds = (a) => {
  const v = a.waitSeconds;
  if (v === void 0 || v === null) return DEFAULT_WAIT;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) throw new ToolError('"waitSeconds" must be a number of seconds, 1 or more');
  return Math.min(Math.round(v), MAX_WAIT);
};
var oneOf = (a, key, allowed, fallback) => {
  const v = str(a, key);
  if (v === void 0) return fallback;
  if (!allowed.includes(v)) throw new ToolError(`"${key}" must be one of: ${allowed.join(", ")}`);
  return v;
};
var since = (a) => {
  const v = str(a, "since");
  if (v === void 0) return [];
  if (v !== "all" && !/^\d+d$/.test(v)) throw new ToolError('"since" takes 7d, 30d, \u2026 or all');
  return ["--since", v];
};
function workerFlags(a, only) {
  const out = [];
  const on = (key) => !only || only.includes(key);
  const pairs = [["worker", "-W"], ["model", "-m"], ["tier", "--tier"], ["effort", "--effort"], ["dir", "-d"], ["verify", "--verify"], ["group", "-g"]];
  for (const [key, flag2] of pairs) {
    const v = on(key) ? str(a, key) : void 0;
    if (v !== void 0) out.push(flag2, v);
  }
  if (on("files")) for (const f of strs(a, "files")) out.push("-f", f);
  const link = on("link") ? strs(a, "link") : [];
  if (link.length) out.push("--link", link.join(","));
  if (on("web") && bool(a, "web")) out.push("--web");
  return out;
}
var strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
var clip6 = (s) => s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}
\u2026 (${s.length - MAX_OUTPUT} more characters)` : s;
function pit(args, timeoutMs = 60 * 6e4, signal) {
  return new Promise((resolve2) => {
    const script = process.argv[1];
    if (!script) return resolve2({ code: 1, out: "", err: "cannot locate the pitroom executable" });
    const child = spawn5(process.execPath, [script, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    const stop = () => child.kill("SIGTERM");
    const timer2 = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", (e) => resolve2({ code: 1, out, err: err || String(e.message) }));
    child.on("close", (code) => {
      clearTimeout(timer2);
      signal?.removeEventListener("abort", stop);
      resolve2({ code, out: strip(out).trim(), err: strip(err).trim() });
    });
  });
}
function asResult(r, still) {
  const text = [r.out, r.err && r.code !== 0 ? r.err : ""].filter(Boolean).join("\n\n") || "(no output)";
  if (r.code === 75 && still) return { text: clip6(`${text}

${still}`) };
  return { text: clip6(text), isError: r.code === 2 || r.code === 3 || r.code === 5 || r.code === 6 || r.code === 1 && !r.out };
}
var plain = async (args, ctx, timeoutMs = 6e4) => asResult(await pit(args, timeoutMs, ctx.signal));
function trackProgress(ctx, ids) {
  const tick2 = () => {
    try {
      const lines = ids().map((id) => freshMeta(id)).filter((m) => isActive(m.state)).map((m) => progress(m).replace(/^pitroom\s+/, ""));
      if (lines.length) ctx.progress(lines.slice(0, 3).join("\n") + (lines.length > 3 ? `
\u2026 and ${lines.length - 3} more` : ""));
    } catch {
    }
  };
  const first = setTimeout(tick2, 800);
  const timer2 = setInterval(tick2, PROGRESS_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer2);
  };
}
async function waitFor(ids, seconds, ctx, group) {
  const args = group ? ["wait", "-g", group, "--timeout", String(seconds)] : ["wait", ...ids, "--timeout", String(seconds)];
  const done = trackProgress(ctx, () => group ? groupIds(group) : ids);
  let r;
  try {
    r = await pit(args, (seconds + 60) * 1e3, ctx.signal);
  } finally {
    done();
  }
  const again = group ? `{"group": "${group}"}` : `{"runs": ${JSON.stringify(ids)}}`;
  return asResult(r, `Not finished yet: call pitroom_wait with ${again} (waitSeconds up to ${MAX_WAIT}); pitroom_stop ends it.`);
}
var cancelled = (ctx) => ctx.signal.aborted && ctx.signal.reason === "cancelled";
async function stopQuietly(args) {
  const r = await pit(args, 3e4);
  if (r.code !== 0) process.stderr.write(`pitroom mcp: ${args.join(" ")} failed: ${r.err || r.out}
`);
}
var dashAsked;
function ensureDash() {
  if (effective().mcpDash.value === false) return Promise.resolve(void 0);
  if (dashAsked && Date.now() - dashAsked.at < 6e4) return dashAsked.url;
  const url = pit(["dash", "--detach"], 3e4).then((r) => {
    const found = /^https?:\/\/127\.0\.0\.1:\d+\/?/m.exec(r.out)?.[0];
    if (!found) dashAsked = void 0;
    return found;
  });
  dashAsked = { at: Date.now(), url };
  return url;
}
function dashIfSlow(ids, delayMs = 3e3) {
  return new Promise((resolve2) => {
    const timer2 = setTimeout(() => {
      try {
        resolve2(ids().some((id) => isActive(freshMeta(id).state)) ? ensureDash() : void 0);
      } catch {
        resolve2(void 0);
      }
    }, delayMs);
    timer2.unref();
  });
}
function withLiveView(result, url) {
  if (!url || !result.text.includes("Not finished yet")) return result;
  return {
    ...result,
    text: `${result.text}

Live view of every run: ${url} (pitroom dash). If your app has a built-in browser pane (the Claude Code and Codex apps do), open it there; otherwise give the user the address.`
  };
}
async function startAndWait(start, seconds, ctx, task) {
  const started = await pit([...start, "--bg", "--json", ...task === void 0 ? [] : ["--", task]]);
  if (started.code !== 0) return asResult(started);
  let id;
  let cached4 = false;
  try {
    ({ id, cached: cached4 = false } = JSON.parse(started.out));
  } catch {
    return { text: `could not read the run id from: ${started.out.slice(0, 200)}`, isError: true };
  }
  const dash = cached4 ? Promise.resolve(void 0) : dashIfSlow(() => [id]);
  const waited = await waitFor([id], seconds, ctx);
  const result = withLiveView(waited, waited.text.includes("Not finished yet") ? await dash : void 0);
  if (cancelled(ctx) && !cached4) await stopQuietly(["stop", id]);
  if (cached4) result.text = `Cached answer: the same question on the same code as run ${id}; no worker ran (fresh: true asks one).

${result.text}`;
  return result;
}
async function startCrew(flags, tasks, seconds, ctx) {
  const started = await pit(["crew", ...flags, "--json", "--", ...tasks]);
  if (started.code !== 0) return asResult(started);
  let group;
  try {
    group = JSON.parse(started.out).group;
  } catch {
    return { text: `could not read the group from: ${started.out.slice(0, 200)}`, isError: true };
  }
  const dash = dashIfSlow(() => groupIds(group));
  const waited = await waitFor([], seconds, ctx, group);
  const result = withLiveView(waited, waited.text.includes("Not finished yet") ? await dash : void 0);
  if (cancelled(ctx)) await stopQuietly(["stop", "-g", group]);
  return result;
}

// src/cli/mcp-extras.ts
var RpcError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var RUN = /^pitroom:\/\/run\/(\d{8}-\d{6}-[0-9a-f]{4})(\/patch)?$/;
var LISTED = 30;
var runOfUri = (uri) => RUN.exec(uri)?.[1];
var oneLine6 = (text, n) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}\u2026` : flat;
};
function listResources() {
  const resources = [];
  for (const id of listRunIds().slice(-LISTED).reverse()) {
    try {
      const m = freshMeta(id);
      const what2 = `${m.state} \xB7 ${m.mode} \xB7 ${m.worker.backend}${m.worker.model ? `:${m.worker.model.split("/").pop()}` : ""}`;
      resources.push({ uri: `pitroom://run/${id}`, name: `run ${id}`, title: oneLine6(m.task, 70), description: `${what2}: the report`, mimeType: "text/plain" });
      if (m.changes?.length) resources.push({ uri: `pitroom://run/${id}/patch`, name: `patch ${id}`, title: `Patch of ${oneLine6(m.task, 60)}`, description: `${what2}: the exact diff, ${m.changes.length} file(s)`, mimeType: "text/x-diff" });
    } catch {
    }
  }
  return { resources };
}
var resourceTemplates = () => ({
  resourceTemplates: [
    { uriTemplate: "pitroom://run/{id}", name: "run-report", title: "A run's report", description: "The report of a run: answer, receipt, verified references.", mimeType: "text/plain" },
    { uriTemplate: "pitroom://run/{id}/patch", name: "run-patch", title: "A run's patch", description: "The exact diff an isolated or in-place run made.", mimeType: "text/x-diff" }
  ]
});
async function readResource(uri, ctx) {
  const m = RUN.exec(uri);
  if (!m) throw new RpcError(-32002, `unknown resource: ${uri}`);
  const patch = m[2] !== void 0;
  const r = await pit(["show", m[1], patch ? "--patch" : "--full"], 6e4, ctx.signal);
  if (r.code !== 0) throw new RpcError(r.code === 3 || r.code === 2 ? -32002 : -32603, r.err || r.out || `run ${m[1]} cannot be read`);
  return { contents: [{ uri, mimeType: patch ? "text/x-diff" : "text/plain", text: clip6(r.out) }] };
}
var PROMPTS = [
  {
    name: "research",
    title: "Research with a worker",
    description: "Find, map or explain code through a read-only worker, and verify what comes back.",
    arguments: [{ name: "question", description: "What to find out about the project.", required: true }],
    text: (a) => `Use the pitroom_run tool (mode "read") to find out: ${a.question}

Give the worker the full question and any file it should start from. When it answers, check one or two of the cited file:line references yourself before relying on the answer, and say plainly what is verified and what is not. If it comes back "still running", call pitroom_wait with the run id.`
  },
  {
    name: "implement",
    title: "Get a change made",
    description: "A worker makes a change in an isolated copy; you review the exact diff and apply it only when it is right.",
    arguments: [{ name: "task", description: "The change to make, with the context a worker needs.", required: true }],
    text: (a) => `Get this change made by a worker: ${a.task}

Call pitroom_run with mode "isolate" (add "verify" with the project's test command if there is one). Read the diff with pitroom_show (patch: true), then have it judged with pitroom_review. If the diff does what was asked and the review has no critical findings, call pitroom_apply; otherwise pitroom_run with "continue" to ask for the fix, or pitroom_discard. Do not apply a change you have not read.`
  },
  {
    name: "review",
    title: "Review changes with another model",
    description: "A read-only reviewer from another model judges a commit range or the latest change.",
    arguments: [{ name: "range", description: "A commit range such as main..HEAD. Default: the latest run's change." }],
    text: (a) => (a.range ? `Have the commits ${a.range} reviewed: call pitroom_review with range "${a.range}".` : 'Have the latest change reviewed: call pitroom_review with run "last".') + "\n\nWeigh each finding against the code before acting on it: a reviewer can be wrong. Fix what is real, and say which findings you dropped and why."
  },
  {
    name: "crew",
    title: "Split work across workers",
    description: "Independent tasks run in parallel as one group of workers.",
    arguments: [{ name: "tasks", description: "The tasks, one per line.", required: true }],
    text: (a) => `Run these independent tasks in parallel: call pitroom_run with "tasks" (one worker each):

${a.tasks}

Make each task self-contained. Use mode "isolate" if they change files, then read every patch (pitroom_show, patch: true) and apply them with pitroom_apply (group). Only split work that does not depend on each other.`
  }
];
var TOOL_MAP = 'Through this MCP server the `pitroom` commands below are tools: `pitroom run` is pitroom_run (`-i` is mode "isolate", `-w` mode "write", `--continue` is continue, `--verify` is verify), `pitroom crew` is pitroom_run with tasks, `pitroom wait` pitroom_wait, `pitroom show`/`status` pitroom_show, `pitroom review` pitroom_review, `pitroom audit` pitroom_audit, `pitroom apply`/`discard`/`revert`/`stop` the tools of those names, `pitroom history`/`ls`/`models`/`doctor` pitroom_info. With a shell the commands work as well.';
var skills;
function skillPrompts() {
  if (skills) return skills;
  const found = [];
  const root = packageRoot();
  for (const name of skillNames(root)) {
    try {
      const text = fs28.readFileSync(path24.join(root, "skills", name, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      const body = (front ? text.slice(front[0].length) : text).trim();
      const description = /^description:\s*(.+)$/m.exec(front?.[1] ?? "")?.[1]?.trim() ?? `The ${name} skill.`;
      const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name;
      found.push({
        name,
        title,
        // the first sentence: prompts/list is read whole by some clients, so it stays short
        description: `Skill: ${description.split(/(?<=\.)\s/)[0]}`,
        arguments: [{ name: "task", description: "What you are about to do (optional)." }],
        text: (a) => `${TOOL_MAP}

${body}${a.task ? `

---

The task: ${a.task}` : ""}`
      });
    } catch {
    }
  }
  skills = found.filter((p) => !PROMPTS.some((b) => b.name === p.name));
  return skills;
}
var allPrompts = () => [...PROMPTS, ...skillPrompts()];
var listPrompts = () => ({ prompts: allPrompts().map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
function getPrompt(name, given) {
  const p = allPrompts().find((x) => x.name === name);
  if (!p) throw new RpcError(-32602, `unknown prompt: ${String(name)}`);
  const args = {};
  const raw = given && typeof given === "object" && !Array.isArray(given) ? given : {};
  for (const a of p.arguments) {
    const v = raw[a.name];
    if (typeof v === "string" && v.trim()) args[a.name] = v.trim();
    else if (a.required) throw new RpcError(-32602, `missing argument: ${a.name}`);
  }
  return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(args) } }] };
}

// src/cli/mcp-tools.ts
var WORKER_PROPS = {
  worker: { type: "string", description: 'Worker "backend[:model]", e.g. "opencode", "claude:haiku". Default: configured.' },
  model: { type: "string", description: "Model for that worker." },
  tier: { type: "string", description: "cheap, standard or capable (from the config)." },
  effort: { type: "string", description: "low, medium, high, xhigh." },
  dir: { type: "string", description: "Project directory (default: the server's)." },
  files: { type: "array", items: { type: "string" }, description: "Files to attach." },
  verify: { type: "string", description: 'Command run afterwards, e.g. "npm test".' },
  link: { type: "array", items: { type: "string" }, description: 'Ignored dirs to link into an isolated copy, e.g. ["node_modules"].' },
  web: { type: "boolean", description: "Allow web tools." },
  group: { type: "string", description: "Group name for related runs." }
};
var WAIT_PROP = { waitSeconds: { type: "number", description: `Wait this long before returning "still running" (default ${DEFAULT_WAIT}, max ${MAX_WAIT}).` } };
var RUN_ID2 = { type: "string", description: 'Run id, or "last".' };
var READ_ONLY = { readOnlyHint: true, openWorldHint: false };
var TOPICS = {
  runs: ["running", "group"],
  history: ["text", "state", "model", "since", "limit"],
  stats: ["since"],
  savings: ["since", "perModel"],
  models: ["worker", "all"],
  cooldown: [],
  config: [],
  doctor: []
};
function infoArgs(topic, a) {
  const allowed = TOPICS[topic];
  const stray = Object.keys(a).filter((k) => k !== "topic" && a[k] !== void 0 && a[k] !== null && !allowed.includes(k));
  if (stray.length) throw new ToolError(`${stray.map((k) => `"${k}"`).join(", ")} ${stray.length > 1 ? "do" : "does"} not go with topic "${topic}" (${allowed.length ? `it takes ${allowed.join(", ")}` : "it takes no options"})`);
  const group = str(a, "group");
  const worker = str(a, "worker");
  switch (topic) {
    case "runs":
      return { args: group ? ["status", "-g", group] : ["ls", ...bool(a, "running") ? ["--running"] : []] };
    case "history": {
      const limit = a.limit;
      if (limit !== void 0 && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ToolError('"limit" must be a whole number from 1 to 200');
      const text = str(a, "text");
      const state = str(a, "state");
      const model = str(a, "model");
      return { args: ["history", ...since(a), ...state ? ["--state", state] : [], ...model ? ["--model", model] : [], ...limit ? ["--limit", String(limit)] : [], ...text ? ["--", text] : []] };
    }
    case "stats":
      return { args: ["history", "stats", ...since(a)] };
    case "savings":
      return { args: ["savings", ...since(a), ...bool(a, "perModel") ? ["--models"] : []] };
    case "models":
      return { args: ["models", ...worker ? [worker] : [], ...bool(a, "all") ? ["--all"] : []] };
    case "doctor":
      return { args: ["doctor"], timeoutMs: 12e4 };
    case "cooldown":
    case "config":
      return { args: [topic] };
    default:
      throw new Error(`topic "${topic}" has no command`);
  }
}
var TOOLS2 = [
  {
    name: "pitroom_run",
    title: "Run a worker",
    description: 'Hand a bounded task to a cheaper worker agent. mode "read" (default): read-only research, an answer with verified file:line references. "isolate": the worker edits a private copy and you get the exact diff (then pitroom_review, pitroom_apply or pitroom_discard). "write": edits the working tree (undo: pitroom_revert). Give "tasks" instead of "task" to run independent tasks in parallel (read or isolate). Returns the report(s) and a receipt (a read question asked before on the same code comes back cached), or "still running" for pitroom_wait. The using-pitroom skill (or prompt) says when and how to delegate. Cancelling the call stops the run.',
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to do, with the context the worker needs." },
        tasks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_TASKS, description: "Or several independent tasks, one worker each." },
        mode: { type: "string", enum: ["read", "isolate", "write"] },
        continue: { type: "string", description: "A finished run to follow up in the same worker session." },
        inPlace: { type: "boolean", description: "Read: read the directory itself, not a snapshot without secret-looking files." },
        audit: { type: "boolean", description: "Read: have another worker re-check the answer (each one, with tasks)." },
        fresh: { type: "boolean", description: "Read: ask a worker even if this question was answered on the same code." },
        ...WORKER_PROPS,
        ...WAIT_PROP
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const task = str(a, "task");
      const tasks = strs(a, "tasks").filter((t) => t.trim());
      if (!task && !tasks.length) throw new ToolError('give "task" (or "tasks" for parallel work)');
      if (task && tasks.length) throw new ToolError('give "task" or "tasks", not both');
      const mode = oneOf(a, "mode", ["read", "isolate", "write"], "read");
      const flags = mode === "isolate" ? ["-i"] : mode === "write" ? ["-w"] : [];
      if (mode === "read") {
        if (bool(a, "inPlace")) flags.push("--in-place");
        if (bool(a, "audit")) flags.push("--audit");
        if (bool(a, "fresh")) flags.push("--fresh");
      }
      const follow = str(a, "continue");
      if (tasks.length) {
        if (tasks.length > MAX_TASKS) throw new ToolError(`at most ${MAX_TASKS} tasks at once: start the rest when these are done`);
        if (mode === "write") throw new ToolError('parallel workers never write in place: use mode "isolate" (each gets its own copy)');
        if (follow) throw new ToolError('"continue" follows up one run: give "task"');
        return startCrew([...flags, ...workerFlags(a)], tasks, waitSeconds(a), ctx);
      }
      if (follow) flags.push("--continue", follow);
      return startAndWait(["run", ...flags, ...workerFlags(a)], waitSeconds(a), ctx, task);
    }
  },
  {
    name: "pitroom_wait",
    title: "Wait for runs",
    description: 'Wait for runs that came back "still running" and return their reports.',
    inputSchema: { type: "object", properties: { runs: { type: "array", items: { type: "string" } }, group: { type: "string" }, ...WAIT_PROP } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const runs = strs(a, "runs");
      const group = str(a, "group");
      if (!runs.length && !group) throw new ToolError('give "runs" or "group"');
      const result = await waitFor(runs, waitSeconds(a), ctx, runs.length ? void 0 : group);
      return withLiveView(result, result.text.includes("Not finished yet") ? await ensureDash() : void 0);
    }
  },
  {
    name: "pitroom_show",
    title: "Show a run",
    description: "A run's report (live progress while it runs); patch: the exact diff; full: the untruncated answer.",
    inputSchema: { type: "object", properties: { run: RUN_ID2, patch: { type: "boolean" }, full: { type: "boolean" } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const run2 = str(a, "run") ?? "last";
      return plain(["show", run2, ...bool(a, "patch") ? ["--patch"] : bool(a, "full") ? ["--full"] : []], ctx);
    }
  },
  {
    name: "pitroom_info",
    title: "Pitroom information",
    description: "Reports, changing nothing. topic: runs (latest runs; running, group), history (search earlier answers before asking again; text, state, model, since, limit), stats (success rate, time, tokens, audits per worker; since), savings (since, perModel), models (a backend's models and costs; worker, all), cooldown (rate-limited models being skipped), config, doctor (setup check).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: Object.keys(TOPICS) },
        text: { type: "string" },
        state: { type: "string" },
        model: { type: "string" },
        since: { type: "string", description: "7d, 30d, \u2026 or all." },
        limit: { type: "number" },
        running: { type: "boolean" },
        group: { type: "string" },
        worker: { type: "string" },
        all: { type: "boolean" },
        perModel: { type: "boolean" }
      },
      required: ["topic"]
    },
    annotations: READ_ONLY,
    async call(a, ctx) {
      if (str(a, "topic") === void 0) throw new ToolError(`"topic" is required: one of ${Object.keys(TOPICS).join(", ")}`);
      const topic = oneOf(a, "topic", Object.keys(TOPICS), "runs");
      const { args, timeoutMs } = infoArgs(topic, a);
      return plain(args, ctx, timeoutMs);
    }
  },
  {
    name: "pitroom_review",
    title: "Review a change",
    description: `A read-only reviewer (another worker by default) judges a run's change or a commit range ("main..HEAD"): findings with severities and a SPEC / QUALITY verdict.`,
    inputSchema: {
      type: "object",
      properties: {
        run: RUN_ID2,
        range: { type: "string", description: 'Or a commit range "A..B".' },
        plan: { type: "string", description: "With range: the plan file it implements." },
        worker: WORKER_PROPS.worker,
        tier: WORKER_PROPS.tier,
        dir: WORKER_PROPS.dir,
        group: WORKER_PROPS.group,
        ...WAIT_PROP
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const run2 = str(a, "run");
      const range = str(a, "range");
      if (!run2 === !range) throw new ToolError('give exactly one of "run" or "range"');
      const plan = str(a, "plan");
      const flags = workerFlags(a, ["worker", "tier", "dir", "group"]);
      return startAndWait(["review", ...range ? ["--range", range, ...plan ? ["--plan", plan] : []] : [run2], ...flags], waitSeconds(a), ctx);
    }
  },
  {
    name: "pitroom_audit",
    title: "Audit an answer",
    description: "Another worker re-checks a read run's answer: AGREE, PARTIAL or DISAGREE, with the disputed claims.",
    inputSchema: { type: "object", properties: { run: RUN_ID2, worker: WORKER_PROPS.worker, ...WAIT_PROP }, required: ["run"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const run2 = str(a, "run", true);
      const worker = str(a, "worker");
      return startAndWait(["audit", run2, ...worker ? ["-W", worker] : []], waitSeconds(a), ctx);
    }
  },
  {
    name: "pitroom_apply",
    title: "Apply an isolated change",
    description: "Land an isolated run's patch (or a group's, in order) on the working tree; checked first. A patch deleting files needs allowDelete: pass it only after checking the deletions were asked for.",
    inputSchema: { type: "object", properties: { run: RUN_ID2, group: { type: "string" }, allowDelete: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      const group = str(a, "group");
      const run2 = str(a, "run");
      if (!run2 && !group) throw new ToolError('give "run" or "group"');
      if (run2 && group) throw new ToolError('give "run" or "group", not both');
      return plain(["apply", ...group ? ["-g", group] : [run2], ...bool(a, "allowDelete") ? ["--allow-delete"] : []], ctx, 12e4);
    }
  },
  {
    name: "pitroom_discard",
    title: "Discard an isolated change",
    description: "Drop an isolated run's private copy (the patch is kept).",
    inputSchema: { type: "object", properties: { run: RUN_ID2 }, required: ["run"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      return plain(["discard", str(a, "run", true)], ctx);
    }
  },
  {
    name: "pitroom_revert",
    title: "Undo an in-place change",
    description: `Undo a mode "write" run's changes (refused if the files changed since).`,
    inputSchema: { type: "object", properties: { run: RUN_ID2 }, required: ["run"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      return plain(["revert", str(a, "run", true)], ctx, 12e4);
    }
  },
  {
    name: "pitroom_stop",
    title: "Stop runs",
    description: "Stop a running or queued run, or a group; cooldowns: try rate-limited models again now.",
    inputSchema: { type: "object", properties: { run: RUN_ID2, group: { type: "string" }, cooldowns: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      const run2 = str(a, "run");
      const group = str(a, "group");
      if (bool(a, "cooldowns")) {
        if (run2 || group) throw new ToolError('"cooldowns" goes alone');
        return plain(["cooldown", "--clear"], ctx);
      }
      if (!run2 && !group) throw new ToolError('give "run" or "group" (or "cooldowns": true)');
      if (run2 && group) throw new ToolError('give "run" or "group", not both');
      return plain(["stop", ...run2 ? [run2] : ["-g", group]], ctx);
    }
  }
];

// src/cli/mcp-watch.ts
var EVERY_MS = 2e3;
var MAX_SUBSCRIPTIONS = 100;
var watched = /* @__PURE__ */ new Set();
var timer;
var signature = (uri) => {
  const id = runOfUri(uri);
  if (!id) return void 0;
  try {
    const m = freshMeta(id);
    return uri.endsWith("/patch") ? `${m.state}:${m.changes?.length ?? 0}` : m.state;
  } catch {
    return void 0;
  }
};
var newestRun = () => {
  try {
    return listRunIds().at(-1);
  } catch {
    return void 0;
  }
};
function subscribe(session, uri) {
  if (typeof uri !== "string") throw new RpcError(-32602, '"uri" is required');
  if (!runOfUri(uri)) throw new RpcError(-32602, `only runs can be subscribed to (pitroom://run/<id>): ${uri}`);
  if (!session.subscriptions.has(uri) && session.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new RpcError(-32602, `at most ${MAX_SUBSCRIPTIONS} subscriptions: unsubscribe from finished runs first`);
  const sig = signature(uri);
  if (sig === void 0) throw new RpcError(-32002, `unknown resource: ${uri}`);
  session.subscriptions.set(uri, sig);
}
function unsubscribe(session, uri) {
  if (typeof uri !== "string") throw new RpcError(-32602, '"uri" is required');
  session.subscriptions.delete(uri);
}
function tick() {
  const listening = [...watched].filter((s) => s.push);
  if (!listening.length) return;
  const newest = newestRun();
  const seen = /* @__PURE__ */ new Map();
  for (const s of listening) {
    const push = s.push;
    if (newest !== s.newestRun) {
      s.newestRun = newest;
      push({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    }
    for (const [uri, last] of s.subscriptions) {
      if (!seen.has(uri)) seen.set(uri, signature(uri));
      const now = seen.get(uri);
      if (now === last) continue;
      if (now === void 0) s.subscriptions.delete(uri);
      else s.subscriptions.set(uri, now);
      push({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
    }
  }
}
function watch2(session) {
  session.newestRun = newestRun();
  watched.add(session);
  if (!timer) {
    timer = setInterval(tick, EVERY_MS);
    timer.unref();
  }
}
function unwatch(session) {
  watched.delete(session);
  session.subscriptions.clear();
  if (!watched.size && timer) {
    clearInterval(timer);
    timer = void 0;
  }
}

// src/cli/mcp.ts
var PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var INSTRUCTIONS = [
  "Pitroom hands bounded work to cheaper worker agents and returns a verified answer, the exact diff and a cost receipt. You decide, verify and answer.",
  'Use pitroom_run with mode "read" for research and locating code, mode "isolate" for code changes (the worker edits a copy; check it with pitroom_review, then pitroom_apply or pitroom_discard); pitroom_run with "tasks" for independent tasks in parallel; pitroom_info (topic history) finds an earlier answer before you ask again.',
  `A run can take minutes: pitroom_run waits up to waitSeconds, then returns the run id as "still running"; call pitroom_wait with it. A result that is still running also carries a "Live view" address (the dashboard, started for you): open it in your app's built-in browser pane if it has one, else give it to the user.`,
  "Pitroom's skills (using-pitroom, pitroom-research, pitroom-implement, pitroom-review, pitroom-crew, pitroom-debugging, pitroom-tdd and more) say when to delegate and how to check what comes back: if you have them, use the matching one alongside these tools; if not, the prompts of the same names hold them.",
  "It is optional: for a small task you can do yourself, skip it."
].join(" ");
var log = (msg) => void process.stderr.write(`pitroom mcp: ${msg}
`);
function newSession() {
  const session = { inflight: /* @__PURE__ */ new Map(), subscriptions: /* @__PURE__ */ new Map() };
  watch2(session);
  return session;
}
function endSession(session) {
  for (const { abort } of session.inflight.values()) abort.abort("closed");
  unwatch(session);
  session.push = void 0;
}
function progressToken(params) {
  const meta = params && typeof params === "object" ? params._meta : void 0;
  const token = meta && typeof meta === "object" ? meta.progressToken : void 0;
  return typeof token === "string" || typeof token === "number" ? token : void 0;
}
function contextFor(params, abort, notify) {
  const token = progressToken(params);
  let n = 0;
  return {
    signal: abort.signal,
    progress: (message) => {
      if (token === void 0 || abort.signal.aborted) return;
      notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++n, message } });
    }
  };
}
async function dispatch(method, params, ctx, session) {
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: false } },
        serverInfo: { name: "pitroom", title: "Pitroom", version: VERSION2 },
        instructions: INSTRUCTIONS
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS2.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case "tools/call": {
      const tool = TOOLS2.find((t) => t.name === params.name);
      if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      try {
        const r = await tool.call(args, ctx);
        return { content: [{ type: "text", text: r.text }], isError: r.isError === true };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
        log(`${tool.name} failed: ${e.stack ?? e}`);
        return { content: [{ type: "text", text: `pitroom: ${e.message}` }], isError: true };
      }
    }
    case "resources/list":
      return listResources();
    case "resources/templates/list":
      return resourceTemplates();
    case "resources/read":
      if (typeof params.uri !== "string") throw new RpcError(-32602, '"uri" is required');
      return readResource(params.uri, ctx);
    case "resources/subscribe":
      subscribe(session, params.uri);
      return {};
    case "resources/unsubscribe":
      unsubscribe(session, params.uri);
      return {};
    case "prompts/list":
      return listPrompts();
    case "prompts/get":
      return getPrompt(params.name, params.arguments);
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}
function cancel(session, params) {
  const id = params.requestId;
  if (typeof id !== "string" && typeof id !== "number") return;
  session.inflight.get(id)?.abort.abort("cancelled");
}
async function handle(session, msg, notify) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  const m = msg;
  if (typeof m.method !== "string") return void 0;
  const params = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? m.params : {};
  if (m.method === "notifications/cancelled") {
    cancel(session, params);
    return void 0;
  }
  const isRequest = typeof m.id === "string" || typeof m.id === "number";
  const abort = new AbortController();
  const entry = { abort, ctx: contextFor(params, abort, notify) };
  if (isRequest) session.inflight.set(m.id, entry);
  try {
    const result = await dispatch(m.method, params, entry.ctx, session);
    if (abort.signal.aborted && abort.signal.reason === "cancelled") return void 0;
    return isRequest ? { jsonrpc: "2.0", id: m.id, result } : void 0;
  } catch (e) {
    if (!isRequest || abort.signal.aborted && abort.signal.reason === "cancelled") return void 0;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: "2.0", id: m.id, error: { code, message: e.message } };
  } finally {
    if (isRequest && session.inflight.get(m.id) === entry) session.inflight.delete(m.id);
  }
}
async function handlePayload(session, parsed, notify) {
  if (Array.isArray(parsed)) {
    const replies = (await Promise.all(parsed.map((m) => handle(session, m, notify)))).filter((r) => !!r);
    return replies.length ? replies : void 0;
  }
  return handle(session, parsed, notify);
}
var parseError = () => ({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
async function serveMcp() {
  process.stdout.on("error", () => {
  });
  const send2 = (msg) => void process.stdout.write(`${JSON.stringify(msg)}
`);
  const session = newSession();
  session.push = send2;
  const rl = readline.createInterface({ input: process.stdin });
  const pending = /* @__PURE__ */ new Set();
  const handleLine = async (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      send2(parseError());
      return;
    }
    const reply2 = await handlePayload(session, parsed, send2);
    if (reply2) send2(reply2);
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const p = handleLine(line).catch((e) => log(String(e.stack ?? e)));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  await new Promise((resolve2) => rl.once("close", resolve2));
  unwatch(session);
  await Promise.allSettled([...pending]);
  return 0;
}

// src/cli/mcp-http.ts
import crypto8 from "node:crypto";
import fs30 from "node:fs";
import http2 from "node:http";
import path26 from "node:path";

// src/core/dash.ts
import { spawn as spawn6 } from "node:child_process";
import crypto7 from "node:crypto";
import fs29 from "node:fs";
import http from "node:http";
import path25 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/core/file-diff.ts
var PREVIEW_LINES = 300;
function gitPath(value, prefix = true) {
  let path34 = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes = [];
    const escapes = { t: "	", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v" };
    for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
      if (match[1] && /^[0-7]+$/.test(match[1])) bytes.push(parseInt(match[1], 8));
      else bytes.push(...new TextEncoder().encode(match[2] ?? escapes[match[1]] ?? match[1]));
    }
    path34 = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return prefix ? path34.replace(/^[ab]\//, "") : path34;
}
function headerPath(header) {
  const quoted = header.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return gitPath(quoted[2]);
  return gitPath(header.slice(header.lastIndexOf(" b/") + 1));
}
function fileDiffs(patch, changes, sourceTruncated = false) {
  const files = [];
  let file2;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  let row = 0;
  const finishHunk = () => {
    if (file2 && (oldLeft > 0 || newLeft > 0)) file2.incomplete = true;
    oldLeft = newLeft = 0;
    inHunk = false;
  };
  const add = (line) => {
    if (!file2) return;
    if (file2.lines.length < PREVIEW_LINES) file2.lines.push({ ...line, id: String(row) });
    else file2.omittedLines++;
    row++;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      file2 = { path: headerPath(line), status: "M", lines: [], additions: 0, deletions: 0, omittedLines: 0, binary: false, incomplete: false };
      files.push(file2);
      row = 0;
      continue;
    }
    if (!file2) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1);
      newLeft = Number(hunk[4] ?? 1);
      inHunk = true;
      add({ type: "hunk", content: line });
    } else if (inHunk && line.startsWith("\\ No newline at end of file")) {
      add({ type: "meta", content: line });
    } else if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("+") && newLeft > 0) {
        file2.additions++;
        newLeft--;
        add({ type: "added", newLine: newLine++, content: line.slice(1) });
      } else if (line.startsWith("-") && oldLeft > 0) {
        file2.deletions++;
        oldLeft--;
        add({ type: "removed", oldLine: oldLine++, content: line.slice(1) });
      } else if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        add({ type: "context", oldLine: oldLine++, newLine: newLine++, content: line.slice(1) });
      } else {
        file2.incomplete = true;
      }
    } else if (!inHunk) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") file2.path = gitPath(line.slice(4).replace(/\t$/, ""));
      else if (line.startsWith("--- ") && line !== "--- /dev/null") file2.path = gitPath(line.slice(4).replace(/\t$/, ""));
      else if (/^(GIT binary patch|Binary files .* differ)$/.test(line)) file2.binary = true;
      else if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|similarity index) /.test(line)) {
        if (line.startsWith("new file mode ")) file2.status = "A";
        if (line.startsWith("deleted file mode ")) file2.status = "D";
        if (line.startsWith("rename to ")) {
          file2.path = gitPath(line.slice(10), false);
          file2.status = "R";
        }
        add({ type: "meta", content: line });
      }
    }
  }
  finishHunk();
  if (sourceTruncated && file2) file2.incomplete = true;
  for (const f of files) {
    if (f.incomplete || f.binary) f.additions = f.deletions = void 0;
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const result = changes.map((change) => {
    const diff = byPath.get(change.path);
    byPath.delete(change.path);
    return diff ? { ...diff, status: change.status } : {
      ...change,
      lines: [],
      omittedLines: 0,
      binary: false,
      incomplete: sourceTruncated,
      unavailable: true
    };
  });
  return [...result, ...byPath.values()];
}

// src/core/dash-page.ts
var THEME_SCRIPT = "(function(){try{var t=localStorage.getItem('pitroom-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})()";
var ICON3 = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ff6a2b'/%3E%3Cpath d='M9 8h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4zM9 16h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4z' fill='%23fff'/%3E%3C/svg%3E";
var page = (token) => `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="pitroom-token" content="${token}"><title>Pitroom</title><link rel="icon" href="${ICON3}">
<script>${THEME_SCRIPT}</script><link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;
var MISSING = `<!doctype html><meta charset="utf-8"><title>Pitroom</title><body style="font:15px system-ui;padding:3rem;max-width:40rem;margin:auto"><h1>Pitroom dash</h1><p>The dashboard files are missing (dist/ui). Run <code>npm run build</code> in the Pitroom repository, or reinstall the package.</p></body>`;

// src/core/dash.ts
var DEFAULT_PORT = 7878;
var WEEK_MS2 = 7 * 24 * 3600 * 1e3;
var SCAN = 400;
var RUN_ID3 = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
var LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;
var oneLine7 = (s, max) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
function findings(m) {
  const v = m.verdict;
  if (!v) return "";
  const parts = [v.critical && `${v.critical} critical`, v.important && `${v.important} important`, v.minor && `${v.minor} minor`].filter(Boolean);
  return parts.length ? parts.join(" \xB7 ") : "no findings";
}
var canDiscard = (m) => m.mode === "isolate" && !isActive(m.state) && !m.applied && !m.discarded;
function toRun(m) {
  const l = m.state === "running" ? live(m) : void 0;
  return {
    id: m.id,
    state: m.state,
    verifyFailed: m.verifyResult && !m.verifyResult.ok ? true : void 0,
    kind: kind(m),
    // the model that really ran, once the CLI has said which; until then just the worker, never a guess
    worker: workerName(ranTarget(m)),
    task: what(m),
    group: m.group,
    startedAt: m.startedAt,
    time: elapsed(m),
    steps: l ? l.steps : m.usage?.steps ?? 0,
    tokens: m.usage?.total,
    saved: m.savedUsd || void 0,
    verdict: m.verdict ? `SPEC ${m.verdict.spec.toUpperCase()} \xB7 QUALITY ${m.verdict.quality.toUpperCase()}` : m.auditVerdict ? `AUDIT ${m.auditVerdict.toUpperCase()}` : void 0,
    audit: auditBadge(m),
    changes: m.changes?.length || void 0,
    applied: m.applied || void 0,
    discardable: canDiscard(m) || void 0,
    note: l?.last ? oneLine7(String(l.last), 140) : isActive(m.state) ? "" : m.verifyResult && !m.verifyResult.ok ? `verify failed: ${m.verify ?? ""}` : m.verdict ? findings(m) : m.auditOf && m.state === "done" ? m.auditDisputed?.length ? `${m.auditDisputed.length} disputed` : "nothing disputed" : headline(m, 200) || oneLine7(m.error ?? "", 200)
  };
}
function dashState(opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const metas = [];
  const groups = /* @__PURE__ */ new Set();
  for (const id of listRunIds().slice(-SCAN).reverse()) {
    let m;
    try {
      m = freshMeta(id);
    } catch {
      continue;
    }
    if (m.group) groups.add(m.group);
    if (opts.group && m.group !== opts.group) continue;
    metas.push(m);
  }
  const whole = new Set(metas.slice(0, limit).flatMap((m) => m.group ? [m.group] : []));
  const runs = metas.filter((m, i) => i < limit || m.group && whole.has(m.group)).map(toRun);
  return {
    price: primaryPrice().name,
    running: runs.filter((r) => r.state === "running" || r.state === "queued").length,
    saved: totals(readLedger(Date.now() - WEEK_MS2)).saved,
    groups: [...groups].sort(),
    runs
  };
}
var TASK_MAX = 6e3;
var PATCH_LINES = 300;
function runDetail(id) {
  if (!RUN_ID3.test(id)) return void 0;
  let m;
  try {
    m = freshMeta(id);
  } catch {
    return void 0;
  }
  const start = Date.parse(m.startedAt);
  const kept = isActive(m.state) ? void 0 : archivedRun(id);
  let steps = kept?.steps ?? [];
  if (!steps.length) try {
    const events = readRunFile(id, "events.jsonl");
    steps = (events ? getBackend((m.ran ?? m.worker).backend).parse(events).timeline ?? [] : []).map((s) => ({
      ...s,
      t: s.at && Number.isFinite(start) ? Math.max(0, Math.round((s.at - start) / 1e3)) : void 0
    }));
  } catch {
  }
  const rel = (t) => [m.cwd, m.dir].filter(Boolean).reduce((x, base2) => x.split(`${base2}/`).join(""), t);
  steps = steps.map((x) => ({ ...x, text: rel(x.text) }));
  const answer = isActive(m.state) ? "" : readSummary(m).replace(/^SUMMARY:\s*SPEC[^\n]*\n+/i, "").replace(/^DETAILS:[ \t]*\n+/i, "").trim();
  const lastSay = steps.at(-1);
  if (lastSay?.kind === "say" && answer && (answer.includes(lastSay.text.slice(0, 80)) || lastSay.text.includes(answer.slice(0, 80)))) steps.pop();
  const fullPatch = readRunFile(id, "changes.patch");
  const patch = fullPatch ?? kept?.patch ?? "";
  const patchLines = patch.split("\n");
  const u = m.usage;
  return {
    id,
    state: m.state,
    card: toRun(m),
    task: (m.auditOf ? `Audit of ${m.auditOf}` : m.reviewOf ? `Review of ${m.reviewOf.replace(/\b([0-9a-f]{9})[0-9a-f]{31}\b/g, "$1")}` : m.task).slice(0, TASK_MAX),
    steps,
    answer,
    changes: m.changes ?? [],
    fileDiffs: fileDiffs(patch, m.changes ?? [], fullPatch === void 0 && kept?.patchTruncated),
    patch: patch ? `${patchLines.slice(0, PATCH_LINES).join("\n")}${patchLines.length > PATCH_LINES ? `
\u2026 ${patchLines.length - PATCH_LINES} more lines (pitroom show ${id} --patch)` : ""}` : void 0,
    info: {
      worker: (m.ran ?? m.worker).backend,
      // the model has its own line
      model: m.resolvedModel,
      mode: m.mode,
      started: m.startedAt,
      time: elapsed(m),
      steps: u?.steps,
      toolCalls: u?.toolCalls,
      tokens: u?.total,
      returnedTokens: m.returnedTokens,
      cost: u?.cost ?? u?.costEstimate,
      costEstimated: u?.cost === void 0 && u?.costEstimate !== void 0 ? 1 : void 0,
      saved: m.savedUsd,
      group: m.group,
      directory: m.dir
    },
    attempts: m.attempts ?? [],
    warnings: m.warnings ?? [],
    refs: m.refs ? { valid: m.refs.valid, total: m.refs.total, invalid: m.refs.invalid.map((r) => `${r.ref} (${r.reason})`) } : void 0,
    verify: m.verifyResult && m.verify ? { command: m.verify, ok: m.verifyResult.ok, tail: m.verifyResult.tail } : void 0,
    error: m.error,
    audit: m.auditOf ? m.state === "done" ? { state: m.state, verdict: m.auditVerdict, disputed: m.auditDisputed ?? [] } : void 0 : m.audit && { id: m.audit.id, state: m.audit.state, verdict: m.audit.verdict, disputed: m.audit.disputed ?? [] },
    report: isActive(m.state) ? progress(m) : formatReport(m, void 0, 120)
  };
}
var HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Own files only, plus the hash of the one inline theme script; styles may be inline (the components position popups with them).
  "content-security-policy": `default-src 'none'; script-src 'self' 'sha256-${crypto7.createHash("sha256").update(THEME_SCRIPT).digest("base64")}'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'`
};
var ASSETS = { "/assets/app.js": "text/javascript; charset=utf-8", "/assets/app.css": "text/css; charset=utf-8" };
var assetsDir = () => fileURLToPath3(new URL("./ui/", import.meta.url));
var assetCache = /* @__PURE__ */ new Map();
function readAsset(route) {
  try {
    const file2 = path25.join(assetsDir(), path25.basename(route));
    const { mtimeMs } = fs29.statSync(file2);
    const hit = assetCache.get(route);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    const data = fs29.readFileSync(file2);
    assetCache.set(route, { mtimeMs, data });
    return data;
  } catch {
    return void 0;
  }
}
function handler(touch2, token) {
  const send2 = (res, code, type, body) => {
    res.writeHead(code, { ...HEADERS, "content-type": type });
    res.end(body);
  };
  const json = (res, code, value) => send2(res, code, "application/json; charset=utf-8", JSON.stringify(value));
  const tokenBuf = Buffer.from(token);
  const act = (req, res, pathname) => {
    req.resume();
    const given = Buffer.from(String(req.headers["x-pitroom-token"] ?? ""));
    if (given.length !== tokenBuf.length || !crypto7.timingSafeEqual(given, tokenBuf)) return json(res, 403, { error: "forbidden" });
    if (req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: "forbidden origin" });
    const m = /^\/api\/run\/([^/]+)\/(stop|discard)$/.exec(pathname);
    if (!m) return json(res, 404, { error: "not found" });
    let meta;
    try {
      if (!RUN_ID3.test(m[1])) throw new Error("bad id");
      meta = freshMeta(m[1]);
    } catch {
      return json(res, 404, { error: "no such run" });
    }
    try {
      if (m[2] === "stop") {
        return stopRun(meta.id) ? json(res, 200, { ok: true, message: `stopping ${meta.id}` }) : json(res, 409, { error: "run is not active" });
      }
      if (!canDiscard(meta)) return json(res, 409, { error: "only a finished, not yet applied isolate run can be discarded" });
      return json(res, 200, { ok: true, message: discardRun(meta) });
    } catch (e) {
      return json(res, 409, { error: e.message });
    }
  };
  return (req, res) => {
    touch2();
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") return act(req, res, url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read-only" });
    if (url.pathname === "/") return send2(res, 200, "text/html; charset=utf-8", readAsset("/assets/app.js") ? page(token) : MISSING);
    const type = ASSETS[url.pathname];
    if (type) {
      const data = readAsset(url.pathname);
      if (!data) return json(res, 404, { error: "dashboard files missing" });
      res.writeHead(200, { ...HEADERS, "content-type": type });
      return void res.end(req.method === "HEAD" ? void 0 : data);
    }
    if (url.pathname === "/api/state") {
      const group = url.searchParams.get("group") ?? void 0;
      const limit = Number(url.searchParams.get("limit") ?? 40);
      return json(res, 200, dashState({ group: group && group.length <= 100 ? group : void 0, limit: Number.isFinite(limit) ? limit : 40 }));
    }
    if (url.pathname === "/api/history") {
      const q = url.searchParams;
      const days2 = Number(q.get("days") ?? 0);
      return json(res, 200, listHistory({
        text: (q.get("q") ?? "").slice(0, 200),
        model: q.get("model") || void 0,
        backend: q.get("backend") || void 0,
        state: q.get("state") || void 0,
        group: q.get("group") || void 0,
        sinceMs: days2 > 0 ? Date.now() - days2 * 864e5 : void 0,
        beforeId: RUN_ID3.test(q.get("before") ?? "") ? q.get("before") : void 0,
        limit: Number(q.get("limit") ?? 30) || 30
      }));
    }
    if (url.pathname === "/api/stats") {
      const days2 = Number(url.searchParams.get("days") ?? 30);
      return json(res, 200, { ...historyStats(days2 > 0 ? Date.now() - days2 * 864e5 : void 0), price: primaryPrice().name });
    }
    const m = /^\/api\/run\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const d = runDetail(m[1]);
      return d ? json(res, 200, d) : json(res, 404, { error: "no such run" });
    }
    return json(res, 404, { error: "not found" });
  };
}
function startDash(opts) {
  let lastRequest = Date.now();
  const server = http.createServer(handler(() => lastRequest = Date.now(), crypto7.randomBytes(24).toString("hex")));
  return new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const port = server.address().port;
      let done;
      const closed = new Promise((r) => done = r);
      let timer2;
      const close = () => {
        if (timer2) clearInterval(timer2);
        server.closeAllConnections?.();
        return new Promise((r) => server.close(() => (done(), r())));
      };
      if (opts.idleMs && opts.idleMs > 0) {
        timer2 = setInterval(() => Date.now() - lastRequest > opts.idleMs && void close(), Math.min(6e4, opts.idleMs));
        timer2.unref();
      }
      resolve2({ port, url: `http://127.0.0.1:${port}/`, closed, close });
    });
  });
}
var registryFile = () => path25.join(home(), "dash.json");
async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state?limit=1`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
async function runningDash() {
  let r;
  try {
    r = JSON.parse(fs29.readFileSync(registryFile(), "utf8"));
  } catch {
    return void 0;
  }
  if (!isAlive(r.pid)) {
    fs29.rmSync(registryFile(), { force: true });
    return void 0;
  }
  return await ping(r.port) ? { ...r, url: `http://127.0.0.1:${r.port}/` } : void 0;
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn6(cmd, args, { stdio: "ignore", detached: true }).on("error", () => void 0).unref();
  } catch {
  }
}
async function dashCommand(o) {
  const existing = await runningDash();
  if (o.stop) {
    if (!existing) throw new UserError("pitroom dash is not running");
    process.kill(existing.pid, "SIGTERM");
    fs29.rmSync(registryFile(), { force: true });
    o.log(`stopped pitroom dash (${existing.url})`);
    return 0;
  }
  if (existing && !o.serve) {
    o.log(existing.url);
    if (o.open) openBrowser(existing.url);
    return 0;
  }
  if (o.detach) {
    const child = spawn6(process.execPath, [process.argv[1], "dash", "--serve", ...o.port !== void 0 ? ["--port", String(o.port)] : [], "--idle", "1h"], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.on("error", () => void 0);
    child.unref();
    for (let i = 0; i < 200; i++) {
      await new Promise((r2) => setTimeout(r2, 100));
      const r = await runningDash();
      if (r && r.pid === child.pid) {
        o.log(r.url);
        if (o.open) openBrowser(r.url);
        return 0;
      }
    }
    throw new UserError("pitroom dash did not start (is the port taken? try --port 0)");
  }
  importRuns();
  const explicit = o.port !== void 0;
  let dash;
  try {
    dash = await startDash({ port: o.port ?? DEFAULT_PORT, idleMs: o.idleMs });
  } catch (e) {
    if (explicit || e.code !== "EADDRINUSE") throw new UserError(`pitroom dash: ${e.message}`);
    dash = await startDash({ port: 0, idleMs: o.idleMs });
  }
  fs29.mkdirSync(home(), { recursive: true });
  const tmp = `${registryFile()}.${process.pid}.tmp`;
  fs29.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: dash.port }));
  renameOver(tmp, registryFile());
  const stop = () => void dash.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!o.serve) o.log(`${dash.url}
(read-only, this machine only; Ctrl-C stops it)`);
  if (o.open) openBrowser(dash.url);
  await dash.closed;
  try {
    if (JSON.parse(fs29.readFileSync(registryFile(), "utf8")).pid === process.pid) fs29.rmSync(registryFile(), { force: true });
  } catch {
  }
  return 0;
}

// src/cli/mcp-http.ts
var DEFAULT_PORT2 = 7117;
var MAX_BODY = 4e6;
var MAX_SESSIONS = 64;
var IDLE_MS = 60 * 6e4;
var PATH = "/mcp";
var tokenFile = () => path26.join(home(), "mcp-token");
var readToken = (file2) => {
  try {
    const kept = fs30.readFileSync(file2, "utf8").trim();
    return kept.length >= 16 ? kept : void 0;
  } catch {
    return void 0;
  }
};
function mcpToken() {
  const env = process.env.PITROOM_MCP_TOKEN?.trim();
  if (env) {
    if (env.length < 16) throw new UserError("PITROOM_MCP_TOKEN is too short to be a secret (16 characters at least)", 3);
    return { token: env, from: "PITROOM_MCP_TOKEN" };
  }
  const file2 = tokenFile();
  let token = readToken(file2);
  if (!token) {
    fs30.mkdirSync(path26.dirname(file2), { recursive: true });
    token = crypto8.randomBytes(32).toString("hex");
    try {
      fs30.writeFileSync(file2, `${token}
`, { mode: 384, flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      token = readToken(file2);
      if (!token) throw new UserError(`${file2} holds no usable token: delete it and start again`, 3);
    }
  }
  try {
    fs30.chmodSync(file2, 384);
  } catch {
  }
  return { token, from: file2 };
}
var LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
var sameSecret = (given, token) => {
  const a = crypto8.createHash("sha256").update(given).digest();
  const b = crypto8.createHash("sha256").update(token).digest();
  return crypto8.timingSafeEqual(a, b);
};
var idleSince = (k) => Math.max(k.lastSeen, k.closeStream ? k.streamSeen ?? 0 : 0);
function drop(sessions, id) {
  const k = sessions.get(id);
  if (!k) return;
  k.closeStream?.();
  endSession(k.session);
  sessions.delete(id);
}
var PING_MS = 25e3;
function reply(res, status, body, headers = {}) {
  if (res.headersSent) return void res.end();
  const text = body === void 0 ? "" : JSON.stringify(body);
  res.writeHead(status, { ...text ? { "Content-Type": "application/json" } : {}, "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}
var failure5 = (code, message) => ({ jsonrpc: "2.0", id: null, error: { code, message } });
function readBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve2(size > MAX_BODY ? "too-big" : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
var wantsStream = (parsed) => {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some((m) => m && typeof m === "object" && m.id !== void 0 && m.id !== null && progressToken(m.params) !== void 0);
};
function evictIdle(sessions) {
  let oldest;
  for (const entry of sessions) if (!entry[1].session.inflight.size && (!oldest || idleSince(entry[1]) < idleSince(oldest[1]))) oldest = entry;
  if (!oldest) return false;
  drop(sessions, oldest[0]);
  return true;
}
function makeHandler(token, sessions) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== PATH) return reply(res, 404, failure5(-32600, `not found: the endpoint is ${PATH}`));
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return reply(res, 403, failure5(-32600, "forbidden host"));
    const origin = req.headers.origin;
    if (origin !== void 0 && !LOCAL_ORIGIN.test(origin)) return reply(res, 403, failure5(-32600, "forbidden origin"));
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    if (!auth || !sameSecret(auth, token)) return reply(res, 401, failure5(-32001, "a bearer token is needed"), { "WWW-Authenticate": "Bearer" });
    const sid = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : void 0;
    if (req.method === "DELETE") {
      if (!sid || !sessions.has(sid)) return reply(res, 404, failure5(-32600, "no such session"));
      drop(sessions, sid);
      return reply(res, 204);
    }
    if (req.method === "GET") {
      if (!/text\/event-stream|\*\/\*/.test(req.headers.accept ?? "")) return reply(res, 406, failure5(-32600, "a GET opens the event stream: send Accept: text/event-stream"));
      if (!sid) return reply(res, 400, failure5(-32600, "Mcp-Session-Id is missing: initialize first"));
      const kept2 = sessions.get(sid);
      if (!kept2) return reply(res, 404, failure5(-32600, "no such session: initialize again"));
      kept2.closeStream?.();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": open\n\n");
      const open = () => !res.writableEnded && !res.destroyed;
      const push = (msg) => {
        if (!open()) return;
        kept2.streamSeen = Date.now();
        res.write(`event: message
data: ${JSON.stringify(msg)}

`);
      };
      const ping2 = setInterval(() => open() && res.write(": ping\n\n"), PING_MS);
      ping2.unref();
      res.on("error", () => {
      });
      kept2.streamSeen = Date.now();
      const close = () => {
        clearInterval(ping2);
        if (kept2.session.push === push) kept2.session.push = void 0;
        if (kept2.closeStream === close) kept2.closeStream = void 0;
        if (!res.writableEnded) res.end();
      };
      kept2.session.push = push;
      kept2.closeStream = close;
      res.on("close", close);
      return;
    }
    if (req.method !== "POST") return reply(res, 405, failure5(-32600, "GET, POST or DELETE"), { Allow: "GET, POST, DELETE" });
    const body = await readBody(req);
    if (body === "too-big") return reply(res, 413, failure5(-32600, `a request body is at most ${MAX_BODY} bytes`));
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(res, 400, parseError());
    }
    const headers = {};
    let kept;
    const single = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
    if (single?.method === "initialize") {
      if (sid) drop(sessions, sid);
      if (sessions.size >= MAX_SESSIONS && !evictIdle(sessions)) return reply(res, 503, failure5(-32e3, `${MAX_SESSIONS} sessions are busy with requests: try again when one ends`));
      const id = crypto8.randomUUID();
      kept = { session: newSession(), lastSeen: Date.now() };
      sessions.set(id, kept);
      headers["Mcp-Session-Id"] = id;
    } else {
      if (!sid) return reply(res, 400, failure5(-32600, "Mcp-Session-Id is missing: initialize first"));
      kept = sessions.get(sid);
      if (!kept) return reply(res, 404, failure5(-32600, "no such session: initialize again"));
    }
    kept.lastSeen = Date.now();
    if (!wantsStream(parsed)) {
      const out2 = await handlePayload(kept.session, parsed, () => {
      });
      kept.lastSeen = Date.now();
      return out2 === void 0 ? reply(res, 202, void 0, headers) : reply(res, 200, out2, headers);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...headers });
    const event = (msg) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: message
data: ${JSON.stringify(msg)}

`);
    };
    const out = await handlePayload(kept.session, parsed, event);
    if (out !== void 0) event(out);
    kept.lastSeen = Date.now();
    res.end();
  };
}
async function serveMcpHttp(opts) {
  const { token, from } = mcpToken();
  const sessions = /* @__PURE__ */ new Map();
  const handler2 = makeHandler(token, sessions);
  const server = http2.createServer((req, res) => {
    handler2(req, res).catch((e) => {
      process.stderr.write(`pitroom mcp: ${String(e.stack ?? e)}
`);
      reply(res, 500, failure5(-32603, "internal error"));
    });
  });
  const sweep = setInterval(() => {
    for (const [id, k] of [...sessions]) if (Date.now() - idleSince(k) > IDLE_MS && !k.session.inflight.size) drop(sessions, id);
  }, 6e4);
  sweep.unref();
  const port = await new Promise((resolve2, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new UserError(`port ${opts.port} is in use: pick another with --port N (0 picks a free one)`, 3) : e));
    server.listen(opts.port, "127.0.0.1", () => resolve2(server.address().port));
  });
  const url = `http://127.0.0.1:${port}${PATH}`;
  const secret = from === "PITROOM_MCP_TOKEN" ? "$PITROOM_MCP_TOKEN" : `$(cat "${from}")`;
  console.log(`pitroom mcp: listening on ${url} (127.0.0.1 only; token from ${from})`);
  console.log(`  working in ${process.cwd()} (-d DIR starts it in another project; the tools' "dir" argument picks one per call)`);
  console.log(`  Claude Code: claude mcp add --transport http pitroom ${url} --header "Authorization: Bearer ${secret}"`);
  console.log('  other clients: URL as above, header "Authorization: Bearer <the token>"');
  console.log("  anyone with the token can run workers as you: keep it private");
  await new Promise((resolve2) => {
    const stop = () => resolve2();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  clearInterval(sweep);
  for (const id of [...sessions.keys()]) drop(sessions, id);
  server.closeAllConnections();
  await new Promise((resolve2) => server.close(() => resolve2()));
  return 0;
}

// src/cli/commands.ts
import { spawnSync as spawnSync8 } from "node:child_process";
import fs36 from "node:fs";
import path32 from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/core/init.ts
import fs31 from "node:fs";
import path27 from "node:path";
var FREE = /-free$/;
var TIER_ORDER = [["cheap", "opencode"], ["standard", "codex"], ["capable", "claude"]];
var isFound = (binary5) => path27.isAbsolute(binary5) && fs31.existsSync(binary5);
function planInit(opts = {}) {
  const file2 = configPath();
  const workers = backendIds().map((id) => {
    const b = getBackend(id);
    const binary5 = b.binary();
    return { id, name: b.name, found: isFound(binary5), binary: binary5 };
  });
  const notes = [];
  const config = {};
  let blocked;
  let opencode2;
  if (workers.find((w) => w.id === "opencode")?.found) {
    const b = getBackend("opencode");
    let models = [];
    try {
      models = b.catalog ? b.catalog().models.map((m) => m.id) : b.listModels?.() ?? [];
    } catch {
      notes.push("could not list OpenCode models (is it logged in?)");
    }
    const defaultModel4 = b.defaultModel?.();
    const chosen = opts.model ?? defaultModel4;
    const free = models.filter((m) => FREE.test(m) && m !== chosen);
    opencode2 = { defaultModel: defaultModel4, models: models.length, free: free.slice(0, 6) };
    if (opts.model) {
      if (models.length && !models.includes(opts.model)) throw new UserError(`"${opts.model}" is not in \`opencode models\``);
      if (!models.length) notes.push(`could not check "${opts.model}": \`opencode models\` listed nothing`);
      config.models = { opencode: opts.model };
    } else if (!defaultModel4) {
      blocked = `OpenCode has no default model: choose one with --model <id>${free.length ? ` (free models you have: ${free.slice(0, 4).join(", ")})` : ""}`;
    }
    const fallback = opts.fallback ?? free.slice(0, 2);
    for (const m of fallback) {
      if (models.length && !models.includes(m)) throw new UserError(`"${m}" is not in \`opencode models\``);
    }
    if (fallback.length) {
      config.fallback = fallback.map((m) => `opencode:${m}`);
      if (!opts.fallback) notes.push(`fallback suggested from the free models in your catalogue: ${fallback.join(", ")} (change it with --fallback a,b)`);
    } else {
      notes.push("no fallback: no free OpenCode model found to suggest (pass --fallback a,b to name some)");
    }
  }
  const tiers = Object.fromEntries(TIER_ORDER.filter(([, id]) => workers.find((w) => w.id === id)?.found));
  if (Object.keys(tiers).length > 1) config.tiers = tiers;
  if (!workers.some((w) => w.found)) blocked = "no worker CLI found: install OpenCode (https://opencode.ai), Codex CLI, Claude Code or Gemini CLI first";
  else if (!blocked && !Object.keys(config).length) notes.push("nothing to propose: the default model and the single worker need no config");
  return { path: file2, exists: fs31.existsSync(file2), workers, opencode: opencode2, config, blocked, notes };
}
function writeInit(plan, force) {
  if (plan.blocked) throw new UserError(plan.blocked);
  if (!Object.keys(plan.config).length) throw new UserError("nothing to write: the proposal is empty");
  if (plan.exists && !force) throw new UserError(`${plan.path} already exists: pass --force to replace it (the old file is kept as ${path27.basename(plan.path)}.bak)`);
  fs31.mkdirSync(path27.dirname(plan.path), { recursive: true });
  if (plan.exists) fs31.copyFileSync(plan.path, `${plan.path}.bak`);
  fs31.writeFileSync(plan.path, `${JSON.stringify(plan.config, null, 2)}
`);
  return plan.path;
}
function formatInit(plan, written) {
  const out = [bold("pitroom init") + dim(": worker CLIs on this machine")];
  for (const w of plan.workers) out.push(`  ${w.found ? green("\u2714") : dim("\xB7")} ${w.name.padEnd(12)} ${w.found ? w.binary : dim("not found")}`);
  if (plan.opencode) {
    const o = plan.opencode;
    out.push(`  OpenCode: ${o.models} models, default ${o.defaultModel ?? "none"}${o.free.length ? `, free: ${o.free.slice(0, 3).join(", ")}${o.free.length > 3 ? ", \u2026" : ""}` : ""}`);
  }
  out.push("", `config file: ${plan.path}${plan.exists ? " (exists)" : " (not present)"}`, JSON.stringify(plan.config, null, 2));
  for (const n of plan.notes) out.push(`  note: ${n}`);
  if (written) out.push("", green(`\u2714 written to ${written}`), dim("  next: pitroom doctor, then pitroom install"));
  else if (plan.blocked) out.push("", yellow(`! ${plan.blocked}`));
  else out.push("", `nothing written yet: pass --yes to write it${plan.exists ? " (with --force, since the file exists)" : ""}`);
  return out.join("\n");
}

// src/core/mcp-install.ts
import { spawnSync as spawnSync7 } from "node:child_process";
import fs32 from "node:fs";
import os10 from "node:os";
import path28 from "node:path";
var CLIENT_IDS = ["claude-code", "codex", "gemini", "cursor", "claude-desktop"];
var NAME = "pitroom";
function mcpCommand() {
  const launcher = launcherPath();
  if (isPitroomLauncher(launcher)) return { command: launcher, args: ["mcp"] };
  for (const dir of (process.env.PATH ?? "").split(path28.delimiter).filter(Boolean)) {
    const p = path28.join(dir, process.platform === "win32" ? "pitroom.cmd" : "pitroom");
    if (fs32.existsSync(p)) return { command: path28.resolve(p), args: ["mcp"] };
  }
  return { command: process.execPath, args: [process.argv[1] ?? "pitroom", "mcp"] };
}
var same = (a, b) => {
  const o = b;
  return !!o && o.command === a.command && Array.isArray(o.args) && o.args.join("\0") === a.args.join("\0");
};
function run(backendId, args) {
  const { command, prefix } = resolveCommand(getBackend(backendId).binary());
  const r = spawnSync7(command, [...prefix, ...args], { encoding: "utf8", timeout: 6e4, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0 && !r.error, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
var runnable = (backendId) => run(backendId, ["--version"]).ok;
var readJson = (file2) => {
  try {
    return JSON.parse(fs32.readFileSync(file2, "utf8"));
  } catch {
    return void 0;
  }
};
var jsonState = (file2, c) => {
  const entry = readJson(file2)?.mcpServers?.[NAME];
  return entry === void 0 ? "absent" : same(c, entry) ? "same" : "different";
};
var home2 = () => os10.homedir();
var geminiDir = () => path28.join(process.env.GEMINI_CLI_HOME ?? home2(), ".gemini");
function cliClient(id, backend, name, where, o) {
  return {
    id,
    name,
    where,
    found: () => runnable(backend),
    state: o.state,
    add: (c) => {
      const r = run(backend, o.add(c));
      return { ok: r.ok, message: r.ok ? where : r.out.split("\n")[0]?.trim() || `${name}'s command failed` };
    },
    remove: () => {
      const r = run(backend, o.remove());
      return { ok: r.ok, message: r.ok ? where : r.out.split("\n")[0]?.trim() || `${name}'s command failed` };
    }
  };
}
function jsonClient(id, name, file2, dir) {
  const rel = () => file2().replace(home2(), "~");
  return {
    id,
    name,
    found: () => fs32.existsSync(dir()),
    state: (c) => jsonState(file2(), c),
    add: (c) => {
      let config = {};
      if (fs32.existsSync(file2())) {
        config = readJson(file2());
        if (!config || typeof config !== "object" || Array.isArray(config)) return { ok: false, message: `${rel()} is not valid JSON: left alone` };
        const backup = `${file2()}.bak-pitroom`;
        if (!fs32.existsSync(backup)) fs32.copyFileSync(file2(), backup);
      }
      config.mcpServers = { ...config.mcpServers ?? {}, [NAME]: { command: c.command, args: c.args } };
      fs32.mkdirSync(path28.dirname(file2()), { recursive: true });
      const tmp = `${file2()}.${process.pid}.tmp`;
      fs32.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}
`);
      fs32.renameSync(tmp, file2());
      return { ok: true, message: rel() };
    },
    remove: () => {
      const config = readJson(file2());
      if (!config?.mcpServers?.[NAME]) return { ok: true, message: rel() };
      delete config.mcpServers[NAME];
      fs32.writeFileSync(file2(), `${JSON.stringify(config, null, 2)}
`);
      return { ok: true, message: rel() };
    }
  };
}
function desktopFile() {
  if (process.platform === "darwin") return path28.join(home2(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path28.join(process.env.APPDATA ?? path28.join(home2(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path28.join(process.env.XDG_CONFIG_HOME ?? path28.join(home2(), ".config"), "Claude", "claude_desktop_config.json");
}
function codexState(c) {
  let text;
  try {
    text = fs32.readFileSync(path28.join(process.env.CODEX_HOME ?? path28.join(home2(), ".codex"), "config.toml"), "utf8");
  } catch {
    return "absent";
  }
  const at = text.search(/^\[mcp_servers\.pitroom\]\s*$/m);
  if (at < 0) return "absent";
  const table2 = text.slice(at).split(/\n(?=\[)/)[0] ?? "";
  try {
    const command = /^command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(table2)?.[1];
    const args = /^args\s*=\s*(\[[^\n]*\])/m.exec(table2)?.[1];
    return command && args && same(c, { command: JSON.parse(command), args: JSON.parse(args) }) ? "same" : "different";
  } catch {
    return "different";
  }
}
function clients() {
  return [
    cliClient("claude-code", "claude", "Claude Code", "user settings (~/.claude.json)", {
      state: (c) => jsonState(path28.join(home2(), ".claude.json"), c),
      add: (c) => ["mcp", "add", "--scope", "user", NAME, "--", c.command, ...c.args],
      remove: () => ["mcp", "remove", NAME, "--scope", "user"]
    }),
    cliClient("codex", "codex", "Codex", "~/.codex/config.toml", {
      state: (c) => codexState(c),
      add: (c) => ["mcp", "add", NAME, "--", c.command, ...c.args],
      remove: () => ["mcp", "remove", NAME]
    }),
    cliClient("gemini", "gemini", "Gemini CLI", "user settings (~/.gemini/settings.json)", {
      state: (c) => jsonState(path28.join(geminiDir(), "settings.json"), c),
      add: (c) => ["mcp", "add", "--scope", "user", NAME, c.command, ...c.args],
      remove: () => ["mcp", "remove", "--scope", "user", NAME]
    }),
    jsonClient("cursor", "Cursor", () => path28.join(home2(), ".cursor", "mcp.json"), () => path28.join(home2(), ".cursor")),
    jsonClient("claude-desktop", "Claude Desktop", desktopFile, () => path28.dirname(desktopFile()))
  ];
}
function attempt2(f) {
  try {
    return f();
  } catch (e) {
    return { ok: false, message: e.message.split("\n")[0] ?? "failed" };
  }
}
function installMcp(opts = {}) {
  const c = mcpCommand();
  const out = [];
  for (const client of clients()) {
    if (opts.only && !opts.only.includes(client.id)) continue;
    const r = (state, message) => out.push({ id: client.id, name: client.name, state, message });
    if (!client.found()) {
      r("not-found", client.id === "cursor" || client.id === "claude-desktop" ? "not found on this machine" : "not installed (its command does not run)");
      continue;
    }
    const now = client.state(c);
    if (now === "same" && !opts.force) {
      r("already", "already registered");
      continue;
    }
    if (opts.dryRun) {
      r("would-add", `would register ${[c.command, ...c.args].join(" ")}`);
      continue;
    }
    if (now !== "absent") attempt2(() => client.remove());
    const done = attempt2(() => client.add(c));
    r(done.ok ? now === "absent" ? "added" : "updated" : "failed", done.ok ? `${now === "absent" ? "registered" : "updated"} in ${done.message}` : done.message);
  }
  return out;
}
function uninstallMcp() {
  const c = mcpCommand();
  const out = [];
  for (const client of clients()) {
    let has2 = false;
    try {
      has2 = client.state(c) !== "absent";
    } catch {
      has2 = false;
    }
    if (!has2) continue;
    const done = client.found() ? attempt2(() => client.remove()) : { ok: false, message: `its command does not run: remove the pitroom entry from its config by hand` };
    out.push({ id: client.id, name: client.name, state: done.ok ? "removed" : "failed", message: done.ok ? `removed from ${done.message}` : done.message });
  }
  return out;
}
function mcpStatus() {
  const c = mcpCommand();
  return clients().map((client) => {
    try {
      return { id: client.id, name: client.name, state: client.state(c) };
    } catch {
      return { id: client.id, name: client.name, state: "absent" };
    }
  });
}
var parseClients = (value) => {
  if (!value) return void 0;
  const wanted = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = wanted.filter((w) => !CLIENT_IDS.includes(w));
  if (bad.length) throw new Error(`unknown client ${bad.join(", ")} (one of: ${CLIENT_IDS.join(", ")})`);
  return wanted;
};

// src/core/plan-status.ts
import crypto9 from "node:crypto";
import fs33 from "node:fs";
import path29 from "node:path";
function notesFile(plan) {
  const id = crypto9.createHash("sha1").update(plan.file).digest("hex").slice(0, 12);
  return path29.join(home(), "plans", id, "notes.md");
}
function readNotes(plan) {
  const f = notesFile(plan);
  if (!fs33.existsSync(f)) return [];
  return fs33.readFileSync(f, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (.*)$/.exec(l);
    return m ? { at: m[1], text: m[2] } : { at: "", text: l };
  });
}
function addNote(planFile, text) {
  const plan = loadPlan(planFile);
  const f = notesFile(plan);
  fs33.mkdirSync(path29.dirname(f), { recursive: true });
  if (!fs33.existsSync(f)) fs33.writeFileSync(f, `# plan: ${plan.file}
`);
  const at = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ");
  fs33.appendFileSync(f, `${at} ${text.replace(/\s+/g, " ").trim()}
`);
  return f;
}
function planStatus(planFile) {
  const plan = loadPlan(planFile);
  const runs = [];
  for (const id of listRunIds()) {
    try {
      const m = freshMeta(id);
      if (m.plan?.file === plan.file) runs.push(m);
    } catch {
    }
  }
  const notes = readNotes(plan);
  const tasks = plan.tasks.map((t) => {
    const impl = runs.filter((m) => m.plan.step === t.step && !m.reviewOf);
    const rev = runs.filter((m) => m.plan.step === t.step && m.reviewOf).at(-1);
    const last = impl.at(-1);
    return {
      step: t.step,
      title: t.title,
      runs: impl.length,
      last: last && { id: last.id, state: last.state, status: last.taskStatus },
      review: rev && { id: rev.id, state: rev.state, kind: rev.reviewKind ?? "task", verdict: rev.verdict },
      applied: impl.some((m) => m.applied || m.mode === "write" && m.state === "done" && !m.reverted && !!m.changes?.length),
      note: [...notes].reverse().find((n) => n.text.startsWith(`Task ${t.step}:`))?.text
    };
  });
  return { plan, tasks, rulings: notes.filter((n) => /\bRuling:/.test(n.text)), notesFile: notesFile(plan) };
}
var cell = (s, max) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
function formatPlanStatus(s) {
  const head = ["TASK", "STATE", "STATUS", "REVIEW", "ROUNDS", "APPLIED", "TITLE", "NOTE"];
  const rows = s.tasks.map((t) => {
    const v = t.review?.verdict;
    const review = v ? `${v.spec}/${v.quality} (c${v.critical} i${v.important} m${v.minor})` : t.review?.state ?? "-";
    return [
      String(t.step),
      t.last?.state ?? "-",
      t.last?.status ?? "-",
      review,
      t.runs ? String(t.runs - 1) : "-",
      t.runs ? t.applied ? "yes" : "no" : "-",
      cell(t.title, 32),
      cell(t.note ?? "", 60)
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => i === r.length - 1 ? c : c.padEnd(widths[i])).join("  ").trimEnd();
  const rulings = s.rulings.length ? s.rulings.map((n) => `  ${n.at} ${n.text}`).join("\n") : "  none";
  return [
    `plan ${s.plan.file} \xB7 ${s.plan.title || planName(s.plan.file)} \xB7 ${s.tasks.length} tasks`,
    "",
    fmt(head),
    ...rows.map(fmt),
    "",
    `Rulings:
${rulings}`,
    `notes: ${s.notesFile}`
  ].join("\n");
}

// src/core/cache.ts
import crypto10 from "node:crypto";
import fs34 from "node:fs";
import path30 from "node:path";
var SCAN2 = 500;
function cacheKey(o) {
  if (o.verify || o.mode !== "read" || o.continueFrom || o.web || o.plan || o.review || o.audit || o.auditRate === 1) return void 0;
  if (!(effective().cacheDays.value > 0)) return void 0;
  const dir = canonical(path30.resolve(o.dir));
  const root = repoRoot(dir);
  if (!root) return void 0;
  try {
    const tree = snapshotTree(root);
    const head = commitOf(root, "HEAD") ?? "";
    const files = o.files.map((f) => {
      const abs = path30.resolve(f);
      return [abs, crypto10.createHash("sha256").update(fs34.readFileSync(abs)).digest("hex")];
    });
    const question = o.task.replace(/\s+/g, " ").trim();
    const readIn2 = READ_IN.includes(effective().readIn.value) ? effective().readIn.value : "auto";
    const where = !o.inPlace && wantSnapshot(readIn2, root, dir) ? "snapshot" : "project";
    const key = crypto10.createHash("sha256").update(JSON.stringify([question, path30.relative(root, dir), files, where])).digest("hex");
    return { key, state: `${head}:${tree}` };
  } catch {
    return void 0;
  }
}
function heldUp(m) {
  if (m.state !== "done" || m.mode !== "read" || m.reviewOf || m.auditOf) return false;
  if (m.refs && m.refs.invalid.length) return false;
  if (m.warnings.some((w) => w.startsWith("READ-ONLY VIOLATION"))) return false;
  if (m.audit && (isActive(m.audit.state) || m.audit.verdict === "disagree" || m.audit.verdict === "partial")) return false;
  try {
    return readSummary(m).trim() !== "";
  } catch {
    return false;
  }
}
function findCached(k, now = Date.now()) {
  const maxAge = effective().cacheDays.value * 864e5;
  let best;
  for (const id of listRunIds().slice(-SCAN2)) {
    let m;
    try {
      m = readMeta(id);
    } catch {
      continue;
    }
    if (m.cache?.key !== k.key || m.cache.state !== k.state) continue;
    const at = Date.parse(m.endedAt ?? m.startedAt);
    if (now - at > maxAge || best && at <= best.at || !heldUp(m)) continue;
    best = { m, at };
  }
  return best?.m;
}
function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1e3);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
var cachedNote = (m) => `pitroom \u27F2 cached answer \xB7 the same question on the same code as run ${m.id} (${ago(m.endedAt ?? m.startedAt)}) \xB7 no worker ran \xB7 --fresh asks one again`;

// src/core/review.ts
import crypto11 from "node:crypto";
import fs35 from "node:fs";
import path31 from "node:path";
var TEMPLATE2 = { task: "task-reviewer", fix: "re-review", range: "code-reviewer" };
var section = (title, body) => `## ${title}

${body.trim() || "(empty)"}
`;
function ancestors(m) {
  const out = [];
  for (let id = m.parent; id; ) {
    const a = readMeta(id);
    out.push(a);
    id = a.parent;
  }
  return out;
}
function briefOf(m) {
  const root = [m, ...ancestors(m)].at(-1);
  const f = runFile(root.id, "brief.md");
  return fs35.existsSync(f) ? fs35.readFileSync(f, "utf8") : root.task;
}
function latestReview(ids) {
  for (const id of listRunIds().reverse()) {
    try {
      const m = readMeta(id);
      if (m.reviewOf && ids.includes(m.reviewOf) && m.state === "done") return m;
    } catch {
    }
  }
  return void 0;
}
function diffOf(m, from = m.baseTree) {
  const where = m.mode === "isolate" ? m.worktree : m.repoRoot;
  if (where && fs35.existsSync(where) && from && m.afterTree) return reviewDiff(where, from, m.afterTree);
  if (from !== m.baseTree) {
    throw new UserError(`the isolated copy of ${m.id} is gone, so its fix round cannot be shown on its own; review a run that is not applied yet`, 3);
  }
  return readRunFile(m.id, "changes.patch") ?? archivedRun(m.id)?.patch ?? "";
}
function runReview(id) {
  const m = freshMeta(id);
  if (isActive(m.state)) throw new UserError(`run ${m.id} is still ${m.state}; pitroom wait ${m.id} first`, 3);
  if (m.reviewOf) throw new UserError(`run ${m.id} is itself a review`);
  if (m.mode === "read") throw new UserError(`run ${m.id} was read-only; there is no change to review`);
  if (!m.changes?.length) throw new UserError(`run ${m.id} made no changes; nothing to review`);
  const chain = ancestors(m);
  const previous = latestReview(chain.map((a) => a.id));
  const dir = m.mode === "isolate" && m.worktree && fs35.existsSync(m.worktree) ? m.cwd : m.dir;
  const job = { of: m.id, dir, implementer: m.ran ?? m.worker, group: m.group, plan: m.plan };
  const title = m.plan ? `Task ${m.plan.step}: ${m.plan.title}` : `run ${m.id}`;
  if (!previous) {
    return {
      ...job,
      kind: "task",
      package: [`# Review package \xB7 ${title}
`, section("BRIEF", briefOf(m)), section("REPORT", readSummary(m)), section("DIFF", diffOf(m))].join("\n")
    };
  }
  const reviewed = chain.find((a) => a.id === previous.reviewOf);
  const from = m.mode === "isolate" ? reviewed.afterTree : m.baseTree;
  return {
    ...job,
    kind: "fix",
    package: [
      `# Re-review package \xB7 ${title} \xB7 fix round after review ${previous.id}
`,
      section("BRIEF", briefOf(m)),
      section("PREVIOUS FINDINGS", readSummary(previous)),
      section("FIX REPORT", readSummary(m)),
      section("FIX DIFF", diffOf(m, from))
    ].join("\n")
  };
}
function rangeReview(range, dir, planFile) {
  const root = repoRoot(dir);
  if (!root) throw new UserError("--range needs a git repository");
  const i = range.indexOf("..");
  const a = i > 0 ? range.slice(0, i) : "";
  const b = i > 0 ? range.slice(i + 2) || "HEAD" : "";
  if (!a || b.startsWith(".")) throw new UserError(`--range takes A..B (e.g. main..HEAD), not "${range}"`);
  for (const ref of [a, b]) if (!commitOf(root, ref)) throw new UserError(`not a commit: ${ref}`);
  const plan = planFile ? loadPlan(planFile) : void 0;
  const notes = plan ? readNotes(plan) : [];
  const requirements = plan ? [
    `Plan: ${plan.file}`,
    "### Global Constraints",
    plan.constraints || "(none stated in the plan)",
    "### Tasks",
    plan.tasks.map((t) => `- Task ${t.step}: ${t.title}`).join("\n")
  ].join("\n\n") : "(none given; judge the change on its own terms)";
  return {
    kind: "range",
    of: `${a}..${b}`,
    dir: root,
    group: plan ? planName(plan.file) : void 0,
    package: [
      `# Review package \xB7 ${a}..${b}
`,
      section("WHAT WAS IMPLEMENTED", plan ? `${plan.title}

${plan.header}` : "The commits below."),
      section("REQUIREMENTS", requirements),
      ...notes.length ? [section("NOTES FROM EXECUTION", notes.map((n) => `- ${n.text}`).join("\n"))] : [],
      rangeDiff(root, a, b)
    ].join("\n")
  };
}
function pickReviewer(job) {
  const eff = effective();
  const tiers = eff.tiers.value;
  if (job.kind === "range") return tiers.capable;
  if (tiers.review) return tiers.review;
  const implementer = job.implementer;
  if (!implementer) return void 0;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const candidates = [tiers.standard, tiers.capable, ...eff.fallback.value, eff.worker.value].filter((s) => !!s);
  return candidates.find((c) => parseTarget(c, def).backend !== implementer.backend);
}
function writePackage(job) {
  const g = gitDir(job.dir);
  const root = repoRoot(job.dir);
  if (!g || !root) throw new UserError(`not a git repository: ${job.dir}`);
  const name = `review-${crypto11.randomBytes(4).toString("hex")}.md`;
  const inside2 = !path31.relative(fs35.realpathSync(root), fs35.realpathSync(g)).startsWith("..");
  const file2 = inside2 ? path31.join(g, "pitroom", name) : path31.join(root, ".pitroom", name);
  if (!inside2) ignoreInGit(root, "/.pitroom/");
  fs35.mkdirSync(path31.dirname(file2), { recursive: true });
  fs35.writeFileSync(file2, job.package);
  return file2;
}
function ignoreInGit(root, pattern) {
  const exclude = path31.resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim());
  const text = fs35.existsSync(exclude) ? fs35.readFileSync(exclude, "utf8") : "";
  if (text.split(/\r?\n/).includes(pattern)) return;
  fs35.mkdirSync(path31.dirname(exclude), { recursive: true });
  fs35.appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}# Pitroom review packages in worktrees (removed after each review)
${pattern}
`);
}

// src/core/models.ts
var base = (model) => (model ?? "").split("#")[0];
function usage() {
  const eff = effective();
  const out = /* @__PURE__ */ new Map();
  const add = (spec, label) => {
    let t;
    try {
      t = parseTarget(spec, "opencode");
    } catch {
      return;
    }
    const model = base(t.model) || base(eff.models.value[t.backend]);
    if (!model) return;
    const key = `${t.backend}:${model}`;
    out.set(key, [...out.get(key) ?? [], label]);
  };
  add(eff.worker.value, "default worker");
  for (const [name, spec] of Object.entries(eff.tiers.value)) add(spec, `tier ${name}`);
  eff.fallback.value.forEach((spec) => add(spec, "fallback"));
  for (const [backend, model] of Object.entries(eff.models.value)) add(`${backend}:${model}`, "models");
  return out;
}
function modelTable(opts = {}) {
  const costs = effective().costs.value;
  const used = usage();
  const seen = /* @__PURE__ */ new Map();
  for (const e of readLedger()) {
    if (!e.backend || !e.model) continue;
    const key = `${e.backend}:${base(e.model)}`;
    const a = seen.get(key) ?? { runs: 0, tokens: 0, usd: 0 };
    seen.set(key, { runs: a.runs + 1, tokens: a.tokens + e.tokens, usd: a.usd + e.workerCost });
  }
  const rows = [];
  const sources = [];
  let hiddenOpenCode = 0;
  const known = /* @__PURE__ */ new Set();
  for (const b of allBackends()) {
    if (opts.backend && b.id !== opts.backend) continue;
    const catalog5 = b.catalog?.() ?? { models: [], source: "no model list for this worker" };
    sources.push(`${b.id}: ${catalog5.source}`);
    for (const m of catalog5.models) {
      const key = `${b.id}:${m.id}`;
      known.add(key);
      const s = seen.get(key);
      const row = {
        worker: b.id,
        model: m.id,
        efforts: m.efforts?.length ? m.efforts : void 0,
        defaultEffort: m.defaultEffort,
        cost: costs[key],
        runs: s?.runs ?? 0,
        avgTokens: s ? Math.round(s.tokens / s.runs) : void 0,
        reportedUsdPerRun: s && s.usd > 0 ? s.usd / s.runs : void 0,
        inUse: used.get(key) ?? []
      };
      const relevant = row.inUse.length || row.runs || row.cost !== void 0;
      if (b.id === "opencode" && !opts.all && !relevant) hiddenOpenCode++;
      else rows.push(row);
    }
  }
  for (const [key, labels] of used) {
    const [worker, ...rest] = key.split(":");
    if (known.has(key) || opts.backend && worker !== opts.backend) continue;
    const s = seen.get(key);
    rows.push({ worker, model: rest.join(":"), cost: costs[key], runs: s?.runs ?? 0, avgTokens: s ? Math.round(s.tokens / s.runs) : void 0, inUse: labels });
  }
  rows.sort(
    (a, b) => a.worker.localeCompare(b.worker) || Number(b.inUse.length > 0) - Number(a.inUse.length > 0) || (a.cost ?? Infinity) - (b.cost ?? Infinity) || b.runs - a.runs || a.model.localeCompare(b.model)
  );
  return { rows, sources, hiddenOpenCode };
}
var compact2 = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
function formatModels(t) {
  const efforts = (r) => r.efforts ? r.efforts.map((e) => e === r.defaultEffort ? `${e}*` : e).join("/") : "-";
  const cells = t.rows.map((r) => [
    r.worker,
    r.model,
    efforts(r),
    r.cost !== void 0 ? String(r.cost) : "?",
    r.runs ? String(r.runs) : "-",
    r.avgTokens !== void 0 ? compact2(r.avgTokens) : "-",
    r.reportedUsdPerRun !== void 0 ? `$${r.reportedUsdPerRun.toFixed(3)}` : "-",
    r.inUse.join(", ") || "-"
  ]);
  const head = ["worker", "model", "effort (* default)", "cost", "runs", "avg tokens", "$/run", "in use"];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(head), ...cells.map(line), ""];
  out.push('cost: your relative cost from the config ("costs": {"codex:gpt-6-sol": 1, \u2026}); ? = not set. Pitroom cannot know vendor prices.');
  out.push("runs, avg tokens, $/run: from your own runs (only Claude Code and OpenCode report dollars). Choose one with -W worker:model --effort LEVEL.");
  if (t.hiddenOpenCode) out.push(`${t.hiddenOpenCode} more OpenCode models not shown (use --all).`);
  out.push(...t.sources.map((s) => `source ${s}`));
  return out.join("\n");
}

// src/cli/commands.ts
async function launch(p, meta) {
  if (has(p, "bg")) {
    startInBackground(meta);
    console.log(
      has(p, "json") ? JSON.stringify(meta, null, 2) : `pitroom started ${meta.mode} run ${meta.id} in background${meta.group ? ` (group ${meta.group})` : ""}
   wait:   pitroom wait ${meta.id}
   status: pitroom status ${meta.id}` + meta.warnings.map((w) => `
warning: ${w}`).join("")
    );
    return 0;
  }
  const done = await execute(meta);
  console.log(has(p, "json") ? JSON.stringify(done, null, 2) : formatReport(done));
  return exitCodeFor(done);
}
async function cmdRun(p) {
  const opts = { ...runOptions(p, readTask(p)), plan: planStep(p) };
  if (!opts.task.trim() && !opts.plan) throw new UserError('no task given (pitroom "find where X is handled")');
  const cache = cacheKey(opts);
  const hit = cache && !has(p, "fresh") ? findCached(cache) : void 0;
  if (hit) {
    console.log(has(p, "json") ? JSON.stringify({ ...hit, cached: true }, null, 2) : `${cachedNote(hit)}

${formatReport(hit)}`);
    return exitCodeFor(hit);
  }
  return launch(p, prepareRun({ ...opts, cache }));
}
async function cmdReview(p) {
  const range = flag(p, "range");
  if (range && p.positional.length) throw new UserError("review takes a run or --range A..B, not both");
  if (flag(p, "plan") && !range) throw new UserError("--plan goes with --range (a run's review already knows its plan)");
  if (has(p, "write") || has(p, "isolate")) throw new UserError("reviews are read-only; drop -w/-i");
  if (has(p, "continue")) throw new UserError("to review a follow-up, pass its run id: pitroom review <run>");
  const job = range ? rangeReview(range, flag(p, "dir") ?? process.cwd(), flag(p, "plan")) : runReview(resolveRun(p.positional[0]));
  const packageFile = writePackage(job);
  let meta;
  try {
    meta = prepareRun({
      ...runOptions(p, fill(loadTemplate(TEMPLATE2[job.kind]), { PACKAGE_FILE: packageFile })),
      mode: "read",
      dir: job.dir,
      worker: flag(p, "worker") ?? (flag(p, "tier") ? void 0 : pickReviewer(job)),
      group: flag(p, "group") ?? job.group,
      review: { of: job.of, kind: job.kind, packageFile, plan: job.plan }
    });
    const automatic = !range && !flag(p, "worker") && !flag(p, "tier") && !effective().tiers.value.review;
    if (automatic && job.implementer && meta.worker.backend === job.implementer.backend) {
      meta.warnings.push(
        `reviewer runs on the same backend as the implementer (${job.implementer.backend}); configure tiers "standard" or "capable" for a second model`
      );
      writeMeta(meta);
    }
  } catch (e) {
    fs36.rmSync(packageFile, { force: true });
    throw e;
  }
  fs36.writeFileSync(runFile(meta.id, "package.md"), job.package);
  return launch(p, meta);
}
async function cmdAudit(p) {
  if (!p.positional[0]) throw new UserError("pitroom audit RUN: which run?");
  if (has(p, "write") || has(p, "isolate")) throw new UserError("audits are read-only; drop -w/-i");
  const m = freshMeta(resolveRun(p.positional[0]));
  if (isActive(m.state)) throw new UserError(`run ${m.id} is still ${m.state}; pitroom wait ${m.id} first`, 3);
  if (m.reviewOf || m.auditOf) throw new UserError(`run ${m.id} is itself a ${m.reviewOf ? "review" : "audit"}`);
  if (m.mode !== "read") throw new UserError(`run ${m.id} changed files; an audit re-checks a read run's answer: pitroom review ${m.id} judges a change`);
  const answer = readSummary(m);
  if (!answer.trim()) throw new UserError(`run ${m.id} gave no answer to audit`);
  const worker = flag(p, "worker") ?? (flag(p, "tier") ? void 0 : pickAuditor(m));
  if (!worker && !flag(p, "tier")) {
    throw new UserError('no other worker to audit with: name one with -W, or configure tiers "audit" or "cheap", or fallback workers, that differ from the one that answered', 3);
  }
  const a = prepareRun({
    ...runOptions(p, auditTask(m, answer)),
    mode: "read",
    dir: m.dir,
    worker,
    group: flag(p, "group") ?? m.group,
    noFallback: true,
    audit: { of: m.id },
    auditRate: void 0
  });
  m.audit = { id: a.id, state: "running" };
  writeMeta(m);
  return launch(p, a);
}
async function cmdPrices(p) {
  if (has(p, "refresh")) {
    const r = await refreshCatalog();
    if (r.state === "failed") {
      if (!has(p, "quiet")) console.error(`could not refresh the price catalog: ${r.error}`);
      return 1;
    }
    if (!has(p, "quiet")) console.log(`price catalog updated: ${r.models} priced models`);
  }
  const st = catalogStatus();
  const used = (() => {
    try {
      const chain = resolveChain();
      return [chain.worker, ...chain.fallback].map((t) => {
        const backend = getBackend(t.backend);
        const model = (t.model ?? "").split("#")[0];
        const price = workerPrice(t.backend, model);
        return {
          worker: model ? `${t.backend}:${model}` : t.backend,
          reportsCost: backend.capabilities.reportsCost,
          price: price ? { name: price.name, source: price.source, input: price.input, output: price.output, cachedInput: price.cachedInput } : void 0
        };
      });
    } catch {
      return [];
    }
  })();
  if (has(p, "json")) return console.log(JSON.stringify({ ...st, workers: used }, null, 2)), 0;
  console.log(`price feed: ${st.enabled ? "on" : 'off ("priceFeed": true in the config turns it on: Pitroom then fetches one public file, see PRIVACY.md)'}`);
  console.log(`source:     ${st.url}${st.enabled ? `, refreshed after a run when older than ${st.hours} h` : ""}`);
  console.log(st.models ? `catalog:    ${st.models} priced models, updated ${st.ageHours < 1 ? "within the hour" : `${st.ageHours.toFixed(1)} h ago`}` : "catalog:    none yet (pitroom prices --refresh fetches it)");
  if (st.lastFailure) console.log(`last try:   failed: ${st.lastFailure.replace(/^\S+ /, "")}`);
  if (used.length) {
    console.log("\nthe workers in use:");
    for (const u of used) {
      const what2 = u.reportsCost ? "reports its own cost" : u.price ? `in ${u.price.input} \xB7 out ${u.price.output} \xB7 cached ${u.price.cachedInput} USD/1M  (${u.price.source === "catalog" ? `price catalog ${catalogLabel()}` : "your workerPrices"})` : "no price: its runs count as free in the savings";
      console.log(`  ${u.worker.padEnd(36)} ${what2}`);
    }
  }
  return 0;
}
function cmdCooldown(p) {
  if (has(p, "clear")) {
    const n = clearCooldowns();
    console.log(n ? `cleared ${n} cooldown${n === 1 ? "" : "s"}: those models are tried again` : "no cooldowns");
    return 0;
  }
  const all = activeCooldowns();
  if (has(p, "json")) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }
  const rows = Object.values(all);
  if (!rows.length) {
    console.log("no model is cooling down");
    return 0;
  }
  console.log("Models left alone for now (runs go to the next worker; they are tried again after the time shown):");
  for (const c of rows) console.log(`  ${c.target.padEnd(52)} ${untilText(c)} \xB7 ${c.reason.slice(0, 90)}`);
  console.log("\npitroom cooldown --clear   try them again now");
  return 0;
}
function cmdPlan(p) {
  const [sub, file2, ...rest] = p.positional;
  if (sub === "status" && file2) {
    const s = planStatus(file2);
    console.log(
      has(p, "json") ? JSON.stringify({ plan: s.plan.file, title: s.plan.title, tasks: s.tasks, rulings: s.rulings, notesFile: s.notesFile }, null, 2) : formatPlanStatus(s)
    );
    return 0;
  }
  if (sub === "note" && file2 && rest.length) {
    console.log(`noted in ${addNote(file2, rest.join(" "))}`);
    return 0;
  }
  throw new UserError('usage: pitroom plan status PLAN.md [--json] | pitroom plan note PLAN.md "Task N: \u2026"');
}
function cmdCrew(p) {
  const file2 = flag(p, "task-file");
  const tasks = (file2 ? fs36.readFileSync(file2, "utf8").split(/^\s*---\s*$/m) : p.positional).map((t) => t.trim()).filter(Boolean);
  if (!tasks.length) throw new UserError('crew needs tasks: pitroom crew -g NAME "task 1" "task 2" (or --task-file with --- separators)');
  if (has(p, "write") && tasks.length > 1) {
    throw new UserError("parallel --write runs would edit the same tree; use --isolate (each worker gets its own isolated copy)");
  }
  if (has(p, "continue")) throw new UserError("--continue applies to a single run; use pitroom run --continue");
  if (has(p, "plan") || has(p, "step")) {
    throw new UserError("start plan tasks with pitroom run -i --plan PLAN --step N --bg (they share the plan's group)");
  }
  const group = flag(p, "group") ?? `crew-${(/* @__PURE__ */ new Date()).toISOString().slice(11, 19).replace(/:/g, "")}`;
  const metas = tasks.map((task) => startInBackground(prepareRun({ ...runOptions(p, task), group })));
  if (has(p, "json")) {
    console.log(JSON.stringify({ group, runs: metas.map((m) => ({ id: m.id, mode: m.mode, task: m.task })) }, null, 2));
    return 0;
  }
  console.log(`pitroom crew "${group}": ${metas.length} ${metas[0].mode} workers started (max ${effective().maxParallel.value} at once)`);
  for (const m of metas) console.log(`   ${m.id}  ${m.task.replace(/\s+/g, " ").slice(0, 70)}`);
  console.log(`   live:    pitroom watch -g ${group}        (agents: add --json)
   results: pitroom wait -g ${group}`);
  return 0;
}
function selectIds(p, fallback) {
  const group = flag(p, "group");
  if (group) {
    const ids = groupIds(group);
    if (!ids.length) throw new UserError(`no runs in group "${group}"`);
    return ids;
  }
  return p.positional.length ? p.positional.map((r) => resolveRun(r)) : fallback();
}
function cmdStatus(p) {
  if (flag(p, "group") || p.positional.length > 1) {
    const metas = selectIds(p, () => []).map((id) => freshMeta(id));
    console.log(table(metas));
    return metas.some((m) => isActive(m.state)) ? 75 : 0;
  }
  const meta = freshMeta(resolveRun(p.positional[0]));
  console.log(isActive(meta.state) ? progress(meta) : formatReport(meta));
  return exitCodeFor(meta);
}
async function cmdWait(p) {
  const ids = selectIds(p, () => [resolveRun(void 0)]);
  const { metas, timedOut } = await waitMany(ids, {
    any: has(p, "any"),
    timeoutMs: parseDuration(flag(p, "timeout") ?? "540") * 1e3
  });
  const finished = metas.filter((m) => TERMINAL.includes(m.state));
  const pending = metas.filter((m) => isActive(m.state));
  const parts = finished.map(
    (m) => has(p, "brief") ? `pitroom ${m.state} \xB7 ${m.id} \xB7 ${headline(m) || m.error || m.task}` : formatReport(m)
  );
  for (const m of pending) parts.push(progress(m));
  if (pending.length) {
    const again = flag(p, "group") ? `-g ${flag(p, "group")}` : pending.map((m) => m.id).join(" ");
    parts.push(`\u2500\u2500 ${pending.length} still active: pitroom wait ${again}`);
  }
  console.log(parts.join(metas.length > 1 && !has(p, "brief") ? "\n\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n\n" : "\n"));
  if (pending.length && (timedOut || !has(p, "any"))) return 75;
  return finished.map(exitCodeFor).find((c) => c !== 0) ?? 0;
}
async function cmdWatch(p) {
  const group = flag(p, "group");
  const explicit = p.positional.map((r) => resolveRun(r));
  const initial = group ? groupIds(group) : explicit.length ? explicit : listRunIds().filter((id) => isActive(freshMeta(id).state));
  if (!initial.length) {
    console.log(group ? `no runs in group "${group}"` : "nothing is running");
    return 0;
  }
  const brief2 = has(p, "brief");
  const { metas, timedOut } = await watch(group ? () => groupIds(group) : () => initial, {
    json: !brief2 && (has(p, "json") || !process.stdout.isTTY),
    brief: brief2,
    intervalMs: parseDuration(flag(p, "interval") ?? "2") * 1e3,
    timeoutMs: flag(p, "timeout") ? parseDuration(flag(p, "timeout")) * 1e3 : 0,
    write: (s) => process.stdout.write(s)
  });
  if (timedOut) return 75;
  return metas.some((m) => m.state !== "done") ? 1 : 0;
}
async function cmdDash(p) {
  const port = flag(p, "port");
  if (port !== void 0 && !(/^\d+$/.test(port) && Number(port) <= 65535)) throw new UserError("--port takes a number from 0 to 65535 (0 picks a free one)");
  return dashCommand({
    port: port === void 0 ? void 0 : Number(port),
    idleMs: flag(p, "idle") ? parseDuration(flag(p, "idle")) * 1e3 : void 0,
    detach: has(p, "detach"),
    stop: has(p, "stop"),
    open: has(p, "open"),
    serve: has(p, "serve"),
    log: (s) => console.log(s)
  });
}
var when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
var secs = (s) => s == null ? "-" : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`;
function cmdHistory(p) {
  if (!openDb()) throw new UserError("the history needs Node.js 22.13+ (node:sqlite)", 3);
  const sub = p.positional[0];
  if (sub === "import") {
    const r = importRuns();
    console.log(`imported ${r.imported} run(s); ${r.known} were already in the history (${historyFile()})`);
    return 0;
  }
  importRuns();
  const since2 = sinceMs(flag(p, "since"));
  if (sub === "stats") {
    const s = historyStats(since2);
    if (has(p, "json")) return console.log(JSON.stringify(s, null, 2)), 0;
    const t = s.totals;
    const limited = t.limited ? ` \xB7 ${t.limited} rate-limited (${s.rateLimits === "counted" ? "counted as not ok" : 'left out; "countRateLimits": true counts them'})` : "";
    console.log(`${t.runs} runs \xB7 ${t.ok} ok \xB7 ${t.failed} not ok${limited} \xB7 ${secs(t.seconds)} of worker time \xB7 ${(t.tokens / 1e6).toFixed(1)}M tokens \xB7 ~${usd(t.saved)} saved`);
    const rows2 = s.byWorker.map((w) => [`${w.backend}${w.model ? `:${w.model}` : ""}`, String(w.runs), w.runs ? `${Math.round(100 * w.ok / w.runs)}%` : "-", w.limited ? String(w.limited) : "-", secs(w.avgSeconds), w.avgTokens ? `${Math.round(w.avgTokens / 1e3)}k` : "-", `~${usd(w.saved)}`]);
    const head2 = ["WORKER", "RUNS", "OK", "LIMITED", "AVG TIME", "AVG TOKENS", "SAVED"];
    const widths2 = head2.map((h, i) => Math.max(h.length, ...rows2.map((r) => r[i].length)));
    const fmt2 = (r) => r.map((c, i) => i === 0 ? c.padEnd(widths2[i]) : c.padStart(widths2[i])).join("  ");
    if (rows2.length) console.log(`
${[fmt2(head2), ...rows2.map(fmt2)].join("\n")}`);
    return 0;
  }
  const limit = flag(p, "limit") ? Number(flag(p, "limit")) : 20;
  const { rows, total } = listHistory({ text: p.positional.join(" "), model: flag(p, "model"), state: flag(p, "state"), group: flag(p, "group"), sinceMs: since2, limit });
  if (has(p, "json")) return console.log(JSON.stringify({ total, rows }, null, 2)), 0;
  if (!rows.length) return console.log(total ? "nothing on this page" : "no matching runs"), 0;
  const body = rows.map((r) => [r.id, when(r.startedAt), r.verifyFailed ? "verify failed" : r.state, `${r.backend}${r.model ? ` (${r.model.split("/").pop()})` : ""}`, secs(r.seconds), r.task.length > 60 ? `${r.task.slice(0, 59)}\u2026` : r.task]);
  const head = ["RUN", "WHEN", "STATE", "WORKER", "TIME", "TASK"];
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r, header = false) => r.map((c, i) => {
    const cell2 = i === r.length - 1 ? c : c.padEnd(widths[i]);
    return header ? dim(cell2) : i === 2 ? stateColour(r[2], cell2) : cell2;
  }).join("  ");
  console.log([fmt(head, true), ...body.map((r) => fmt(r))].join("\n"));
  if (total > rows.length) console.log(`
${rows.length} of ${total} \xB7 --limit N for more \xB7 pitroom show <run> for one`);
  return 0;
}
function cmdShow(p) {
  const meta = freshMeta(resolveRun(p.positional[0]));
  const dump = (name) => {
    const text = readRunFile(meta.id, name) ?? (name === "changes.patch" ? archivedRun(meta.id)?.patch : void 0);
    process.stdout.write(text ?? `(no ${name}${name === "events.jsonl" ? ": the raw stream was removed, the history keeps the steps" : ""})
`);
  };
  if (has(p, "patch")) dump("changes.patch");
  else if (has(p, "events")) dump("events.jsonl");
  else if (has(p, "json")) console.log(JSON.stringify(meta, null, 2));
  else if (isActive(meta.state)) console.log(progress(meta));
  else console.log(formatReport(meta, void 0, has(p, "full") ? Infinity : 400));
  return 0;
}
function cmdLs(p) {
  const group = flag(p, "group");
  let ids = group ? groupIds(group) : listRunIds();
  if (has(p, "running")) ids = ids.filter((id) => isActive(freshMeta(id).state));
  const metas = ids.slice(-20).map((id) => freshMeta(id));
  if (!metas.length) {
    console.log(has(p, "running") ? "nothing is running" : "no runs yet");
    return 0;
  }
  console.log(table(metas));
  return 0;
}
function cmdApply(p) {
  const group = flag(p, "group");
  if (!group) {
    console.log(applyRun(freshMeta(resolveRun(p.positional[0])), has(p, "allow-delete")));
    return 0;
  }
  const pending = groupIds(group).map((id) => freshMeta(id)).filter((m) => m.mode === "isolate" && m.state === "done" && m.changes?.length && !m.applied && !m.discarded);
  if (!pending.length) throw new UserError(`group "${group}" has no finished isolate patches to apply`);
  for (const [i, m] of pending.entries()) {
    try {
      console.log(applyRun(m, has(p, "allow-delete")));
    } catch (e) {
      const rest = pending.slice(i + 1).map((r) => r.id);
      console.log(`\u2718 ${m.id}: ${e.message}`);
      if (rest.length) console.log(`   not applied yet: ${rest.join(" ")}`);
      if (!(e instanceof DeletionRefused)) {
        console.log(`   resolve it (e.g. pitroom run --continue ${m.id} "rebase your change on the current tree"), then apply the rest`);
      }
      return 1;
    }
  }
  return 0;
}
function cmdStop(p) {
  const ids = selectIds(p, () => [resolveRun(void 0)]);
  let stopped = 0;
  for (const id of ids) {
    const meta = stopRun(id);
    if (!meta) continue;
    console.log(`stopping ${meta.id} (${meta.state})`);
    stopped++;
  }
  if (!stopped) throw new UserError(ids.length === 1 ? `run ${ids[0]} is not active` : "none of these runs is active");
  return 0;
}
function sinceMs(s) {
  if (!s || s === "all") return void 0;
  const m = /^(\d+)d$/.exec(s);
  if (!m) throw new UserError("--since takes 7d, 30d, \u2026 or all");
  return Date.now() - Number(m[1]) * 864e5;
}
var readStdin = () => process.stdin.isTTY ? "" : fs36.readFileSync(0, "utf8");
function cmdStatusline(p) {
  const input = readStdin();
  const lines = [];
  const then = flag(p, "then");
  if (then) {
    const r = process.platform === "win32" ? spawnSync8(then, { shell: true, input, encoding: "utf8", timeout: 5e3 }) : spawnSync8("/bin/sh", ["-c", then], { input, encoding: "utf8", timeout: 5e3 });
    if (r.stdout?.trimEnd()) lines.push(r.stdout.trimEnd());
  }
  try {
    const own = statusLine();
    if (own) lines.push(own);
  } catch {
  }
  if (lines.length) console.log(lines.join("\n"));
  return 0;
}
function cmdHookCard() {
  try {
    const cards = hookCards(readStdin());
    if (cards) {
      console.log(
        JSON.stringify({
          systemMessage: cards,
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Pitroom, for the user:
${cards}` }
        })
      );
    }
  } catch {
  }
  return 0;
}
function cmdModels(p) {
  const backend = p.positional[0];
  const table2 = modelTable({ backend, all: has(p, "all") });
  console.log(has(p, "json") ? JSON.stringify(table2, null, 2) : formatModels(table2));
  return 0;
}
function cmdHookStart() {
  const script = path32.join(path32.dirname(path32.dirname(fileURLToPath4(import.meta.url))), "hooks", "session-start.mjs");
  if (fs36.existsSync(script)) spawnSync8(process.execPath, [script], { stdio: ["ignore", "inherit", "ignore"], env: process.env });
  return 0;
}
function cmdInit(p) {
  const fallback = flag(p, "fallback");
  const plan = planInit({ model: flag(p, "model"), fallback: fallback === void 0 ? void 0 : fallback.split(",").map((s) => s.trim()).filter(Boolean) });
  const written = has(p, "yes") ? writeInit(plan, has(p, "force")) : void 0;
  console.log(has(p, "json") ? JSON.stringify({ ...plan, written }, null, 2) : formatInit(plan, written));
  return 0;
}
function cmdSavings(p) {
  const since2 = flag(p, "since") ?? "all";
  const t = totals(readLedger(sinceMs(since2)));
  if (has(p, "models")) {
    const by = /* @__PURE__ */ new Map();
    for (const e of readLedger(sinceMs(since2))) {
      const key = `${e.backend ?? "?"}  ${e.model ?? "(default model)"}`;
      const a = by.get(key) ?? { runs: 0, tokens: 0, returned: 0, cost: 0, saved: 0 };
      by.set(key, { runs: a.runs + 1, tokens: a.tokens + e.tokens, returned: a.returned + e.returned, cost: a.cost + e.workerCost, saved: a.saved + e.saved });
    }
    const width = Math.max(12, ...[...by.keys()].map((k) => k.length));
    console.log(`${"worker  model".padEnd(width)}  ${"runs".padStart(5)} ${"processed".padStart(10)} ${"returned".padStart(9)} ${"cost".padStart(8)} ${"saved".padStart(8)}`);
    for (const [key, a] of [...by].sort((x, y) => y[1].runs - x[1].runs)) {
      console.log(`${key.padEnd(width)}  ${String(a.runs).padStart(5)} ${compact(a.tokens).padStart(10)} ${compact(a.returned).padStart(9)} ${usd(a.cost).padStart(8)} ${usd(a.saved).padStart(8)}`);
    }
    return 0;
  }
  const period = since2 === "all" ? "all time" : `last ${since2.replace("d", " days")}`;
  if (has(p, "json")) {
    console.log(JSON.stringify({ period, ...t, price: primaryPrice() }, null, 2));
    return 0;
  }
  console.log(`pitroom savings \xB7 ${period}
  delegated tasks     ${t.runs}
  tokens offloaded    ${compact(t.tokens)}
  returned to primary ~${compact(t.returned)}${t.ratio ? `  (${Math.round(t.ratio)}\xD7 compression)` : ""}
  worker cost         ${usd(t.workerCost)}
  est. saved          ${usd(t.saved)}  (vs ${primaryPrice().name} list prices)`);
  const out = flag(p, "card");
  if (out) {
    fs36.writeFileSync(out, card(t, period));
    console.log(`card written to ${path32.resolve(out)}`);
  }
  if (has(p, "badge")) console.log(`![pitroom](${badgeUrl(t)})`);
  return 0;
}
var MCP_ICON = { added: "\u2714", updated: "\u2714", already: "\xB7", removed: "\u2714", "not-found": "\xB7", failed: "\u2718", "would-add": "\u2192" };
function cmdInstall(p) {
  const mcp = has(p, "mcp") || has(p, "client");
  if (has(p, "dry-run") && !mcp) throw new UserError("--dry-run goes with --mcp");
  if (has(p, "no-skills") && !mcp) throw new UserError("--no-skills goes with --mcp: without it install links the skills");
  let only;
  try {
    only = parseClients(flag(p, "client"));
  } catch (e) {
    throw new UserError(e.message);
  }
  if (!has(p, "dry-run")) for (const line of install({ copy: has(p, "copy"), force: has(p, "force"), skills: !has(p, "no-skills") })) console.log(line);
  if (!mcp) return 0;
  const results = installMcp({ only, dryRun: has(p, "dry-run"), force: has(p, "force") });
  console.log(`
MCP clients (pitroom mcp):`);
  for (const r of results) console.log(`${MCP_ICON[r.state] ?? "\u2022"} ${r.name}: ${r.message}`);
  if (results.every((r) => r.state === "not-found")) {
    console.log("no MCP client found: add the server by hand (see the README), or install a client first");
  } else if (results.some((r) => r.state === "added" || r.state === "updated")) {
    console.log("restart those clients (or start a new session) so they pick the server up");
  }
  return results.some((r) => r.state === "failed") ? 1 : 0;
}
function cmdUninstall() {
  for (const line of uninstall()) console.log(line);
  const mcp = uninstallMcp();
  for (const r of mcp) console.log(`${MCP_ICON[r.state] ?? "\u2022"} ${r.name}: ${r.message}`);
  return mcp.some((r) => r.state === "failed") ? 1 : 0;
}
function cmdConfig(p) {
  const { warnings } = loadConfig();
  const eff = effective();
  if (has(p, "json")) {
    console.log(JSON.stringify({ path: configPath(), settings: eff, warnings }, null, 2));
    return 0;
  }
  console.log(`config file: ${configPath()}${fs36.existsSync(configPath()) ? "" : " (not present)"}`);
  for (const [key, s] of Object.entries(eff)) {
    const v = Array.isArray(s.value) ? s.value.join(", ") || "\u2014" : s.value && typeof s.value === "object" ? Object.entries(s.value).map(([k, m]) => `${k}=${m}`).join(", ") || "\u2014" : s.value === void 0 ? key === "model" ? "the worker's default" : "\u2014" : String(s.value);
    console.log(`  ${key.padEnd(15)} ${v}  (${s.source})`);
  }
  for (const w of warnings) console.log(`! ${w}`);
  return 0;
}
function cmdClean(p) {
  const days2 = Number(flag(p, "days") ?? 14);
  const cutoff = Date.now() - days2 * 864e5;
  const old = listRunIds().filter((id) => {
    const m = freshMeta(id);
    const pendingPatch = m.mode === "isolate" && !m.applied && !m.discarded && m.changes?.length;
    return TERMINAL.includes(m.state) && Date.parse(m.startedAt) < cutoff && !pendingPatch;
  });
  if (!has(p, "yes")) {
    console.log(`${old.length} run(s) older than ${days2} days would be removed (unapplied isolate patches are kept). Re-run with --yes.`);
    return 0;
  }
  for (const id of old) {
    const m = readMeta(id);
    if (m.mode === "isolate" && !m.discarded && !m.applied) discardRun(m);
    recordRun(m);
    fs36.rmSync(runDir(id), { recursive: true, force: true });
  }
  const snapshots = prune(Date.now(), 0);
  console.log(`removed ${old.length} run(s)${snapshots ? ` and ${snapshots} read snapshot${snapshots === 1 ? "" : "s"}` : ""}; the history and the savings ledger are kept`);
  return 0;
}
var cmdRevert = (p) => (console.log(revertRun(freshMeta(resolveRun(p.positional[0])))), 0);
var cmdDiscard = (p) => (console.log(discardRun(freshMeta(resolveRun(p.positional[0])))), 0);

// src/core/doctor.ts
import { spawnSync as spawnSync9 } from "node:child_process";
import fs37 from "node:fs";
import os11 from "node:os";
import path33 from "node:path";
var MARK2 = { ok: () => green("\u2714"), warn: () => yellow("!"), fail: () => red("\u2718") };
var NEXT = [
  { when: /no default model|no fallback workers/, command: "pitroom init", why: "propose a starter config (fallback models from your catalogue)" },
  { when: /pitroom install|no Pitroom skills|launcher on PATH/, command: "pitroom install", why: "link the skills and the pitroom command" },
  { when: /first `node` on PATH/, command: "nvm alias default 24", why: "a current Node first in every new shell" },
  { when: /not logged in/, command: "claude auth login", why: "sign in the Claude Code worker (Codex: codex login)" },
  { when: /Gemini CLI is not signed in|IneligibleTierError/, command: "export GEMINI_API_KEY=\u2026", why: "a Google AI Studio key for the Gemini worker" }
];
function usageLine() {
  const ids = listRunIds();
  if (!ids.length) {
    return 'no runs yet. Ask your agent to use Pitroom (for example "have a worker find where X is defined"), or try it yourself: pitroom run "where is <something> defined?"';
  }
  let when2 = "";
  try {
    const hours = Math.max(0, Math.round((Date.now() - Date.parse(readMeta(ids[ids.length - 1]).startedAt)) / 36e5));
    when2 = hours < 1 ? ", the last one within the hour" : hours < 48 ? `, the last one ${hours} h ago` : `, the last one ${Math.round(hours / 24)} days ago`;
  } catch {
  }
  return `${ids.length} run${ids.length === 1 ? "" : "s"} so far${when2} (pitroom savings shows what they saved)`;
}
function firstNodeOnPath() {
  for (const dir of (process.env.PATH ?? "").split(path33.delimiter).filter(Boolean)) {
    const file2 = path33.join(dir, process.platform === "win32" ? "node.exe" : "node");
    try {
      if (!fs37.statSync(file2).isFile()) continue;
    } catch {
      continue;
    }
    const r = spawnSync9(file2, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5e3 });
    return r.status === 0 ? { path: file2, version: r.stdout.trim() } : { path: file2, version: "" };
  }
  return void 0;
}
var tooOld = (v) => {
  const [a = 0, b = 0] = v.split(".").map(Number);
  return a < 22 || a === 22 && b < 13;
};
var READ_ONLY_HOW = {
  "permission-rules": "per-run permission rules",
  "os-sandbox": "an OS sandbox",
  "tool-allowlist": "a tool allowlist",
  "approval-mode": "the CLI's read-only approval mode"
};
function doctor5(probe) {
  const checks = [];
  let current = "Setup";
  const section2 = (name) => void (current = name);
  const add = (level, message) => checks.push({ level, message, section: current });
  const addAll = (list2) => list2.forEach((c) => add(c.level, c.message));
  add("ok", `pitroom ${VERSION2} \xB7 node ${process.versions.node} \xB7 state in ${home()}`);
  const onPath = firstNodeOnPath();
  if (onPath && onPath.version && tooOld(onPath.version) && path33.resolve(onPath.path) !== path33.resolve(process.execPath)) {
    add("warn", `the first \`node\` on PATH is v${onPath.version} (${onPath.path}), older than the 22.13 Pitroom needs: shells that agent apps start may use it (the pitroom command finds a newer Node itself; other tools may not)`);
  }
  add(gitAvailable() ? "ok" : "warn", gitAvailable() ? "git available" : "git not found: --write/--isolate tracking disabled");
  const cfg = loadConfig();
  add(cfg.warnings.length ? "warn" : "ok", `config: ${configPath()}${fs37.existsSync(configPath()) ? "" : " (not present, defaults in use)"}`);
  for (const w of cfg.warnings) add("warn", w);
  if (shimReady()) add("ok", "git guard shim ready");
  else if (process.platform === "win32") add("warn", "git guard: the ref and push guard is on, but the git shim needs the sh.exe of Git for Windows next to git (not found), so a worker's `git add`, `restore` or `clean` is not blocked; prefer --isolate and check the patch before apply");
  else add("warn", "git guard unavailable (git not on PATH)");
  section2("Worker chain");
  const chain = [];
  try {
    const resolved = resolveChain();
    chain.push(resolved.worker, ...resolved.fallback);
    for (const w of resolved.warnings) add("warn", w);
  } catch (e) {
    add("fail", e.message);
  }
  if (chain.length) add("ok", `worker chain: ${chain.map(describeTarget).join(" \u2192 ")}`);
  const rate2 = effective().audit.value;
  if (rate2 > 0 && chain.length) {
    const auditor = pickAuditor({ worker: chain[0], fallback: chain.slice(1) });
    add(auditor ? "ok" : "warn", auditor ? `audit: ${Math.round(rate2 * 100)}% of read runs are re-checked by ${auditor}` : `audit is on (${Math.round(rate2 * 100)}%) but no other worker could do it: add tiers "audit" or "cheap", or a fallback, that differs from ${describeTarget(chain[0])}`);
  }
  const tierTargets = [];
  const tierNames = [];
  for (const name of Object.keys(effective().tiers.value)) {
    try {
      tierTargets.push(resolveChain({ tier: name, noFallback: true }).worker);
      tierNames.push(name);
    } catch (e) {
      add("fail", `tier "${name}": ${e.message}`);
    }
  }
  if (tierNames.length) add("ok", `tiers: ${tierNames.map((name, i) => `${name}=${describeTarget(tierTargets[i])}`).join(", ")}`);
  const costs = effective().costs.value;
  if (Object.keys(costs).length) {
    for (const t of [...chain, ...tierTargets]) {
      const key = `${t.backend}:${(t.model ?? "").split("#")[0]}`;
      const mine = costs[key];
      if (mine === void 0) continue;
      const cheaper = Object.entries(costs).filter(([k, v]) => k.startsWith(`${t.backend}:`) && v < mine).sort((a, b) => a[1] - b[1])[0];
      add("ok", `cost: ${key} = ${mine}${cheaper ? `; you priced ${cheaper[0]} cheaper (${cheaper[1]}): is the dearer one needed?` : ""}`);
    }
  }
  const seenUnpriced = /* @__PURE__ */ new Set();
  for (const t of [...chain, ...tierTargets]) {
    let backend;
    try {
      backend = getBackend(t.backend);
    } catch {
      continue;
    }
    const model = (t.model ?? "").split("#")[0];
    const key = model ? `${t.backend}:${model}` : t.backend;
    if (backend.capabilities.reportsCost || seenUnpriced.has(key) || workerPrice(t.backend, model)) continue;
    seenUnpriced.add(key);
    add("warn", `${key} reports no cost, so its runs count as free in the savings: give its price in the config, "workerPrices": {"${key}": "<in>,<out>[,<cachedIn>]"} (USD per 1M tokens), or turn on "priceFeed": true to use the public price catalog`);
  }
  const feed = catalogStatus();
  if (feed.enabled) {
    if (feed.models) add(feed.lastFailure ? "warn" : "ok", `price catalog: ${feed.models} priced models from ${feed.url}, updated ${feed.ageHours < 1 ? "within the hour" : `${feed.ageHours.toFixed(1)} h ago`}${feed.lastFailure ? `; the last refresh failed (${feed.lastFailure.replace(/^\S+ /, "")})` : ""}`);
    else add("warn", `price feed is on but no catalog has been fetched yet${feed.lastFailure ? ` (the last try failed: ${feed.lastFailure.replace(/^\S+ /, "")})` : ""}: it is fetched after a run, or now with \`pitroom prices --refresh\``);
  }
  for (const c of Object.values(activeCooldowns())) {
    add("warn", `${c.target} is cooling down ${untilText(c)} (${c.reason.slice(0, 80)}): runs skip it while a fallback is left; \`pitroom cooldown --clear\` tries it again`);
  }
  const byBackend = /* @__PURE__ */ new Map();
  for (const t of [...chain, ...tierTargets]) byBackend.set(t.backend, [...byBackend.get(t.backend) ?? [], t.model]);
  for (const [id, models] of byBackend) {
    let backend;
    try {
      backend = getBackend(id);
    } catch (e) {
      add("fail", e.message);
      continue;
    }
    section2(backend.name);
    addAll(backend.doctor({ models: [...new Set(models)], hasFallback: chain.length > 1 }));
    add("ok", `${backend.name}: read-only runs enforced by ${READ_ONLY_HOW[backend.capabilities.readOnly]}`);
  }
  const unused = allBackends().filter((b) => !byBackend.has(b.id));
  for (const backend of unused) {
    let found;
    try {
      found = backend.doctor({ models: [], hasFallback: true });
    } catch {
      continue;
    }
    if (!found.length || found[0].level === "fail") continue;
    section2(`${backend.name} (installed, not in your config)`);
    for (const c of found) add("ok", c.message);
    add("ok", `use it with -W ${backend.id}[:model], or name it in "fallback" or "tiers" in the config`);
  }
  section2("MCP");
  const have = mcpStatus().filter((m) => m.state !== "absent");
  const stale = have.filter((m) => m.state === "different");
  add("ok", have.length ? `pitroom mcp is registered in: ${have.map((m) => m.name).join(", ")}` : "pitroom mcp is not registered in any client: `pitroom install --mcp` does it for the ones found (Cursor, Claude Desktop, Claude Code, Codex, Gemini CLI)");
  for (const m of stale) add("warn", `${m.name} runs a different command for pitroom mcp than this install's: \`pitroom install --mcp --no-skills\` updates it`);
  section2("Skills and agents");
  addAll(skillChecks());
  section2("Use");
  add("ok", usageLine());
  if (probe && chain[0]) {
    section2("Live probe");
    const p = liveProbe(chain[0]);
    add(p.level, p.message);
  }
  print(checks);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
function print(checks) {
  console.log(`${bold("Pitroom doctor")} ${dim(`v${VERSION2}`)}`);
  for (const name of [...new Set(checks.map((c) => c.section))]) {
    console.log(`
${bold(name)}`);
    for (const c of checks.filter((x) => x.section === name)) console.log(`  ${MARK2[c.level]()} ${wrapText(c.message, 4)}`);
  }
  const count = (level) => checks.filter((c) => c.level === level).length;
  const [ok, warn, fail] = [count("ok"), count("warn"), count("fail")];
  console.log(`
${green(`\u2714 ${ok} ok`)}   ${warn ? yellow(`! ${warn} warning${warn === 1 ? "" : "s"}`) : dim("! 0 warnings")}   ${fail ? red(`\u2718 ${fail} problem${fail === 1 ? "" : "s"}`) : dim("\u2718 0 problems")}`);
  const next = NEXT.filter((n) => checks.some((c) => c.level !== "ok" && n.when.test(c.message)));
  if (next.length) {
    console.log(`
${bold("Next")}`);
    const width = Math.max(...next.map((n) => n.command.length));
    for (const n of next) console.log(`  ${cyan(n.command.padEnd(width))}  ${dim(n.why)}`);
  }
}
function liveProbe(target) {
  let backend;
  try {
    backend = getBackend(target.backend);
  } catch (e) {
    return { level: "fail", message: e.message };
  }
  const inv = backend.invocation({
    mode: "read",
    prompt: "Reply with exactly: PONG",
    cwd: process.cwd(),
    model: target.model,
    files: [],
    web: false,
    title: "pitroom doctor probe"
  });
  const t0 = Date.now();
  const r = spawnSync9(inv.command, inv.args, {
    encoding: "utf8",
    timeout: 3e5,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: guardEnv({ ...process.env, ...inv.env, PWD: process.cwd(), PITROOM_ACTIVE: "1" })
  });
  const secs2 = ((Date.now() - t0) / 1e3).toFixed(1);
  const run2 = backend.parse(r.stdout ?? "");
  if (run2.finalText.includes("PONG")) return { level: "ok", message: `live probe (${describeTarget(target)}) answered in ${secs2}s` };
  const why = backend.failure(run2, r.stderr ?? "", r.status)?.message ?? run2.finalText.slice(0, 200);
  return { level: "fail", message: `live probe (${describeTarget(target)}) failed after ${secs2}s: ${why}` };
}
function skillChecks() {
  const checks = [];
  const all = skillNames();
  const viaPlugin = pluginInstalled();
  const superpowers = superpowersActive();
  if (superpowers.length) {
    checks.push({
      level: "warn",
      message: `superpowers is installed too (${superpowers.join(", ")}): two bootstraps compete for the same work; keep one (Pitroom includes the superpowers workflow)`
    });
  }
  for (const { base: base2, names } of installedSkills()) {
    if (names.length === all.length) checks.push({ level: "ok", message: `skills in ${base2}: ${names.join(", ")}` });
    else if (names.length) checks.push({ level: "warn", message: `skills in ${base2}: only ${names.join(", ")} of ${all.length}; run \`pitroom install\`` });
    else if (!viaPlugin) checks.push({ level: "warn", message: `no Pitroom skills in ${base2}; run \`pitroom install\`` });
  }
  if (geminiExtensionInstalled()) {
    const linked = installedSkills().some((i) => i.base.includes(`${path33.sep}.agents${path33.sep}`) && i.names.length);
    checks.push(
      linked ? { level: "warn", message: "Pitroom is installed as a Gemini CLI extension and linked into ~/.agents/skills: Gemini loads the skills twice; run `pitroom uninstall` or `gemini extensions uninstall pitroom`" } : { level: "ok", message: "Gemini CLI extension installed (skills + context)" }
    );
  }
  if (viaPlugin) {
    const linked = installedSkills().some((i) => i.base.includes(`${path33.sep}.claude${path33.sep}`) && i.names.length);
    checks.push(
      linked ? { level: "warn", message: "Pitroom is installed as a Claude Code plugin and linked into ~/.claude/skills: skills load twice; run `pitroom uninstall` or remove the plugin" } : { level: "ok", message: "Claude Code plugin installed (skills + session-start hook)" }
    );
  }
  const launcher = launcherPath();
  if (fs37.existsSync(launcher)) {
    const r = spawnSync9(launcher, ["--version"], { encoding: "utf8", timeout: 3e4, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    checks.push(
      r.status === 0 ? { level: "ok", message: `launcher ${launcher} \u2192 pitroom ${r.stdout.trim()}` } : { level: "fail", message: `launcher ${launcher} does not start: ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
    );
  } else {
    checks.push({ level: "warn", message: "no `pitroom` launcher on PATH: run `pitroom install`" });
  }
  return checks;
}
function geminiExtensionInstalled() {
  const home3 = process.env.GEMINI_CLI_HOME ?? os11.homedir();
  return fs37.existsSync(path33.join(home3, ".gemini", "extensions", "pitroom"));
}
function pluginInstalled() {
  try {
    const f = path33.join(os11.homedir(), ".claude", "plugins", "installed_plugins.json");
    const plugins = JSON.parse(fs37.readFileSync(f, "utf8")).plugins ?? {};
    return Object.keys(plugins).some((k) => k.startsWith("pitroom@"));
  } catch {
    return false;
  }
}
function superpowersActive() {
  const found = [];
  for (const key of claudePlugins()) {
    if (key.startsWith("superpowers@") && claudePluginEnabled(key)) found.push(`Claude Code plugin ${key}`);
  }
  for (const [key, enabled2] of codexPlugins()) {
    if (key.startsWith("superpowers@") && enabled2) found.push(`Codex plugin ${key}`);
  }
  for (const p of openCodePlugins()) {
    if (/superpowers/i.test(p)) found.push(`OpenCode plugin ${p}`);
  }
  for (const base2 of [path33.join(os11.homedir(), ".agents", "skills"), path33.join(os11.homedir(), ".claude", "skills")]) {
    const dir = path33.join(base2, "using-superpowers");
    if (fs37.existsSync(path33.join(dir, "SKILL.md"))) found.push(dir);
  }
  return found;
}
function claudePlugins() {
  try {
    const f = path33.join(os11.homedir(), ".claude", "plugins", "installed_plugins.json");
    return Object.keys(JSON.parse(fs37.readFileSync(f, "utf8")).plugins ?? {});
  } catch {
    return [];
  }
}
function claudePluginEnabled(key) {
  try {
    const f = path33.join(os11.homedir(), ".claude", "settings.json");
    return JSON.parse(fs37.readFileSync(f, "utf8")).enabledPlugins?.[key] !== false;
  } catch {
    return true;
  }
}
function codexPlugins() {
  const plugins = /* @__PURE__ */ new Map();
  let text;
  try {
    text = fs37.readFileSync(path33.join(process.env.CODEX_HOME ?? path33.join(os11.homedir(), ".codex"), "config.toml"), "utf8");
  } catch {
    return plugins;
  }
  let current;
  for (const line of text.split(/\r?\n/)) {
    const table2 = /^\s*\[(.*)\]\s*(#.*)?$/.exec(line);
    if (table2) {
      current = /^plugins\."([^"]+)"$/.exec(table2[1].trim())?.[1];
      if (current) plugins.set(current, true);
      continue;
    }
    const flag2 = current && /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (flag2) plugins.set(current, flag2[1] === "true");
  }
  return plugins;
}
function openCodePlugins() {
  const dir = path33.join(process.env.XDG_CONFIG_HOME ?? path33.join(os11.homedir(), ".config"), "opencode");
  const plugins = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = fs37.readFileSync(path33.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      const list2 = JSON.parse(text).plugin;
      if (Array.isArray(list2)) plugins.push(...list2.filter((p) => typeof p === "string"));
    } catch {
    }
  }
  for (const folder of ["plugin", "plugins"]) {
    try {
      for (const f of fs37.readdirSync(path33.join(dir, folder))) plugins.push(path33.join(dir, folder, f));
    } catch {
    }
  }
  return plugins;
}

// src/cli.ts
useArchive({ onFinished: recordRun, meta: (id) => archivedRun(id)?.meta, id: archivedId });
var HELP = `pitroom ${VERSION2} \u2014 a free pit crew for your expensive coding agent.
Delegates bounded tasks to a worker agent CLI (${backendIds().join(", ")}), using the
worker's own default model, and returns a compact answer, exact changes and a receipt.

Usage
  pitroom [run] [options] "task"        run a worker (task: argument, "-" for stdin, or --task-file)
  pitroom crew [options] -g NAME "task 1" "task 2" \u2026
                                        start several workers in background as one group
  pitroom review [run | --range A..B [--plan PLAN]] [--tier T | -W T] [--bg]
                                        read-only review of a run's change (a follow-up: only its
                                        fix round) or of a commit range; by default on another worker
  pitroom audit RUN [-W worker]         another worker re-checks a read run's answer (AGREE / PARTIAL / DISAGREE);
                                        "audit" in the config (0 to 1) does it for a share of read runs
  pitroom plan status PLAN [--json]     a plan's progress: runs, STATUS, review, fix rounds, applied
  pitroom plan note PLAN "Task N: \u2026"    record a completion, deferred finding or ruling (outside the repo)
  pitroom status [run | -g NAME]        state / live progress (default: latest run)
  pitroom wait [run\u2026 | -g NAME] [--any] [--brief] [--timeout 540]
                                        block until all (or any) are done, then print reports
  pitroom watch [run\u2026 | -g NAME] [--json | --brief] [--interval 2]
                                        --brief: one card line per start and end (made for Claude Code's Monitor tool)
  pitroom history [TEXT] [--model M] [--state S] [--since 30d] [--limit N] [--json]
                                        every finished run, searchable (SQLite); "history stats" per worker and model,
                                        "history import" takes in runs from before the history existed
  pitroom dash [--detach] [--port N] [--open] [--stop]
                                        a live page of the runs on 127.0.0.1 (read-only): open it in any browser
                                        or an agent app's browser pane; --detach runs it in the background
                                        live table (TTY) or one JSON line per change, until done
  pitroom show [run] [--patch|--events|--full|--json]
  pitroom ls [--running] [-g NAME]      recent runs
  pitroom apply [run | -g NAME] [--allow-delete]
                                        apply --isolate patch(es) to your tree (checked first); a patch
                                        that deletes files is refused unless --allow-delete
  pitroom discard [run]                 drop an --isolate run's copy (the patch is kept)
  pitroom revert [run]                  undo the changes of a --write run (checked first)
  pitroom stop [run | -g NAME]          stop running or queued workers
  pitroom savings [--since 7d|30d|all] [--models] [--card file.svg] [--badge]
  pitroom models [worker] [--all] [--json]
                                        models each worker offers, with effort levels, your costs and usage
  pitroom statusline [--then CMD]       status-bar line: running workers, savings this week (after CMD's)
  pitroom hook-card                     PostToolUse hook: a card after each Bash \`pitroom\` command
  pitroom hook-start                    SessionStart hook: introduces Pitroom to the agent (Codex; Claude Code uses its plugin)
  pitroom prices [--refresh] [--json]   the price catalog (config "priceFeed") and the price each worker in use gets
  pitroom cooldown [--clear]            models that said "rate limited" and are skipped for a while (a quota used up);
                                        --clear tries them again
  pitroom mcp [-d DIR] [--http [--port N]]
                                        serve Pitroom as MCP tools on stdio (Cursor, Claude Desktop, Gemini CLI, \u2026),
                                        or with --http at http://127.0.0.1:7117/mcp (bearer token, local only)
  pitroom doctor [--probe]              check workers, models, permissions, skills
  pitroom config                        effective settings, where each comes from, config file path
  pitroom init [--model ID] [--fallback A,B] [--yes] [--force]
                                        propose a starter config from the worker CLIs and models you have;
                                        writes it only with --yes (models are suggested, never chosen for you)
  pitroom install [--copy] [--force]    link the skills into ~/.agents/skills + ~/.claude/skills,
                                        and the CLI into ~/.local/bin
  pitroom install --mcp [--client A,B] [--no-skills] [--dry-run]
                                        also register "pitroom mcp" in the MCP clients found (Claude Code, Codex,
                                        Gemini CLI, Cursor, Claude Desktop); --dry-run only says what it would do
  pitroom uninstall                     remove what install linked (and the MCP registrations)
  pitroom clean [--days 14] [--yes]

Run options
  -r, --read            read-only research / review (default)
  -w, --write           edit your working tree; changes are snapshotted and revertible
  -i, --isolate         edit an isolated copy of your current state; you apply the patch
  -d, --dir PATH        project directory (default: cwd)
  -f, --file PATH       attach a file (repeatable)
  -W, --worker T        worker target "backend[:model]" (default: config "worker", else opencode)
  -m, --model M         model for that worker (default: the worker CLI's own default)
      --tier NAME       a worker from the config's "tiers" (e.g. cheap, standard, capable); -W wins
      --in-place        a read run reads the directory itself, not a clean snapshot (default: a snapshot without secret-looking
                        files when the directory has any; config "readIn": auto | snapshot | project)
      --audit           have another worker re-check this read run's answer; --no-audit skips it (default: the config's "audit")
      --fresh           ask a worker even when the same read question was answered on the same code (config "cacheDays", default 7)
      --effort LEVEL    reasoning effort for the worker: low, medium, high, xhigh, \u2026 (model#level)
      --plan PLAN       with --step N: implement Task N of a plan (-i or -w); the task text is your notes
      --step N          the plan task for --plan
  -t, --timeout DUR     e.g. 900, 20m, 1h (default 30m, or PITROOM_TIMEOUT)
      --verify CMD      run CMD after the worker (in the isolated copy for --isolate)
      --link a,b        isolate: symlink ignored dirs (e.g. node_modules) into the copy
  -c, --continue RUN    follow up in the same worker session (and the same isolated copy)
      --bg              start in background, print the run id, return immediately
  -g, --group NAME      tag the run as part of a group (crew, wait, watch, apply by group)
      --web             let the worker use webfetch/websearch (off by default)
      --no-fallback     do not fail over to fallback workers on model/provider errors
      --json            print the run record as JSON
      --task-file PATH  read the task from a file (crew: tasks separated by --- lines)
      --allow-non-git   allow --write outside a git repository (no tracking/revert)

Parallel: at most maxParallel workers (default 20, up to 30; PITROOM_MAX_PARALLEL) run at once; others queue.
          One --write run per repository; use --isolate for parallel changes.
Exit codes: 0 ok \xB7 1 worker failed \xB7 2 usage \xB7 3 refused/setup \xB7 4 timeout
            5 read-only violation \xB7 6 verify failed \xB7 75 still running (wait again)
Workers: ${backendIds().join(", ")} (targets: "opencode", "opencode:provider/model", or a bare model)
Env: PITROOM_WORKER, PITROOM_MODEL, PITROOM_FALLBACK="t1,t2", PITROOM_TIMEOUT, PITROOM_MAX_PARALLEL,
     PITROOM_PRIMARY=sonnet|opus|haiku|gpt-5, PITROOM_PRICE="in,out", PITROOM_HOME, PITROOM_CONFIG, PITROOM_CACHE_DAYS,
     PITROOM_NOTIFY, PITROOM_NOTIFY_COMMAND, PITROOM_NOTIFY_AFTER, PITROOM_MCP_DASH, PITROOM_PRICE_FEED, PITROOM_PRICE_FEED_URL,
     PITROOM_PRICE_FEED_HOURS, PITROOM_<WORKER>_BIN
Config: ~/.config/pitroom/config.json (worker, fallback, models, tiers, timeout, primary, price, link, web, maxParallel, audit, readIn, cacheDays,
        countRateLimits, mcpDash, notify, notifyCommand, notifyAfter, workerPrices, priceFeed, priceFeedUrl, priceFeedHours)`;
var COMMANDS = {
  run: cmdRun,
  crew: cmdCrew,
  review: cmdReview,
  audit: cmdAudit,
  cooldown: cmdCooldown,
  prices: cmdPrices,
  mcp: (p) => {
    const port = flag(p, "port");
    if (port !== void 0 && !has(p, "http")) throw new UserError("--port goes with --http (on stdio there is no port)");
    if (port !== void 0 && !(/^\d+$/.test(port) && Number(port) <= 65535)) throw new UserError("--port takes a number from 0 to 65535 (0 picks a free one)");
    const dir = flag(p, "dir");
    if (dir !== void 0) {
      if (!fs38.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UserError(`-d ${dir}: no such directory`);
      process.chdir(dir);
      process.env.PWD = process.cwd();
    }
    return has(p, "http") ? serveMcpHttp({ port: port === void 0 ? DEFAULT_PORT2 : Number(port) }) : serveMcp();
  },
  plan: cmdPlan,
  status: cmdStatus,
  wait: cmdWait,
  watch: cmdWatch,
  dash: cmdDash,
  history: cmdHistory,
  show: cmdShow,
  ls: cmdLs,
  list: cmdLs,
  apply: cmdApply,
  revert: cmdRevert,
  discard: cmdDiscard,
  stop: cmdStop,
  savings: cmdSavings,
  models: cmdModels,
  statusline: cmdStatusline,
  "hook-card": cmdHookCard,
  "hook-start": cmdHookStart,
  doctor: (p) => doctor5(has(p, "probe")),
  config: cmdConfig,
  init: cmdInit,
  install: cmdInstall,
  uninstall: cmdUninstall,
  clean: cmdClean,
  // internal: the detached process behind --bg
  __exec: async (p) => exitCodeFor(await execute(readMeta(p.positional[0])))
};
async function main(argv) {
  let [name, ...rest] = argv;
  if (name === void 0) name = "help";
  else if (name !== "help" && name !== "version" && !COMMANDS[name]) {
    rest = argv;
    name = "run";
  }
  const p = parse(rest);
  if (has(p, "help") || name === "help") return console.log(HELP), 0;
  if (has(p, "version") || name === "version") return console.log(VERSION2), 0;
  return COMMANDS[name](p);
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UserError) {
      console.error(`pitroom: ${e.message}`);
      process.exit(e.code);
    }
    console.error(`pitroom: ${e.stack ?? e}`);
    process.exit(1);
  }
);
