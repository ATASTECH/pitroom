// src/core/errors.ts
var UserError = class extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
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
  const usage = {
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
          usage.toolCalls++;
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
          if (DENIED.test(text)) usage.denied++;
        } else if (pendingEdits.has(c.tool_use_id)) {
          edits.push(pendingEdits.get(c.tool_use_id));
        }
      }
    } else if (e.type === "result") {
      const u = e.usage ?? {};
      usage.input += num(u.input_tokens);
      usage.cacheRead += num(u.cache_read_input_tokens);
      usage.cacheWrite += num(u.cache_creation_input_tokens);
      usage.reasoning += num(u.output_tokens_details?.thinking_tokens);
      usage.output += Math.max(0, num(u.output_tokens) - num(u.output_tokens_details?.thinking_tokens));
      usage.total += num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
      usage.cost = (usage.cost ?? 0) + num(e.total_cost_usd);
      usage.denied = Math.max(usage.denied, Array.isArray(e.permission_denials) ? e.permission_denials.length : 0);
      if (e.is_error) {
        const tags = [e.terminal_reason, e.api_error_status && `HTTP ${e.api_error_status}`].filter(Boolean);
        error ??= `${String(e.result ?? e.subtype ?? "Claude Code error")}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
      } else if (typeof e.result === "string") {
        finalText = e.result.trim();
      }
    }
  }
  usage.steps = steps.size;
  return { sessionId, model, finalText: finalText ?? (error ? "" : lastText), usage, tools, edits, lastActivity, timeline, error };
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
  const usage = {
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
        usage.steps++;
        if (TOOLS.has(it.type)) {
          usage.toolCalls++;
          tools[it.type] = (tools[it.type] ?? 0) + 1;
        }
        if (it.type === "agent_message" && String(it.text ?? "").trim()) {
          finalText = String(it.text).trim();
          lastActivity = `says: ${oneLine2(finalText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip2(finalText, 600) });
        } else if (it.type === "command_execution") {
          if (it.status === "declined" || /operation not permitted|sandbox/i.test(String(it.aggregated_output ?? ""))) usage.denied++;
          lastActivity = `shell ${oneLine2(String(it.command ?? ""), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "shell", name: "shell", text: clip2(String(it.command ?? "").replace(/^\/bin\/\w+ -lc /, ""), 240), ok: it.exit_code === 0 });
        } else if (it.type === "file_change") {
          const paths = (it.changes ?? []).map((c) => String(c.path));
          if (it.status !== "failed" && it.status !== "declined") edits.push(...paths);
          else usage.denied++;
          lastActivity = `edit ${oneLine2(paths.join(", "), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "edit", name: "edit", text: clip2(paths.join(", "), 240), ok: it.status !== "failed" && it.status !== "declined" });
        }
        break;
      }
      case "turn.completed": {
        const u = e.usage ?? {};
        const cached = num2(u.cached_input_tokens);
        const reasoning = num2(u.reasoning_output_tokens);
        usage.input += Math.max(0, num2(u.input_tokens) - cached);
        usage.cacheRead += cached;
        usage.cacheWrite += num2(u.cache_write_input_tokens);
        usage.output += Math.max(0, num2(u.output_tokens) - reasoning);
        usage.reasoning += reasoning;
        usage.total += num2(u.input_tokens) + num2(u.output_tokens);
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
  return { sessionId, finalText, usage, tools, edits, lastActivity, timeline, error };
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
import fs4 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// src/backends/gemini/events.ts
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["replace", "write_file", "edit"]);
var DENIED2 = /policy|permission|not allowed|denied|blocked|disallowed|refus/i;
function parseEvents3(jsonl) {
  const usage = {
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
      usage.toolCalls++;
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
      if (!ok && DENIED2.test(`${e.error?.type ?? ""} ${e.error?.message ?? ""}`)) usage.denied++;
      if (ok && pendingEdits.has(String(e.tool_id))) edits.push(pendingEdits.get(String(e.tool_id)));
    } else if (e.type === "error") {
      if (e.severity === "error") error ??= String(e.message ?? "Gemini CLI error");
    } else if (e.type === "result") {
      const s = e.stats ?? {};
      const cached = num3(s.cached);
      usage.cacheRead += cached;
      usage.input += s.input !== void 0 ? num3(s.input) : Math.max(0, num3(s.input_tokens) - cached);
      usage.output += num3(s.output_tokens);
      usage.total += num3(s.total_tokens) || num3(s.input_tokens) + num3(s.output_tokens);
      usage.toolCalls = Math.max(usage.toolCalls, num3(s.tool_calls));
      model ??= Object.keys(s.models ?? {})[0];
      if (e.status === "error") error ??= String(e.error?.message ?? e.error?.type ?? "Gemini CLI error");
    }
  }
  flush();
  usage.steps = turns;
  return { sessionId, model, finalText: error ? "" : lastText, usage, tools, edits, lastActivity, timeline, error };
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
var policyDir = () => path4.resolve(path4.dirname(fileURLToPath(import.meta.url)), "..", "policies", "gemini");
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
  for (const p of policies) args.push("--policy", path4.join(dir, p));
  const [model] = (req.model ?? "").split("#");
  if (model) args.push("--model", model);
  const { command, prefix } = resolveCommand(binary3());
  return { command, args: [...prefix, ...args], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path4.join(dir, "system-settings.json") } };
}
function classify3(message) {
  if (/IneligibleTier|no longer supported for Gemini|error authenticating|not logged in|please (log ?in|sign in)|credentials|api key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|exhausted your capacity|capacity/i.test(message)) return "rate-limited";
  if (/model[^.]*(not found|not available|does not exist|unsupported|invalid)|\b404\b|NOT_FOUND|invalid model|is not supported/i.test(message)) return "model-unavailable";
  return "other";
}
function failure3(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const message = run.error ?? detail ?? `gemini exited with code ${exitCode}`;
  return { kind: classify3(message), message };
}
var geminiHome = () => path4.join(process.env.GEMINI_CLI_HOME ?? os4.homedir(), ".gemini");
function settings() {
  try {
    return JSON.parse(fs4.readFileSync(path4.join(geminiHome(), "settings.json"), "utf8"));
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
  const signedIn = fs4.existsSync(path4.join(geminiHome(), "oauth_creds.json"));
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
      message: pricey ? `Gemini model: ${model} is the largest tier for a worker; consider -W gemini:gemini-2.5-flash` : model ? `Gemini model: ${model}` : "Gemini model: Gemini CLI's own choice (it may pick a Pro model; a cheaper worker is -W gemini:gemini-2.5-flash)"
    });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Gemini runs" });
  return checks;
}
function catalog3() {
  const def = defaultModel2();
  const models = ["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"].map((id) => ({ id }));
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
  const usage = {
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
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === "error" && DENIED3.test(String(st.error ?? ""))) usage.denied++;
        if (st.status === "completed" && EDIT_TOOLS3.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe2(st.input)}`.trim();
        if (timeline.length < MAX_STEPS) {
          const kind = EDIT_TOOLS3.has(name) ? "edit" : /^(bash|shell)$/.test(name) ? "shell" : "tool";
          const text = kind === "shell" ? String(st.input?.command ?? "") : String(st.input?.filePath ?? st.input?.path ?? st.input?.pattern ?? st.input?.url ?? "") || describe2(st.input);
          timeline.push({ kind, name, text: clip4(text, 240), ok: st.status === "completed" ? true : st.status === "error" ? false : void 0, at: stamp(e.timestamp) });
        }
        break;
      }
      case "step_finish": {
        const t = p.tokens ?? {};
        usage.steps++;
        usage.input += num4(t.input);
        usage.output += num4(t.output);
        usage.reasoning += num4(t.reasoning);
        usage.cacheRead += num4(t.cache?.read);
        usage.cacheWrite += num4(t.cache?.write);
        usage.total += num4(t.total) || num4(t.input) + num4(t.output) + num4(t.reasoning) + num4(t.cache?.read);
        usage.cost = (usage.cost ?? 0) + num4(p.cost);
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
  return { sessionId, finalText, usage, tools, edits, lastActivity, timeline, error };
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
import fs5 from "node:fs";
import os5 from "node:os";
import path5 from "node:path";
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
  const data = process.env.XDG_DATA_HOME ?? path5.join(os5.homedir(), ".local", "share");
  const rules = {
    "*": "deny",
    [path5.join(data, "opencode", "tool-output", "*")]: "allow",
    [path5.join(data, "opencode", "shell", "*", "*")]: "allow"
  };
  for (const tmp of /* @__PURE__ */ new Set([os5.tmpdir(), realpath(os5.tmpdir())])) rules[path5.join(tmp, "opencode", "*")] = "allow";
  return rules;
}
function realpath(p) {
  try {
    return fs5.realpathSync(p);
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
  let base = {};
  if (existing?.trim()) {
    try {
      base = JSON.parse(existing);
    } catch {
      base = {};
    }
  }
  return JSON.stringify(deepMerge(base, ours));
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

// src/core/refs.ts
import fs6 from "node:fs";
import path6 from "node:path";
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
    const matches = [...line.matchAll(REF)];
    const seps = [...line.matchAll(CLAUSE)].map((s) => s.index ?? 0);
    const sepBetween = (a, b) => seps.some((s) => s >= a && s < b);
    const idents = [...line.matchAll(IDENT)].filter((i) => {
      if (!looksLikeSymbol(i)) return false;
      const pos = i.index ?? 0;
      const before = matches.filter((m) => (m.index ?? 0) + m[0].length <= pos).at(-1);
      const after = matches.find((m) => (m.index ?? 0) >= pos + i[0].length);
      return !(before && after && !sepBetween((before.index ?? 0) + before[0].length, after.index ?? 0));
    });
    matches.forEach((m, k) => {
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      if (start < 1 || end < start) return;
      const at = m.index ?? 0;
      const prev = matches[k - 1];
      const next = matches[k + 1];
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
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path6.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file) => {
    if (!lineCache.has(file)) {
      const size = fs6.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs6.readFileSync(file, "utf8").split("\n");
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
    if (path6.isAbsolute(ref.file)) return [];
    const wanted = ref.file.replace(/^(\.{1,2}\/)+/, "");
    return (byName().get(path6.basename(wanted)) ?? []).filter((f) => f.endsWith(`/${wanted}`) || path6.basename(f) === wanted).slice(0, 20);
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
      invalid.push({ ref: ref.text, reason: path6.isAbsolute(ref.file) && !inside(ref.file, roots) ? "outside the project" : "file not found" });
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
  const base = path6.basename(name);
  return !base.includes(".") || new RegExp(`^(${EXTENSIONLESS})$`).test(base) || FILE_EXTENSIONS.has(base.split(".").pop().toLowerCase());
};
function indexFiles(roots) {
  const index = /* @__PURE__ */ new Map();
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs6.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_INDEXED) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path6.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
        const list = index.get(e.name);
        if (list) list.push(path6.join(dir, e.name));
        else index.set(e.name, [path6.join(dir, e.name)]);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}
function resolve(ref, roots) {
  const candidates = path6.isAbsolute(ref) ? inside(ref, roots) ? [ref] : [] : roots.map((r) => path6.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs6.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}
function inside(file, roots) {
  return roots.some((r) => {
    const rel = path6.relative(r, path6.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path6.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// src/core/templates.ts
import fs7 from "node:fs";
import path8 from "node:path";

// src/core/install.ts
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function packageRoot() {
  return path7.resolve(path7.dirname(fileURLToPath2(import.meta.url)), "..");
}

// src/core/templates.ts
var FILES = {
  implementer: "pitroom-driven-development/implementer-prompt.md",
  "task-reviewer": "pitroom-driven-development/task-reviewer-prompt.md",
  "re-review": "pitroom-driven-development/re-review-prompt.md",
  "code-reviewer": "pitroom-review/code-reviewer.md"
};
function loadTemplate(name, root = packageRoot()) {
  const file = path8.join(root, "skills", FILES[name]);
  if (!fs7.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs7.readFileSync(file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}
function fill(template, values) {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in values));
  if (missing.length) throw new UserError(`no value for template placeholder(s): ${[...new Set(missing)].join(", ")}`, 3);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key]);
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

// src/core/plan.ts
import fs8 from "node:fs";
import path9 from "node:path";
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
  const abs = path9.resolve(file);
  if (!fs8.existsSync(abs) || !fs8.statSync(abs).isFile()) throw new UserError(`plan not found: ${file}`);
  const plan = parsePlan(fs8.readFileSync(abs, "utf8"), fs8.realpathSync(abs));
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
var planName = (file) => path9.basename(file).replace(/\.md$/i, "");
export {
  DEFAULT_BACKEND,
  allBackends,
  backendIds,
  brief,
  describeTarget,
  extractRefs,
  fill,
  formatTarget,
  getBackend,
  loadPlan,
  loadTemplate,
  parsePlan,
  parseStatus,
  parseTarget,
  parseVerdict,
  planName,
  planTask,
  verifyRefs
};
