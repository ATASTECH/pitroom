#!/usr/bin/env node

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
function failure(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.trim().split("\n").filter(Boolean).pop();
  const message = run.error ?? detail ?? `claude exited with code ${exitCode}`;
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
        const cached3 = num2(u.cached_input_tokens);
        const reasoning = num2(u.reasoning_output_tokens);
        usage2.input += Math.max(0, num2(u.input_tokens) - cached3);
        usage2.cacheRead += cached3;
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
function failure2(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.split("\n").find((l) => /^Error[: ]|ERROR/.test(l) && !/rmcp|models cache/.test(l));
  let message = run.error ?? (detail ? detail.trim() : `codex exited with code ${exitCode}`);
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
  const file = path3.join(codexHome(), "models_cache.json");
  try {
    const raw = JSON.parse(fs3.readFileSync(file, "utf8"));
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
import fs5 from "node:fs";
import os5 from "node:os";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// src/core/store.ts
import fs4 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
import crypto from "node:crypto";
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
  fs4.mkdirSync(runDir(meta.id), { recursive: true });
  const file = runFile(meta.id, "meta.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs4.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs4.renameSync(tmp, file);
  if (TERMINAL.includes(meta.state)) {
    try {
      onFinished?.(meta);
    } catch {
    }
  }
}
function readMeta(id) {
  const file = runFile(id, "meta.json");
  if (!fs4.existsSync(file)) {
    const kept = archive?.meta(id);
    if (kept) return upgrade(kept);
  }
  return upgrade(JSON.parse(fs4.readFileSync(file, "utf8")));
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
  if (!fs4.existsSync(runsDir())) return [];
  return fs4.readdirSync(runsDir()).filter((d) => fs4.existsSync(runFile(d, "meta.json"))).sort();
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
function freshMeta(id) {
  const meta = readMeta(id);
  if (!TERMINAL.includes(meta.state) && meta.pid && !isAlive(meta.pid)) {
    const latest = readMeta(id);
    if (TERMINAL.includes(latest.state)) return latest;
    latest.state = "failed";
    latest.error ??= "worker process exited unexpectedly";
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
      const file = p.file_path ?? p.absolute_path ?? p.path;
      if (EDIT_TOOLS2.has(name) && file) pendingEdits.set(String(e.tool_id), String(file));
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
      const cached3 = num3(s.cached);
      usage2.cacheRead += cached3;
      usage2.input += s.input !== void 0 ? num3(s.input) : Math.max(0, num3(s.input_tokens) - cached3);
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
  const base2 = JSON.parse(fs5.readFileSync(path5.join(policyDir(), "worker-settings.json"), "utf8"));
  const auth = settings().security?.auth;
  const body = `${JSON.stringify(auth ? { ...base2, security: { ...base2.security, auth } } : base2, null, 2)}
`;
  const file = path5.join(dir, "settings.json");
  try {
    if (fs5.readFileSync(file, "utf8") === body) return root;
  } catch {
  }
  fs5.mkdirSync(dir, { recursive: true });
  fs5.writeFileSync(file, body);
  for (const name of ["oauth_creds.json", "google_accounts.json"]) {
    const from = path5.join(geminiHome(), name);
    const to = path5.join(dir, name);
    try {
      if (fs5.existsSync(from) && !fs5.existsSync(to)) fs5.symlinkSync(from, to);
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
  if (process.env.PITROOM_GEMINI_TRUST === "1") args.push("--skip-trust");
  const [model] = (req.model ?? "").split("#");
  if (model) args.push("--model", model);
  const { command, prefix } = resolveCommand(binary3());
  const env = { GEMINI_CLI_HOME: workerHome() };
  const trusted = path5.join(geminiHome(), "trustedFolders.json");
  if (fs5.existsSync(trusted)) env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = trusted;
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
function failure3(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const raw = run.error ?? detail ?? `gemini exited with code ${exitCode}`;
  const message = /not running in a trusted directory/i.test(`${stderr} ${raw}`) ? UNTRUSTED : raw;
  return { kind: classify3(message), message };
}
function geminiHome() {
  return path5.join(process.env.GEMINI_CLI_HOME ?? os5.homedir(), ".gemini");
}
function settings() {
  try {
    return JSON.parse(fs5.readFileSync(path5.join(geminiHome(), "settings.json"), "utf8"));
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
  const signedIn = fs5.existsSync(path5.join(geminiHome(), "oauth_creds.json"));
  const type = settings().security?.auth?.selectedType;
  if (key || vertex) {
    checks.push({ level: "ok", message: `Gemini CLI: ${key ? "an API key is set" : "Vertex AI is set up"}` });
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
  capabilities: { readOnly: "approval-mode", resume: "none", reportsCost: false, attachFiles: false },
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
import fs6 from "node:fs";
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
    return fs6.realpathSync(p);
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
function failure4(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `opencode exited with code ${exitCode}`;
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
import fs8 from "node:fs";

// src/core/config.ts
import fs7 from "node:fs";
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
  costs: "numbers"
};
function configPath() {
  if (process.env.PITROOM_CONFIG) return path7.resolve(process.env.PITROOM_CONFIG);
  const base2 = process.platform === "win32" ? process.env.APPDATA ?? path7.join(os7.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path7.join(os7.homedir(), ".config");
  return path7.join(base2, "pitroom", "config.json");
}
var cached;
function loadConfig() {
  if (cached) return cached;
  const file = configPath();
  const config = {};
  const warnings = [];
  if (fs7.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs7.readFileSync(file, "utf8"));
    } catch (e) {
      warnings.push(`${file}: invalid JSON (${e.message}); ignored`);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const type = SCHEMA[key];
        if (!type) {
          warnings.push(`${file}: unknown key "${key}" ignored`);
        } else if (matches(value, type)) {
          config[key] = value;
        } else {
          warnings.push(`${file}: "${key}" must be ${type}; ignored`);
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
  return typeof v === type;
}
var DEFAULT_PARALLEL = 20;
var MAX_PARALLEL_LIMIT = 30;
var clampParallel = (s) => ({ ...s, value: Math.min(s.value, MAX_PARALLEL_LIMIT) });
var positiveInt = (v) => {
  const n = Number(v);
  return v !== void 0 && v !== "" && Number.isInteger(n) && n > 0 ? n : void 0;
};
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
    costs: setting(void 0, void 0, c.costs, {})
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
  "--fallback": "fallback"
};
var BOOL_FLAGS = {
  "-r": "read",
  "--read": "read",
  "-w": "write",
  "--write": "write",
  "-i": "isolate",
  "--isolate": "isolate",
  "--bg": "bg",
  "--web": "web",
  "--no-fallback": "no-fallback",
  "--json": "json",
  "--allow-non-git": "allow-non-git",
  "--patch": "patch",
  "--events": "events",
  "--full": "full",
  "--badge": "badge",
  "--probe": "probe",
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
  const file = flag(p, "task-file");
  if (file) return fs8.readFileSync(file, "utf8");
  const words = p.positional;
  if (words.length === 1 && words[0] === "-") return fs8.readFileSync(0, "utf8");
  return words.join(" ");
}
function runOptions(p, task) {
  const modes = ["read", "write", "isolate"].filter((m) => has(p, m));
  if (modes.length > 1) throw new UserError("choose one of --read, --write, --isolate");
  const cont = flag(p, "continue");
  return {
    mode: modes[0] ?? "read",
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
  const file = flag(p, "plan");
  const step = flag(p, "step");
  if (!file && !step) return void 0;
  if (!file || !step) throw new UserError("--plan and --step go together: pitroom run -i --plan PLAN.md --step N");
  if (!/^\d+$/.test(step)) throw new UserError(`--step takes a task number, not "${step}"`);
  return { file, step: Number(step) };
}
function effortFlag(p) {
  const v = flag(p, "effort");
  if (v !== void 0 && !/^[a-z][a-z0-9-]*$/i.test(v)) throw new UserError(`--effort takes a level such as low, medium, high or xhigh, not "${v}"`);
  return v?.toLowerCase();
}

// src/cli/commands.ts
import { spawnSync as spawnSync7 } from "node:child_process";
import fs27 from "node:fs";
import path23 from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/core/init.ts
import fs9 from "node:fs";
import path8 from "node:path";

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

// src/core/init.ts
var FREE = /-free$/;
var TIER_ORDER = [["cheap", "opencode"], ["standard", "codex"], ["capable", "claude"]];
var isFound = (binary5) => path8.isAbsolute(binary5) && fs9.existsSync(binary5);
function planInit(opts = {}) {
  const file = configPath();
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
  return { path: file, exists: fs9.existsSync(file), workers, opencode: opencode2, config, blocked, notes };
}
function writeInit(plan, force) {
  if (plan.blocked) throw new UserError(plan.blocked);
  if (!Object.keys(plan.config).length) throw new UserError("nothing to write: the proposal is empty");
  if (plan.exists && !force) throw new UserError(`${plan.path} already exists: pass --force to replace it (the old file is kept as ${path8.basename(plan.path)}.bak)`);
  fs9.mkdirSync(path8.dirname(plan.path), { recursive: true });
  if (plan.exists) fs9.copyFileSync(plan.path, `${plan.path}.bak`);
  fs9.writeFileSync(plan.path, `${JSON.stringify(plan.config, null, 2)}
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

// src/core/history.ts
import fs12 from "node:fs";
import { createRequire } from "node:module";
import path10 from "node:path";
import zlib from "node:zlib";

// src/core/receipt.ts
import fs10 from "node:fs";
import path9 from "node:path";
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
  return PRESETS[eff.primary.value.toLowerCase()] ?? PRESETS.sonnet;
}
var estimateTokens = (text) => Math.ceil(text.length / 4);
function savedUsd(usage2, returnedTokens, price = primaryPrice()) {
  const wouldCost = (usage2.input * price.input + usage2.cacheRead * price.cachedInput + (usage2.output + usage2.reasoning) * price.output) / 1e6;
  const readingTheReport = returnedTokens * price.input / 1e6;
  return Math.max(0, wouldCost - (usage2.cost ?? 0) - readingTheReport);
}
function record(meta) {
  if (!meta.usage?.steps) return;
  const entry = {
    id: meta.id,
    at: meta.endedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    mode: meta.mode,
    state: meta.state,
    backend: (meta.ran ?? meta.worker).backend,
    model: meta.resolvedModel ?? (meta.ran ?? meta.worker).model,
    tokens: meta.usage.total,
    returned: meta.returnedTokens ?? 0,
    workerCost: meta.usage.cost ?? 0,
    saved: meta.savedUsd ?? 0,
    price: primaryPrice().name
  };
  fs10.mkdirSync(path9.dirname(ledgerFile()), { recursive: true });
  fs10.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}
`);
}
function readLedger(sinceMs2) {
  if (!fs10.existsSync(ledgerFile())) return [];
  return fs10.readFileSync(ledgerFile(), "utf8").split("\n").filter(Boolean).flatMap((l) => {
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
import fs11 from "node:fs";
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
    if (fs11.existsSync(marker)) continue;
    if (!(phase === "started" && !isActive(m.state))) out.push(text());
    fs11.writeFileSync(marker, "");
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
${output}`.match(RUN_ID) ?? [])].filter((id) => fs11.existsSync(`${runsDir()}/${id}`));
  const since = Date.now() - RECENT_HOURS * 36e5;
  for (const id of listRunIds().slice(-RECENT)) {
    if (ids.includes(id) || fs11.existsSync(runFile(id, "card-ended"))) continue;
    try {
      const m = readMeta(id);
      if (!isActive(m.state) && Date.parse(m.endedAt ?? m.startedAt) > since) ids.push(id);
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
var ANSWER_MAX = 2e5;
var cached2;
var historyFile = () => path10.join(home(), "history.db");
function openDb() {
  const file = historyFile();
  if (cached2?.file === file) return cached2.db;
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
    fs12.mkdirSync(path10.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    migrate(db);
  } catch {
    db = void 0;
  }
  cached2 = { file, db };
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
    if (fs12.existsSync(f)) return fs12.readFileSync(f, "utf8");
    if (fs12.existsSync(`${f}.gz`)) return zlib.gunzipSync(fs12.readFileSync(`${f}.gz`)).toString("utf8");
  } catch {
  }
  return void 0;
}
function gzipFile(f) {
  if (!fs12.existsSync(f)) return;
  fs12.writeFileSync(`${f}.gz`, zlib.gzipSync(fs12.readFileSync(f)));
  fs12.rmSync(f);
}
function compactRun(meta) {
  if (!TERMINAL.includes(meta.state)) return;
  const dir = path10.dirname(runFile(meta.id, "meta.json"));
  let names;
  try {
    names = fs12.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (/^events(\.attempt-\d+)?\.jsonl$/.test(n)) gzipFile(path10.join(dir, n));
    else if (/^stderr(\.attempt-\d+)?\.log$/.test(n)) {
      if (meta.state === "done" && !/attempt/.test(n)) fs12.rmSync(path10.join(dir, n), { force: true });
      else gzipFile(path10.join(dir, n));
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
    const answer = known?.has ? void 0 : clip5(readRunFile(meta.id, "summary.md")?.trim(), ANSWER_MAX);
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
      review_of: meta.reviewOf ?? null,
      verdict: meta.verdict ? `SPEC ${meta.verdict.spec.toUpperCase()} \xB7 QUALITY ${meta.verdict.quality.toUpperCase()}` : null,
      seconds,
      steps: u?.steps ?? null,
      tool_calls: u?.toolCalls ?? null,
      tokens: u?.total ?? null,
      returned_tokens: meta.returnedTokens ?? null,
      cost: u?.cost ?? null,
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
    where.push(q.state === "problem" ? "r.state IN ('failed','timeout','stopped')" : "r.state = ?");
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
    const page = q.beforeId ? `${base2 ? `${base2} AND` : "WHERE"} r.id < ?` : base2;
    const rows = db.prepare(`SELECT r.* FROM runs r ${page} ORDER BY r.id DESC LIMIT ?`).all(...args, ...q.beforeId ? [q.beforeId] : [], Math.min(Math.max(q.limit ?? 30, 1), 200));
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
function workerRows(rows, ledger) {
  const out = rows.map((r) => ({ backend: r.backend, model: r.model ?? void 0, runs: r.runs, ok: r.ok ?? 0, avgSeconds: r.avg_s, avgTokens: r.avg_t, saved: 0 }));
  const key = (backend, model) => `${backend ?? ""}\0${model ?? ""}`;
  const index = new Map(out.map((r) => [key(r.backend, r.model), r]));
  for (const e of ledger) {
    const backend = e.backend ?? "opencode";
    let row = index.get(key(backend, e.model)) ?? (e.model ? out.find((r) => r.backend === backend && r.model?.endsWith(`/${e.model}`)) : void 0);
    if (!row) {
      row = { backend, model: e.model, runs: 0, ok: 0, avgSeconds: null, avgTokens: null, saved: 0 };
      index.set(key(backend, e.model), row);
      out.push(row);
    }
    row.saved += e.saved;
  }
  return out;
}
function historyStats(sinceMs2) {
  const empty = { totals: { runs: 0, ok: 0, failed: 0, seconds: 0, tokens: 0, saved: 0 }, byWorker: [], byDay: [] };
  const db = openDb();
  if (!db) return empty;
  const since = sinceMs2 ? new Date(sinceMs2).toISOString() : "";
  try {
    const t = db.prepare("SELECT COUNT(*) runs, COALESCE(SUM(state='done'),0) ok, COALESCE(SUM(seconds),0) seconds, COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ?").get(since);
    const w = db.prepare("SELECT backend, model, COUNT(*) runs, SUM(state='done') ok, AVG(seconds) avg_s, AVG(tokens) avg_t, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? GROUP BY backend, model ORDER BY runs DESC LIMIT 40").all(since);
    const d = db.prepare("SELECT substr(started_at,1,10) day, COUNT(*) runs, SUM(state='done') ok, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? GROUP BY day ORDER BY day DESC LIMIT 60").all(since);
    const ledger = readLedger(sinceMs2);
    const byDay = /* @__PURE__ */ new Map();
    for (const e of ledger) byDay.set(e.at.slice(0, 10), (byDay.get(e.at.slice(0, 10)) ?? 0) + e.saved);
    return {
      totals: { runs: t.runs, ok: t.ok, failed: t.runs - t.ok, seconds: t.seconds, tokens: t.tokens, saved: totals(ledger).saved },
      byWorker: workerRows(w, ledger),
      byDay: d.reverse().map((r) => ({ day: r.day, runs: r.runs, ok: r.ok ?? 0, saved: byDay.get(r.day) ?? 0 }))
    };
  } catch {
    return empty;
  }
}

// src/core/report.ts
import fs14 from "node:fs";

// src/core/plan.ts
import fs13 from "node:fs";
import path11 from "node:path";
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
function parsePlan(text, file = "") {
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
  return { file, title: titleHeading?.text ?? "", header, constraints, tasks };
}
function loadPlan(file) {
  const abs = path11.resolve(file);
  if (!fs13.existsSync(abs) || !fs13.statSync(abs).isFile()) throw new UserError(`plan not found: ${file}`);
  const plan = parsePlan(fs13.readFileSync(abs, "utf8"), fs13.realpathSync(abs));
  if (!plan.tasks.length) throw new UserError(`${file} has no "Task N" headings (see pitroom-writing-plans)`);
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
var planName = (file) => path11.basename(file).replace(/\.md$/i, "");

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
  return fs14.existsSync(f) ? fs14.readFileSync(f, "utf8").trim() : archivedRun(meta.id)?.answer ?? "";
}
function formatReport(meta, finalText = readSummary(meta), maxLines = 400) {
  const out = [];
  out.push(`${bold("pitroom")} ${stateColour(meta.state, `${ICON2[meta.state]} ${meta.state}`)} \xB7 ${meta.mode} \xB7 ${duration(meta)} \xB7 run ${dim(meta.id)}`);
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
  for (const a of meta.attempts ?? []) out.push(`fallback: ${a.target} failed (${a.error.slice(0, 160)})`);
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
  if (meta.refs) {
    const r = meta.refs;
    const bad = r.invalid.slice(0, 8).map((i) => `${i.ref} (${i.reason})`).join(", ");
    out.push(`\u2500\u2500 refs: ${r.valid}/${r.total} verified${bad ? ` \xB7 bad: ${bad}` : ""}${r.invalid.length > 8 ? " \u2026" : ""}`);
  }
  const u = meta.usage;
  if (u && u.steps) {
    const ratio = meta.returnedTokens ? `, ${Math.max(1, Math.round(u.total / meta.returnedTokens))}\xD7 compression` : "";
    out.push(
      `\u2500\u2500 receipt: worker processed ${compact(u.total)} tokens in ${plural(u.steps, "step")} (${plural(u.toolCalls, "tool call")}${u.denied ? `, ${u.denied} blocked` : ""}) \xB7 worker cost ${u.cost === void 0 ? "n/a" : usd(u.cost)} \xB7 returned ~${compact(meta.returnedTokens ?? 0)} tokens${ratio}` + (meta.savedUsd !== void 0 ? ` \xB7 est. saved ${usd(meta.savedUsd)} vs ${primaryPrice().name}` : "")
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
    out.push(`\u2500\u2500 verify: \`${meta.verify}\` ${v.ok ? "\u2714 passed" : `\u2718 failed (exit ${v.code})`}`);
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
  if (!fs14.existsSync(f)) return { steps: 0, toolCalls: 0 };
  const p = getBackend((meta.ran ?? meta.worker).backend).parse(fs14.readFileSync(f, "utf8"));
  return { steps: p.usage.steps, toolCalls: p.usage.toolCalls, last: p.lastActivity };
}
function progress(meta) {
  if (meta.state === "queued") return `pitroom \u22EF queued \xB7 ${meta.mode} \xB7 waiting for a free worker slot \xB7 run ${meta.id}`;
  const l = live(meta);
  const last = l.last ? ` \xB7 last: ${l.last}` : "";
  return `pitroom \u2026 running \xB7 ${meta.mode} \xB7 ${duration(meta)} \xB7 ${l.steps} steps, ${l.toolCalls} tool calls${last} \xB7 run ${meta.id}`;
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

// src/core/install.ts
import fs15 from "node:fs";
import os8 from "node:os";
import path12 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var LEGACY = ["pitroom", "opencode-worker"];
function packageRoot() {
  return path12.resolve(path12.dirname(fileURLToPath2(import.meta.url)), "..");
}
function skillNames(root = packageRoot()) {
  const dir = path12.join(root, "skills");
  if (!fs15.existsSync(dir)) return [];
  return fs15.readdirSync(dir).filter((d) => fs15.existsSync(path12.join(dir, d, "SKILL.md"))).sort();
}
function skillTargets() {
  const home2 = os8.homedir();
  const targets = [path12.join(home2, ".agents", "skills")];
  if (fs15.existsSync(path12.join(home2, ".claude"))) targets.push(path12.join(home2, ".claude", "skills"));
  return targets;
}
var launcherPath = () => path12.join(os8.homedir(), ".local", "bin", "pitroom");
var LAUNCHER_MARK = "# pitroom launcher";
function launcherScript(bundle) {
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
function isOurLauncher(file, root) {
  if (linksInto(file, root)) return true;
  try {
    const s = fs15.readFileSync(file, "utf8");
    return s.includes(LAUNCHER_MARK) && s.includes(root);
  } catch {
    return false;
  }
}
function placeLauncher(bundle, root, force) {
  const dest = launcherPath();
  fs15.mkdirSync(path12.dirname(dest), { recursive: true });
  const exists = fs15.lstatSync(dest, { throwIfNoEntry: false });
  if (exists && !isOurLauncher(dest, root)) {
    if (!force) return `! ${dest} exists and is not Pitroom's launcher; kept (use --force to back it up and replace)`;
    fs15.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (exists) {
    fs15.rmSync(dest, { force: true });
  }
  fs15.writeFileSync(dest, launcherScript(bundle), { mode: 493 });
  return `\u2714 ${dest} \u2192 launcher for ${bundle} (Node 22.13+)`;
}
function linksInto(link, dir) {
  const st = fs15.lstatSync(link, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) return false;
  const target = path12.resolve(path12.dirname(link), fs15.readlinkSync(link));
  const rel = path12.relative(dir, target);
  return !rel.startsWith("..") && !path12.isAbsolute(rel);
}
function place(src, dest, opts) {
  fs15.mkdirSync(path12.dirname(dest), { recursive: true });
  const st = fs15.lstatSync(dest, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    if (!opts.force) return `! ${dest} exists and is not a link; kept (use --force to back it up and replace)`;
    fs15.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (st) {
    fs15.unlinkSync(dest);
  }
  if (opts.copy) fs15.cpSync(src, dest, { recursive: true });
  else fs15.symlinkSync(src, dest, process.platform === "win32" ? "junction" : fs15.statSync(src).isDirectory() ? "dir" : "file");
  return `\u2714 ${dest} \u2192 ${opts.copy ? "copied" : src}`;
}
function install(opts) {
  const root = packageRoot();
  const skills = skillNames(root);
  if (!skills.length) throw new Error(`no skills found under ${path12.join(root, "skills")}`);
  const out = [];
  for (const base2 of skillTargets()) {
    for (const legacy of LEGACY) {
      const l = path12.join(base2, legacy);
      if (!skills.includes(legacy) && linksInto(l, root)) {
        fs15.unlinkSync(l);
        out.push(`\u2714 removed old link ${l}`);
      }
    }
    for (const name of skills) out.push(place(path12.join(root, "skills", name), path12.join(base2, name), opts));
  }
  const bundle = path12.join(root, "dist", "pitroom.mjs");
  if (fs15.existsSync(bundle)) {
    out.push(placeLauncher(bundle, root, opts.force));
    const onPath = (process.env.PATH ?? "").split(path12.delimiter).some((d) => path12.resolve(d) === path12.dirname(launcherPath()));
    if (!onPath) out.push(`! ${path12.dirname(launcherPath())} is not on PATH; add it, or run ${launcherPath()} directly`);
  }
  return out;
}
function uninstall() {
  const root = packageRoot();
  const out = [];
  for (const base2 of skillTargets()) {
    if (!fs15.existsSync(base2)) continue;
    for (const name of fs15.readdirSync(base2)) {
      const l = path12.join(base2, name);
      if (linksInto(l, root)) {
        fs15.unlinkSync(l);
        out.push(`\u2714 removed ${l}`);
      }
    }
  }
  if (isOurLauncher(launcherPath(), root)) {
    fs15.rmSync(launcherPath(), { force: true });
    out.push(`\u2714 removed ${launcherPath()}`);
  }
  return out.length ? out : ["nothing to remove"];
}
function installedSkills() {
  const names = skillNames();
  return skillTargets().map((base2) => ({ base: base2, names: names.filter((n) => fs15.existsSync(path12.join(base2, n, "SKILL.md"))) }));
}

// src/core/plan-status.ts
import crypto2 from "node:crypto";
import fs16 from "node:fs";
import path13 from "node:path";
function notesFile(plan) {
  const id = crypto2.createHash("sha1").update(plan.file).digest("hex").slice(0, 12);
  return path13.join(home(), "plans", id, "notes.md");
}
function readNotes(plan) {
  const f = notesFile(plan);
  if (!fs16.existsSync(f)) return [];
  return fs16.readFileSync(f, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (.*)$/.exec(l);
    return m ? { at: m[1], text: m[2] } : { at: "", text: l };
  });
}
function addNote(planFile, text) {
  const plan = loadPlan(planFile);
  const f = notesFile(plan);
  fs16.mkdirSync(path13.dirname(f), { recursive: true });
  if (!fs16.existsSync(f)) fs16.writeFileSync(f, `# plan: ${plan.file}
`);
  const at = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ");
  fs16.appendFileSync(f, `${at} ${text.replace(/\s+/g, " ").trim()}
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

// src/core/review.ts
import crypto4 from "node:crypto";
import fs18 from "node:fs";
import path15 from "node:path";

// src/vcs/git.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import crypto3 from "node:crypto";
import fs17 from "node:fs";
import os9 from "node:os";
import path14 from "node:path";
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
function repoRoot(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? path14.resolve(r.stdout.trim()) : void 0;
}
function snapshotTree(root, exclude = []) {
  const tmp = path14.join(os9.tmpdir(), `pitroom-index-${process.pid}-${crypto3.randomBytes(4).toString("hex")}`);
  const real = path14.resolve(root, must(root, ["rev-parse", "--git-path", "index"]).trim());
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    if (fs17.existsSync(real)) fs17.copyFileSync(real, tmp);
    else must(root, ["read-tree", "--empty"], env);
    must(root, ["add", "-A", "--", ":/", ...exclude.map((p) => `:(top,exclude)${p}`)], env);
    return must(root, ["write-tree"], env).trim();
  } finally {
    fs17.rmSync(tmp, { force: true });
    fs17.rmSync(`${tmp}.lock`, { force: true });
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
  const objects = path14.join(path14.resolve(root, must(root, ["rev-parse", "--git-common-dir"]).trim()), "objects");
  fs17.mkdirSync(path14.dirname(dest), { recursive: true });
  must(path14.dirname(dest), ["init", "--quiet", dest]);
  fs17.writeFileSync(path14.join(dest, ".git", "objects", "info", "alternates"), `${objects}
`);
  must(dest, ["read-tree", tree]);
  must(dest, ["checkout-index", "--all", "--force"]);
}
function removeIsolatedCopy(dest, ownedBy) {
  const rel = path14.relative(ownedBy, dest);
  if (!rel || rel.startsWith("..") || path14.isAbsolute(rel)) throw new Error(`refusing to remove ${dest}`);
  fs17.rmSync(dest, { recursive: true, force: true });
}
function linkIntoWorktree(root, worktree, rels) {
  const linked = [];
  for (const rel of rels) {
    const src = path14.join(root, rel);
    const dst = path14.join(worktree, rel);
    if (!fs17.existsSync(src) || fs17.existsSync(dst)) continue;
    fs17.mkdirSync(path14.dirname(dst), { recursive: true });
    fs17.symlinkSync(src, dst, process.platform === "win32" ? "junction" : void 0);
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
  const log = must(root, ["log", "--oneline", "--no-decorate", range]).trim();
  return [
    `## COMMITS

${log || "(none)"}`,
    `## FILES CHANGED

${must(root, [...DIFF, "--stat", range]).trim() || "(none)"}`,
    `## DIFF

${must(root, [...DIFF, "-U10", range])}`
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

// src/core/review.ts
var TEMPLATE = { task: "task-reviewer", fix: "re-review", range: "code-reviewer" };
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
  return fs18.existsSync(f) ? fs18.readFileSync(f, "utf8") : root.task;
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
  if (where && fs18.existsSync(where) && from && m.afterTree) return reviewDiff(where, from, m.afterTree);
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
  const dir = m.mode === "isolate" && m.worktree && fs18.existsSync(m.worktree) ? m.cwd : m.dir;
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
  if (!g) throw new UserError(`not a git repository: ${job.dir}`);
  const file = path15.join(g, "pitroom", `review-${crypto4.randomBytes(4).toString("hex")}.md`);
  fs18.mkdirSync(path15.dirname(file), { recursive: true });
  fs18.writeFileSync(file, job.package);
  return file;
}

// src/core/templates.ts
import fs19 from "node:fs";
import path16 from "node:path";
var FILES = {
  implementer: "pitroom-driven-development/implementer-prompt.md",
  "task-reviewer": "pitroom-driven-development/task-reviewer-prompt.md",
  "re-review": "pitroom-driven-development/re-review-prompt.md",
  "code-reviewer": "pitroom-review/code-reviewer.md"
};
function loadTemplate(name, root = packageRoot()) {
  const file = path16.join(root, "skills", FILES[name]);
  if (!fs19.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs19.readFileSync(file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}
function fill(template, values) {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in values));
  if (missing.length) throw new UserError(`no value for template placeholder(s): ${[...new Set(missing)].join(", ")}`, 3);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key]);
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

// src/core/dash.ts
import { spawn } from "node:child_process";
import crypto5 from "node:crypto";
import fs20 from "node:fs";
import http from "node:http";
import path17 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/core/file-diff.ts
var PREVIEW_LINES = 300;
function gitPath(value, prefix = true) {
  let path25 = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes = [];
    const escapes = { t: "	", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v" };
    for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
      if (match[1] && /^[0-7]+$/.test(match[1])) bytes.push(parseInt(match[1], 8));
      else bytes.push(...new TextEncoder().encode(match[2] ?? escapes[match[1]] ?? match[1]));
    }
    path25 = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return prefix ? path25.replace(/^[ab]\//, "") : path25;
}
function headerPath(header) {
  const quoted = header.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return gitPath(quoted[2]);
  return gitPath(header.slice(header.lastIndexOf(" b/") + 1));
}
function fileDiffs(patch, changes, sourceTruncated = false) {
  const files = [];
  let file;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  let row = 0;
  const finishHunk = () => {
    if (file && (oldLeft > 0 || newLeft > 0)) file.incomplete = true;
    oldLeft = newLeft = 0;
    inHunk = false;
  };
  const add = (line) => {
    if (!file) return;
    if (file.lines.length < PREVIEW_LINES) file.lines.push({ ...line, id: String(row) });
    else file.omittedLines++;
    row++;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      file = { path: headerPath(line), status: "M", lines: [], additions: 0, deletions: 0, omittedLines: 0, binary: false, incomplete: false };
      files.push(file);
      row = 0;
      continue;
    }
    if (!file) continue;
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
        file.additions++;
        newLeft--;
        add({ type: "added", newLine: newLine++, content: line.slice(1) });
      } else if (line.startsWith("-") && oldLeft > 0) {
        file.deletions++;
        oldLeft--;
        add({ type: "removed", oldLine: oldLine++, content: line.slice(1) });
      } else if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        add({ type: "context", oldLine: oldLine++, newLine: newLine++, content: line.slice(1) });
      } else {
        file.incomplete = true;
      }
    } else if (!inHunk) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = gitPath(line.slice(4).replace(/\t$/, ""));
      else if (line.startsWith("--- ") && line !== "--- /dev/null") file.path = gitPath(line.slice(4).replace(/\t$/, ""));
      else if (/^(GIT binary patch|Binary files .* differ)$/.test(line)) file.binary = true;
      else if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|similarity index) /.test(line)) {
        if (line.startsWith("new file mode ")) file.status = "A";
        if (line.startsWith("deleted file mode ")) file.status = "D";
        if (line.startsWith("rename to ")) {
          file.path = gitPath(line.slice(10), false);
          file.status = "R";
        }
        add({ type: "meta", content: line });
      }
    }
  }
  finishHunk();
  if (sourceTruncated && file) file.incomplete = true;
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
var PAGE = `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Pitroom</title><link rel="icon" href="${ICON3}">
<script>${THEME_SCRIPT}</script><link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;
var MISSING = `<!doctype html><meta charset="utf-8"><title>Pitroom</title><body style="font:15px system-ui;padding:3rem;max-width:40rem;margin:auto"><h1>Pitroom dash</h1><p>The dashboard files are missing (dist/ui). Run <code>npm run build</code> in the Pitroom repository, or reinstall the package.</p></body>`;

// src/core/dash.ts
var DEFAULT_PORT = 7878;
var WEEK_MS2 = 7 * 24 * 3600 * 1e3;
var SCAN = 400;
var RUN_ID2 = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
var LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;
var oneLine6 = (s, max) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
function findings(m) {
  const v = m.verdict;
  if (!v) return "";
  const parts = [v.critical && `${v.critical} critical`, v.important && `${v.important} important`, v.minor && `${v.minor} minor`].filter(Boolean);
  return parts.length ? parts.join(" \xB7 ") : "no findings";
}
function toRun(m) {
  const l = m.state === "running" ? live(m) : void 0;
  return {
    id: m.id,
    state: m.state,
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
    verdict: m.verdict ? `SPEC ${m.verdict.spec.toUpperCase()} \xB7 QUALITY ${m.verdict.quality.toUpperCase()}` : void 0,
    changes: m.changes?.length || void 0,
    applied: m.applied || void 0,
    note: l?.last ? oneLine6(String(l.last), 140) : isActive(m.state) ? "" : m.verdict ? findings(m) : headline(m, 200) || oneLine6(m.error ?? "", 200)
  };
}
function dashState(opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const runs = [];
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
    if (runs.length < limit) runs.push(toRun(m));
  }
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
  if (!RUN_ID2.test(id)) return void 0;
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
    task: (m.reviewOf ? `Review of ${m.reviewOf.replace(/\b([0-9a-f]{9})[0-9a-f]{31}\b/g, "$1")}` : m.task).slice(0, TASK_MAX),
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
      cost: u?.cost,
      saved: m.savedUsd,
      group: m.group,
      directory: m.dir
    },
    attempts: m.attempts ?? [],
    warnings: m.warnings ?? [],
    refs: m.refs ? { valid: m.refs.valid, total: m.refs.total, invalid: m.refs.invalid.map((r) => `${r.ref} (${r.reason})`) } : void 0,
    verify: m.verifyResult && m.verify ? { command: m.verify, ok: m.verifyResult.ok, tail: m.verifyResult.tail } : void 0,
    error: m.error,
    report: isActive(m.state) ? progress(m) : formatReport(m, void 0, 120)
  };
}
var HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Own files only, plus the hash of the one inline theme script; styles may be inline (the components position popups with them).
  "content-security-policy": `default-src 'none'; script-src 'self' 'sha256-${crypto5.createHash("sha256").update(THEME_SCRIPT).digest("base64")}'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'`
};
var ASSETS = { "/assets/app.js": "text/javascript; charset=utf-8", "/assets/app.css": "text/css; charset=utf-8" };
var assetsDir = () => fileURLToPath3(new URL("./ui/", import.meta.url));
var assetCache = /* @__PURE__ */ new Map();
function readAsset(route) {
  try {
    const file = path17.join(assetsDir(), path17.basename(route));
    const { mtimeMs } = fs20.statSync(file);
    const hit = assetCache.get(route);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    const data = fs20.readFileSync(file);
    assetCache.set(route, { mtimeMs, data });
    return data;
  } catch {
    return void 0;
  }
}
function handler(touch) {
  const send = (res, code, type, body) => {
    res.writeHead(code, { ...HEADERS, "content-type": type });
    res.end(body);
  };
  const json = (res, code, value) => send(res, code, "application/json; charset=utf-8", JSON.stringify(value));
  return (req, res) => {
    touch();
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read-only" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", readAsset("/assets/app.js") ? PAGE : MISSING);
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
      const days = Number(q.get("days") ?? 0);
      return json(res, 200, listHistory({
        text: (q.get("q") ?? "").slice(0, 200),
        model: q.get("model") || void 0,
        backend: q.get("backend") || void 0,
        state: q.get("state") || void 0,
        group: q.get("group") || void 0,
        sinceMs: days > 0 ? Date.now() - days * 864e5 : void 0,
        beforeId: RUN_ID2.test(q.get("before") ?? "") ? q.get("before") : void 0,
        limit: Number(q.get("limit") ?? 30) || 30
      }));
    }
    if (url.pathname === "/api/stats") {
      const days = Number(url.searchParams.get("days") ?? 30);
      return json(res, 200, { ...historyStats(days > 0 ? Date.now() - days * 864e5 : void 0), price: primaryPrice().name });
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
  const server = http.createServer(handler(() => lastRequest = Date.now()));
  return new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const port = server.address().port;
      let done;
      const closed = new Promise((r) => done = r);
      let timer;
      const close = () => {
        if (timer) clearInterval(timer);
        server.closeAllConnections?.();
        return new Promise((r) => server.close(() => (done(), r())));
      };
      if (opts.idleMs && opts.idleMs > 0) {
        timer = setInterval(() => Date.now() - lastRequest > opts.idleMs && void close(), Math.min(6e4, opts.idleMs));
        timer.unref();
      }
      resolve2({ port, url: `http://127.0.0.1:${port}/`, closed, close });
    });
  });
}
var registryFile = () => path17.join(home(), "dash.json");
async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state?limit=1`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
async function runningDash() {
  try {
    const r = JSON.parse(fs20.readFileSync(registryFile(), "utf8"));
    if (isAlive(r.pid) && await ping(r.port)) return { ...r, url: `http://127.0.0.1:${r.port}/` };
  } catch {
  }
  fs20.rmSync(registryFile(), { force: true });
  return void 0;
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => void 0).unref();
  } catch {
  }
}
async function dashCommand(o) {
  const existing = await runningDash();
  if (o.stop) {
    if (!existing) throw new UserError("pitroom dash is not running");
    process.kill(existing.pid, "SIGTERM");
    fs20.rmSync(registryFile(), { force: true });
    o.log(`stopped pitroom dash (${existing.url})`);
    return 0;
  }
  if (existing && !o.serve) {
    o.log(existing.url);
    if (o.open) openBrowser(existing.url);
    return 0;
  }
  if (o.detach) {
    const child = spawn(process.execPath, [process.argv[1], "dash", "--serve", ...o.port !== void 0 ? ["--port", String(o.port)] : [], "--idle", "1h"], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.on("error", () => void 0);
    child.unref();
    for (let i = 0; i < 60; i++) {
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
  fs20.mkdirSync(home(), { recursive: true });
  fs20.writeFileSync(registryFile(), JSON.stringify({ pid: process.pid, port: dash.port }));
  const stop = () => void dash.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!o.serve) o.log(`${dash.url}
(read-only, this machine only; Ctrl-C stops it)`);
  if (o.open) openBrowser(dash.url);
  await dash.closed;
  try {
    if (JSON.parse(fs20.readFileSync(registryFile(), "utf8")).pid === process.pid) fs20.rmSync(registryFile(), { force: true });
  } catch {
  }
  return 0;
}

// src/core/run.ts
import { spawn as spawn3, spawnSync as spawnSync6 } from "node:child_process";
import fs26 from "node:fs";
import path22 from "node:path";

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
import { spawn as spawn2 } from "node:child_process";
import fs22 from "node:fs";

// src/vcs/guard.ts
import fs21 from "node:fs";
import path18 from "node:path";
var VERSION = 1;
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
  return path18.join(home(), "shim", `v${VERSION}`);
}
function findRealGit(skip) {
  for (const dir of (process.env.PATH ?? "").split(path18.delimiter).filter(Boolean)) {
    if (path18.resolve(dir) === skip) continue;
    const p = path18.join(dir, "git");
    try {
      fs21.accessSync(p, fs21.constants.X_OK);
      if (fs21.statSync(p).isFile()) return p;
    } catch {
    }
  }
  return void 0;
}
var HOOK_VERSION = 1;
var REF_HOOK = `#!/bin/sh
# pitroom git guard (layer 2, v${HOOK_VERSION}): refuse ref updates made by workers.
[ "$1" = prepared ] || exit 0
echo "pitroom: git ref updates (commit, reset, branch, tag, stash, rebase, merge) are blocked for workers" >&2
exit 1
`;
var hooksDir = () => path18.join(home(), "git-hooks", `v${HOOK_VERSION}`);
function writeIfChanged(file, content) {
  if (fs21.existsSync(file) && fs21.readFileSync(file, "utf8") === content) return;
  fs21.mkdirSync(path18.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs21.writeFileSync(tmp, content, { mode: 493 });
  fs21.renameSync(tmp, file);
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
  if (process.platform === "win32") return { ...env, ...quiet };
  writeIfChanged(path18.join(hooksDir(), "reference-transaction"), REF_HOOK);
  env = withGitConfig(env, [
    ["core.hooksPath", hooksDir()],
    ["url.pitroom-push-blocked://.pushInsteadOf", ""]
  ]);
  const dir = shimDir();
  const real = findRealGit(dir);
  if (!real) return { ...env, ...quiet };
  writeIfChanged(path18.join(dir, "git"), SHIM);
  return { ...env, ...quiet, PITROOM_REAL_GIT: real, PATH: `${dir}${path18.delimiter}${env.PATH ?? ""}` };
}

// src/core/process.ts
async function spawnWorker(inv, opts) {
  const out = fs22.openSync(opts.stdoutFile, "w");
  const err = fs22.openSync(opts.stderrFile, "w");
  const res = { code: null, timedOut: false, stopped: false };
  const child = spawn2(inv.command, inv.args, {
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
  const timer = setTimeout(() => {
    res.timedOut = true;
    child.kill("SIGTERM");
    killer = setTimeout(() => child.kill("SIGKILL"), 1e4);
  }, opts.timeoutSec * 1e3);
  res.code = await new Promise((resolve2) => {
    child.on("error", (e) => {
      res.spawnError = e.code === "ENOENT" ? `${inv.command} not found` : e.message;
      resolve2(127);
    });
    child.on("close", (c) => resolve2(c));
  });
  clearTimeout(timer);
  if (killer) clearTimeout(killer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  fs22.closeSync(out);
  fs22.closeSync(err);
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

// src/core/slots.ts
import crypto6 from "node:crypto";
import fs23 from "node:fs";
import path19 from "node:path";
var slotsDir = () => path19.join(home(), "slots");
var locksDir = () => path19.join(home(), "locks");
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
function tryClaim(file, runId) {
  fs23.mkdirSync(path19.dirname(file), { recursive: true });
  try {
    fs23.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let owner = "";
  try {
    owner = fs23.readFileSync(file, "utf8").trim();
  } catch {
  }
  if (owner === runId) return true;
  if (holderActive(owner, runId)) return false;
  fs23.rmSync(file, { force: true });
  try {
    fs23.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseIfOwner(file, runId) {
  if (!file) return;
  try {
    if (fs23.readFileSync(file, "utf8").trim() === runId) fs23.rmSync(file, { force: true });
  } catch {
  }
}
function tryAcquireSlot(runId, maxParallel) {
  for (let n = 0; n < Math.max(1, maxParallel); n++) {
    const file = path19.join(slotsDir(), `slot-${n}`);
    if (tryClaim(file, runId)) return file;
  }
  return void 0;
}
var releaseSlot = (file, runId) => releaseIfOwner(file, runId);
var lockFile = (repoRoot2) => path19.join(locksDir(), `write-${crypto6.createHash("sha1").update(path19.resolve(repoRoot2)).digest("hex").slice(0, 16)}`);
function acquireWriteLock(repoRoot2, runId) {
  const file = lockFile(repoRoot2);
  if (tryClaim(file, runId)) return;
  let owner = "";
  try {
    owner = fs23.readFileSync(file, "utf8").trim();
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
import fs24 from "node:fs";
import path20 from "node:path";
var FILE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rst py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs fs php lua r jl sh bash zsh fish ps1 bat yml yaml toml ini cfg conf env html htm css scss sass less vue svelte astro sql graphql gql proto lock xml svg csv tsv gradle tf hcl dart ex exs erl hs ml scala clj vim el mk cmake dockerfile gitignore gitattributes editorconfig npmrc nvmrc".split(" ")
);
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache"]);
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
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path20.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file) => {
    if (!lineCache.has(file)) {
      const size = fs24.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs24.readFileSync(file, "utf8").split("\n");
      if (lines && lines[lines.length - 1] === "") lines.pop();
      lineCache.set(file, lines);
    }
    return lineCache.get(file);
  };
  let index;
  const byName = () => index ??= indexFiles(roots);
  const candidates = (ref) => {
    const direct = resolve(ref.file, roots);
    if (direct) return [direct];
    if (path20.isAbsolute(ref.file)) return [];
    const wanted = ref.file.replace(/^(\.{1,2}\/)+/, "");
    return (byName().get(path20.basename(wanted)) ?? []).filter((f) => f.endsWith(`/${wanted}`) || path20.basename(f) === wanted).slice(0, 20);
  };
  const check = (file, ref) => {
    const lines = load(file);
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
      invalid.push({ ref: ref.text, reason: path20.isAbsolute(ref.file) && !inside(ref.file, roots) ? "outside the project" : "file not found" });
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
  const base2 = path20.basename(name);
  return !base2.includes(".") || new RegExp(`^(${EXTENSIONLESS})$`).test(base2) || FILE_EXTENSIONS.has(base2.split(".").pop().toLowerCase());
};
function indexFiles(roots) {
  const index = /* @__PURE__ */ new Map();
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs24.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_INDEXED) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path20.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
        const list2 = index.get(e.name);
        if (list2) list2.push(path20.join(dir, e.name));
        else index.set(e.name, [path20.join(dir, e.name)]);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}
function resolve(ref, roots) {
  const candidates = path20.isAbsolute(ref) ? inside(ref, roots) ? [ref] : [] : roots.map((r) => path20.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs24.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}
function inside(file, roots) {
  return roots.some((r) => {
    const rel = path20.relative(r, path20.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path20.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// src/core/secrets.ts
import { execFileSync } from "node:child_process";
import fs25 from "node:fs";
import path21 from "node:path";
var SKIP_DIRS2 = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache"]);
var MAX_VISITED = 2e4;
var MAX_DEPTH = 4;
var TEMPLATE2 = /\.(example|sample|template|dist|defaults?|tpl)$/i;
function looksSecret(name) {
  if (name === ".env" || name.startsWith(".env.") && !TEMPLATE2.test(name)) return true;
  return /\.(pem|p12|pfx)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || name === ".netrc" || name === "credentials.json";
}
function findSecretFiles(dir) {
  const found = [];
  let visited = 0;
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries;
    try {
      entries = fs25.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS2.has(e.name)) walk(path21.join(d, e.name), depth + 1);
      } else if (e.isFile() && looksSecret(e.name)) {
        found.push(path21.relative(dir, path21.join(d, e.name)));
      }
    }
  };
  walk(dir, 0);
  return found.sort();
}
function findSecretFilesInTree(root, dir) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return out.split("\0").filter((f) => f && looksSecret(path21.basename(f)) && !path21.relative(dir, path21.join(root, f)).startsWith("..")).map((f) => path21.relative(dir, path21.join(root, f))).sort();
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

// src/core/run.ts
var VERSION2 = true ? "0.8.1" : "0.0.0-dev";
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
    if (parent.mode === "isolate" && (!parent.worktree || !fs26.existsSync(parent.worktree))) {
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
  const dir = path22.resolve(parent?.dir ?? o.dir);
  if (!fs26.existsSync(dir) || !fs26.statSync(dir).isDirectory()) throw new UserError(`not a directory: ${dir}`);
  const root = repoRoot(dir);
  if (mode === "isolate" && !root) throw new UserError("--isolate needs a git repository", 3);
  if (mode === "write" && !root && !o.allowNonGit) {
    throw new UserError("--write outside a git repo cannot be tracked or reverted; pass --allow-non-git to accept that", 3);
  }
  const files = o.files.map((f) => path22.resolve(f));
  for (const f of files) if (!fs26.existsSync(f)) throw new UserError(`file not found: ${f}`);
  if (!parent && !process.env.PITROOM_NO_SECRET_WARNING) {
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
    plan: work.plan ?? o.review?.plan ?? parent?.plan,
    reviewKind: o.review?.kind,
    packageFile: o.review?.packageFile
  };
  writeMeta(meta);
  if (mode === "write" && root) {
    try {
      acquireWriteLock(root, meta.id);
    } catch (e) {
      fs26.rmSync(runDir(meta.id), { recursive: true, force: true });
      throw e;
    }
  }
  fs26.writeFileSync(runFile(meta.id, "task.md"), `${meta.task}
`);
  if (work.brief) fs26.writeFileSync(runFile(meta.id, "brief.md"), work.brief);
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
  const child = spawn3(process.execPath, [script, "__exec", meta.id], {
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
      meta.ran = target;
      writeMeta(meta);
      result = await attempt(meta, backend, target);
      if (result.timedOut || result.stopped || result.spawnError) break;
      const why = retryableFailure(meta, backend, result);
      if (!why) break;
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
        if (fs26.existsSync(from)) fs26.renameSync(from, runFile(meta.id, f.replace(".", `.attempt-${i + 1}.`)));
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
  return finalize(meta, result);
}
function prepareTree(meta) {
  const root = meta.repoRoot;
  if (root && meta.mode === "write") meta.baseTree = snapshotTree(root);
  if (root && meta.mode === "isolate" && !meta.worktree) {
    meta.baseTree = snapshotTree(root);
    meta.worktree = path22.join(worktreesDir(), meta.id);
    createIsolatedCopy(root, meta.baseTree, meta.worktree);
    meta.cwd = path22.join(meta.worktree, path22.relative(root, meta.dir));
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
var read = (f) => fs26.existsSync(f) ? fs26.readFileSync(f, "utf8") : "";
function retryableFailure(meta, backend, res) {
  const run = backend.parse(read(runFile(meta.id, "events.jsonl")));
  if (run.usage.steps > 0) return void 0;
  const f = backend.failure(run, read(runFile(meta.id, "stderr.log")), res.code);
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
  const run = backend.parse(read(runFile(meta.id, "events.jsonl")));
  meta.sessionId = run.sessionId ?? meta.sessionId;
  meta.usage = run.usage;
  fs26.writeFileSync(runFile(meta.id, "summary.md"), `${run.finalText}
`);
  if (meta.plan && !meta.reviewOf) meta.taskStatus = parseStatus(run.finalText);
  if (meta.reviewOf) {
    meta.verdict = parseVerdict(run.finalText);
    if (meta.packageFile) fs26.rmSync(meta.packageFile, { force: true });
  }
  if (!res.timedOut && !res.stopped && !meta.error) {
    const f = backend.failure(run, read(runFile(meta.id, "stderr.log")), res.code);
    if (f) meta.error = HINTS[f.kind] ? `${f.message} (${HINTS[f.kind]})` : f.message;
  }
  try {
    captureChanges(meta);
  } catch (e) {
    meta.warnings.push(`could not compute changes: ${e.message}`);
  }
  if (meta.mode === "read" && run.edits.length) {
    meta.warnings.push(`READ-ONLY VIOLATION: worker modified ${[...new Set(run.edits)].join(", ")}`);
  }
  if (meta.sessionId && backend.resolveModel) meta.resolvedModel = backend.resolveModel(meta.sessionId);
  meta.resolvedModel ??= run.model ?? ran.model;
  const refs = extractRefs(run.finalText);
  if (refs.length) {
    meta.refs = verifyRefs(refs, [meta.cwd, meta.repoRoot ?? "", meta.dir]);
    if (meta.refs.invalid.length) {
      meta.warnings.push(`${meta.refs.invalid.length} of ${meta.refs.total} file references in the answer did not check out`);
    }
  }
  meta.state = res.timedOut ? "timeout" : res.stopped ? "stopped" : meta.error ? "failed" : "done";
  if (meta.state === "done" && !run.finalText) meta.warnings.push("worker finished without a written answer");
  if (meta.state === "done" && meta.verify) meta.verifyResult = runVerify(meta);
  meta.endedAt = (/* @__PURE__ */ new Date()).toISOString();
  meta.returnedTokens = estimateTokens(formatReport(meta, run.finalText));
  meta.savedUsd = savedUsd(meta.usage, meta.returnedTokens);
  writeMeta(meta);
  if (meta.mode === "write" && meta.repoRoot) releaseWriteLock(meta.repoRoot, meta.id);
  record(meta);
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
  fs26.writeFileSync(runFile(meta.id, "changes.patch"), d.patch);
}
function runVerify(meta) {
  const r = spawnSync6(meta.verify, {
    cwd: meta.cwd,
    shell: true,
    encoding: "utf8",
    timeout: 15 * 6e4,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PWD: meta.cwd, PITROOM_ACTIVE: "1" }
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  fs26.writeFileSync(runFile(meta.id, "verify.log"), output);
  return { ok: r.status === 0, code: r.status, tail: output.trimEnd().split("\n").slice(-25).join("\n") };
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
function discardRun(meta) {
  if (meta.mode !== "isolate") throw new UserError("only --isolate runs have an isolated copy to discard");
  cleanupWorktree(meta);
  meta.discarded = true;
  writeMeta(meta);
  return `discarded the isolated copy of ${meta.id}; the patch stays in ${runFile(meta.id, "changes.patch")}`;
}
function cleanupWorktree(meta) {
  if (meta.worktree && fs26.existsSync(meta.worktree)) removeIsolatedCopy(meta.worktree, worktreesDir());
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
  return launch(p, prepareRun(opts));
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
      ...runOptions(p, fill(loadTemplate(TEMPLATE[job.kind]), { PACKAGE_FILE: packageFile })),
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
    fs27.rmSync(packageFile, { force: true });
    throw e;
  }
  fs27.writeFileSync(runFile(meta.id, "package.md"), job.package);
  return launch(p, meta);
}
function cmdPlan(p) {
  const [sub, file, ...rest] = p.positional;
  if (sub === "status" && file) {
    const s = planStatus(file);
    console.log(
      has(p, "json") ? JSON.stringify({ plan: s.plan.file, title: s.plan.title, tasks: s.tasks, rulings: s.rulings, notesFile: s.notesFile }, null, 2) : formatPlanStatus(s)
    );
    return 0;
  }
  if (sub === "note" && file && rest.length) {
    console.log(`noted in ${addNote(file, rest.join(" "))}`);
    return 0;
  }
  throw new UserError('usage: pitroom plan status PLAN.md [--json] | pitroom plan note PLAN.md "Task N: \u2026"');
}
function cmdCrew(p) {
  const file = flag(p, "task-file");
  const tasks = (file ? fs27.readFileSync(file, "utf8").split(/^\s*---\s*$/m) : p.positional).map((t) => t.trim()).filter(Boolean);
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
  const since = sinceMs(flag(p, "since"));
  if (sub === "stats") {
    const s = historyStats(since);
    if (has(p, "json")) return console.log(JSON.stringify(s, null, 2)), 0;
    const t = s.totals;
    console.log(`${t.runs} runs \xB7 ${t.ok} ok \xB7 ${t.failed} not ok \xB7 ${secs(t.seconds)} of worker time \xB7 ${(t.tokens / 1e6).toFixed(1)}M tokens \xB7 ~${usd(t.saved)} saved`);
    const rows2 = s.byWorker.map((w) => [`${w.backend}${w.model ? `:${w.model}` : ""}`, String(w.runs), w.runs ? `${Math.round(100 * w.ok / w.runs)}%` : "-", secs(w.avgSeconds), w.avgTokens ? `${Math.round(w.avgTokens / 1e3)}k` : "-", `~${usd(w.saved)}`]);
    const head2 = ["WORKER", "RUNS", "OK", "AVG TIME", "AVG TOKENS", "SAVED"];
    const widths2 = head2.map((h, i) => Math.max(h.length, ...rows2.map((r) => r[i].length)));
    const fmt2 = (r) => r.map((c, i) => i === 0 ? c.padEnd(widths2[i]) : c.padStart(widths2[i])).join("  ");
    if (rows2.length) console.log(`
${[fmt2(head2), ...rows2.map(fmt2)].join("\n")}`);
    return 0;
  }
  const limit = flag(p, "limit") ? Number(flag(p, "limit")) : 20;
  const { rows, total } = listHistory({ text: p.positional.join(" "), model: flag(p, "model"), state: flag(p, "state"), group: flag(p, "group"), sinceMs: since, limit });
  if (has(p, "json")) return console.log(JSON.stringify({ total, rows }, null, 2)), 0;
  if (!rows.length) return console.log(total ? "nothing on this page" : "no matching runs"), 0;
  const body = rows.map((r) => [r.id, when(r.startedAt), r.state, `${r.backend}${r.model ? ` (${r.model.split("/").pop()})` : ""}`, secs(r.seconds), r.task.length > 60 ? `${r.task.slice(0, 59)}\u2026` : r.task]);
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
    const meta = freshMeta(id);
    if (!isActive(meta.state) || !isAlive(meta.pid)) continue;
    process.kill(meta.pid, "SIGTERM");
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
var readStdin = () => process.stdin.isTTY ? "" : fs27.readFileSync(0, "utf8");
function cmdStatusline(p) {
  const input = readStdin();
  const lines = [];
  const then = flag(p, "then");
  if (then) {
    const r = spawnSync7("/bin/sh", ["-c", then], { input, encoding: "utf8", timeout: 5e3 });
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
  const script = path23.join(path23.dirname(path23.dirname(fileURLToPath4(import.meta.url))), "hooks", "session-start.mjs");
  if (fs27.existsSync(script)) spawnSync7(process.execPath, [script], { stdio: ["ignore", "inherit", "ignore"], env: process.env });
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
  const since = flag(p, "since") ?? "all";
  const t = totals(readLedger(sinceMs(since)));
  if (has(p, "models")) {
    const by = /* @__PURE__ */ new Map();
    for (const e of readLedger(sinceMs(since))) {
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
  const period = since === "all" ? "all time" : `last ${since.replace("d", " days")}`;
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
    fs27.writeFileSync(out, card(t, period));
    console.log(`card written to ${path23.resolve(out)}`);
  }
  if (has(p, "badge")) console.log(`![pitroom](${badgeUrl(t)})`);
  return 0;
}
function cmdInstall(p) {
  for (const line of install({ copy: has(p, "copy"), force: has(p, "force") })) console.log(line);
  return 0;
}
function cmdUninstall() {
  for (const line of uninstall()) console.log(line);
  return 0;
}
function cmdConfig(p) {
  const { warnings } = loadConfig();
  const eff = effective();
  if (has(p, "json")) {
    console.log(JSON.stringify({ path: configPath(), settings: eff, warnings }, null, 2));
    return 0;
  }
  console.log(`config file: ${configPath()}${fs27.existsSync(configPath()) ? "" : " (not present)"}`);
  for (const [key, s] of Object.entries(eff)) {
    const v = Array.isArray(s.value) ? s.value.join(", ") || "\u2014" : s.value && typeof s.value === "object" ? Object.entries(s.value).map(([k, m]) => `${k}=${m}`).join(", ") || "\u2014" : s.value === void 0 ? key === "model" ? "the worker's default" : "\u2014" : String(s.value);
    console.log(`  ${key.padEnd(15)} ${v}  (${s.source})`);
  }
  for (const w of warnings) console.log(`! ${w}`);
  return 0;
}
function cmdClean(p) {
  const days = Number(flag(p, "days") ?? 14);
  const cutoff = Date.now() - days * 864e5;
  const old = listRunIds().filter((id) => {
    const m = freshMeta(id);
    const pendingPatch = m.mode === "isolate" && !m.applied && !m.discarded && m.changes?.length;
    return TERMINAL.includes(m.state) && Date.parse(m.startedAt) < cutoff && !pendingPatch;
  });
  if (!has(p, "yes")) {
    console.log(`${old.length} run(s) older than ${days} days would be removed (unapplied isolate patches are kept). Re-run with --yes.`);
    return 0;
  }
  for (const id of old) {
    const m = readMeta(id);
    if (m.mode === "isolate" && !m.discarded && !m.applied) discardRun(m);
    recordRun(m);
    fs27.rmSync(runDir(id), { recursive: true, force: true });
  }
  console.log(`removed ${old.length} run(s); the history and the savings ledger are kept`);
  return 0;
}
var cmdRevert = (p) => (console.log(revertRun(freshMeta(resolveRun(p.positional[0])))), 0);
var cmdDiscard = (p) => (console.log(discardRun(freshMeta(resolveRun(p.positional[0])))), 0);

// src/core/doctor.ts
import { spawnSync as spawnSync8 } from "node:child_process";
import fs28 from "node:fs";
import os10 from "node:os";
import path24 from "node:path";
var MARK = { ok: () => green("\u2714"), warn: () => yellow("!"), fail: () => red("\u2718") };
var NEXT = [
  { when: /no default model|no fallback workers/, command: "pitroom init", why: "propose a starter config (fallback models from your catalogue)" },
  { when: /pitroom install|no Pitroom skills|launcher on PATH/, command: "pitroom install", why: "link the skills and the pitroom command" },
  { when: /first `node` on PATH/, command: "nvm alias default 24", why: "a current Node first in every new shell" },
  { when: /not logged in/, command: "claude auth login", why: "sign in the Claude Code worker (Codex: codex login)" },
  { when: /Gemini CLI is not signed in|IneligibleTierError/, command: "export GEMINI_API_KEY=\u2026", why: "a Google AI Studio key for the Gemini worker" }
];
function firstNodeOnPath() {
  for (const dir of (process.env.PATH ?? "").split(path24.delimiter).filter(Boolean)) {
    const file = path24.join(dir, process.platform === "win32" ? "node.exe" : "node");
    try {
      if (!fs28.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const r = spawnSync8(file, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5e3 });
    return r.status === 0 ? { path: file, version: r.stdout.trim() } : { path: file, version: "" };
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
  if (onPath && onPath.version && tooOld(onPath.version) && path24.resolve(onPath.path) !== path24.resolve(process.execPath)) {
    add("warn", `the first \`node\` on PATH is v${onPath.version} (${onPath.path}), older than the 22.13 Pitroom needs: shells that agent apps start may use it (the pitroom command finds a newer Node itself; other tools may not)`);
  }
  add(gitAvailable() ? "ok" : "warn", gitAvailable() ? "git available" : "git not found: --write/--isolate tracking disabled");
  const cfg = loadConfig();
  add(cfg.warnings.length ? "warn" : "ok", `config: ${configPath()}${fs28.existsSync(configPath()) ? "" : " (not present, defaults in use)"}`);
  for (const w of cfg.warnings) add("warn", w);
  if (process.platform !== "win32") {
    const guarded = guardEnv(process.env).PATH?.startsWith(shimDir());
    add(guarded ? "ok" : "warn", guarded ? "git guard shim ready" : "git guard unavailable (git not on PATH)");
  }
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
  section2("Skills and agents");
  addAll(skillChecks());
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
    for (const c of checks.filter((x) => x.section === name)) console.log(`  ${MARK[c.level]()} ${wrapText(c.message, 4)}`);
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
  const r = spawnSync8(inv.command, inv.args, {
    encoding: "utf8",
    timeout: 3e5,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: guardEnv({ ...process.env, ...inv.env, PWD: process.cwd(), PITROOM_ACTIVE: "1" })
  });
  const secs2 = ((Date.now() - t0) / 1e3).toFixed(1);
  const run = backend.parse(r.stdout ?? "");
  if (run.finalText.includes("PONG")) return { level: "ok", message: `live probe (${describeTarget(target)}) answered in ${secs2}s` };
  const why = backend.failure(run, r.stderr ?? "", r.status)?.message ?? run.finalText.slice(0, 200);
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
  if (viaPlugin) {
    const linked = installedSkills().some((i) => i.base.includes(`${path24.sep}.claude${path24.sep}`) && i.names.length);
    checks.push(
      linked ? { level: "warn", message: "Pitroom is installed as a Claude Code plugin and linked into ~/.claude/skills: skills load twice; run `pitroom uninstall` or remove the plugin" } : { level: "ok", message: "Claude Code plugin installed (skills + session-start hook)" }
    );
  }
  const launcher = launcherPath();
  if (fs28.existsSync(launcher)) {
    const r = spawnSync8(launcher, ["--version"], { encoding: "utf8", timeout: 3e4, stdio: ["ignore", "pipe", "pipe"] });
    checks.push(
      r.status === 0 ? { level: "ok", message: `launcher ${launcher} \u2192 pitroom ${r.stdout.trim()}` } : { level: "fail", message: `launcher ${launcher} does not start: ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
    );
  } else {
    checks.push({ level: "warn", message: "no `pitroom` launcher on PATH: run `pitroom install`" });
  }
  return checks;
}
function pluginInstalled() {
  try {
    const f = path24.join(os10.homedir(), ".claude", "plugins", "installed_plugins.json");
    const plugins = JSON.parse(fs28.readFileSync(f, "utf8")).plugins ?? {};
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
  for (const base2 of [path24.join(os10.homedir(), ".agents", "skills"), path24.join(os10.homedir(), ".claude", "skills")]) {
    const dir = path24.join(base2, "using-superpowers");
    if (fs28.existsSync(path24.join(dir, "SKILL.md"))) found.push(dir);
  }
  return found;
}
function claudePlugins() {
  try {
    const f = path24.join(os10.homedir(), ".claude", "plugins", "installed_plugins.json");
    return Object.keys(JSON.parse(fs28.readFileSync(f, "utf8")).plugins ?? {});
  } catch {
    return [];
  }
}
function claudePluginEnabled(key) {
  try {
    const f = path24.join(os10.homedir(), ".claude", "settings.json");
    return JSON.parse(fs28.readFileSync(f, "utf8")).enabledPlugins?.[key] !== false;
  } catch {
    return true;
  }
}
function codexPlugins() {
  const plugins = /* @__PURE__ */ new Map();
  let text;
  try {
    text = fs28.readFileSync(path24.join(process.env.CODEX_HOME ?? path24.join(os10.homedir(), ".codex"), "config.toml"), "utf8");
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
  const dir = path24.join(process.env.XDG_CONFIG_HOME ?? path24.join(os10.homedir(), ".config"), "opencode");
  const plugins = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = fs28.readFileSync(path24.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      const list2 = JSON.parse(text).plugin;
      if (Array.isArray(list2)) plugins.push(...list2.filter((p) => typeof p === "string"));
    } catch {
    }
  }
  for (const folder of ["plugin", "plugins"]) {
    try {
      for (const f of fs28.readdirSync(path24.join(dir, folder))) plugins.push(path24.join(dir, folder, f));
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
  pitroom doctor [--probe]              check workers, models, permissions, skills
  pitroom config                        effective settings, where each comes from, config file path
  pitroom init [--model ID] [--fallback A,B] [--yes] [--force]
                                        propose a starter config from the worker CLIs and models you have;
                                        writes it only with --yes (models are suggested, never chosen for you)
  pitroom install [--copy] [--force]    link the skills into ~/.agents/skills + ~/.claude/skills,
                                        and the CLI into ~/.local/bin
  pitroom uninstall                     remove what install linked
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
     PITROOM_PRIMARY=sonnet|opus|haiku|gpt-5, PITROOM_PRICE="in,out", PITROOM_HOME, PITROOM_CONFIG,
     PITROOM_<WORKER>_BIN
Config: ~/.config/pitroom/config.json (worker, fallback, models, tiers, timeout, primary, price, link, web, maxParallel)`;
var COMMANDS = {
  run: cmdRun,
  crew: cmdCrew,
  review: cmdReview,
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
