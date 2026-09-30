#!/usr/bin/env node

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
        } else if (c.type === "tool_use") {
          usage.toolCalls++;
          tools[c.name] = (tools[c.name] ?? 0) + 1;
          const target = c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? c.input?.command ?? c.input?.url;
          lastActivity = `${c.name} ${target ? oneLine(String(target), 60) : ""}`.trim();
          if (EDIT_TOOLS.has(c.name) && c.input?.file_path) pendingEdits.set(c.id, String(c.input.file_path));
        }
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== "tool_result") continue;
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
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
  return { sessionId, model, finalText: finalText ?? (error ? "" : lastText), usage, tools, edits, lastActivity, error };
}
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
  "codex"
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
  if (req.model) args.push("--model", req.model);
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
    const settings = JSON.parse(fs2.readFileSync(path2.join(os2.homedir(), ".claude", "settings.json"), "utf8"));
    return typeof settings.model === "string" ? settings.model : void 0;
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
var claude = {
  id: "claude",
  name: "Claude Code",
  capabilities: { readOnly: "tool-allowlist", resume: "by-id", reportsCost: true, attachFiles: false },
  binary,
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
        } else if (it.type === "command_execution") {
          if (it.status === "declined" || /operation not permitted|sandbox/i.test(String(it.aggregated_output ?? ""))) usage.denied++;
          lastActivity = `shell ${oneLine2(String(it.command ?? ""), 60)}`;
        } else if (it.type === "file_change") {
          const paths = (it.changes ?? []).map((c) => String(c.path));
          if (it.status !== "failed" && it.status !== "declined") edits.push(...paths);
          else usage.denied++;
          lastActivity = `edit ${oneLine2(paths.join(", "), 60)}`;
        }
        break;
      }
      case "turn.completed": {
        const u = e.usage ?? {};
        const cached2 = num2(u.cached_input_tokens);
        const reasoning = num2(u.reasoning_output_tokens);
        usage.input += Math.max(0, num2(u.input_tokens) - cached2);
        usage.cacheRead += cached2;
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
  return { sessionId, finalText, usage, tools, edits, lastActivity, error };
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
    checks.push({
      level: "ok",
      message: m ? `Codex model: ${m} (checked on first use; unsupported models fail over)` : "Codex model: Codex's built-in default (your ~/.codex/config.toml is ignored for workers; pick one with -W codex:<model>)"
    });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Codex runs" });
  return checks;
}
var codex = {
  id: "codex",
  name: "Codex",
  capabilities: { readOnly: "os-sandbox", resume: "by-id", reportsCost: false, attachFiles: false },
  binary: binary2,
  invocation: invocation2,
  parse: parseEvents2,
  failure: failure2,
  resolveModel,
  doctor: doctor2
};

// src/backends/opencode/index.ts
import { spawnSync as spawnSync3 } from "node:child_process";

// src/backends/opencode/events.ts
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
var DENIED2 = /rule which prevents you|permission denied|permission\.rejected/i;
function parseEvents3(ndjson) {
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
        lastActivity = `says: ${oneLine3(text)}`;
        break;
      }
      case "tool_use": {
        const name = String(p.tool ?? "tool");
        const st = p.state ?? {};
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === "error" && DENIED2.test(String(st.error ?? ""))) usage.denied++;
        if (st.status === "completed" && EDIT_TOOLS2.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe2(st.input)}`.trim();
        break;
      }
      case "step_finish": {
        const t = p.tokens ?? {};
        usage.steps++;
        usage.input += num3(t.input);
        usage.output += num3(t.output);
        usage.reasoning += num3(t.reasoning);
        usage.cacheRead += num3(t.cache?.read);
        usage.cacheWrite += num3(t.cache?.write);
        usage.total += num3(t.total) || num3(t.input) + num3(t.output) + num3(t.reasoning) + num3(t.cache?.read);
        usage.cost = (usage.cost ?? 0) + num3(p.cost);
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
  return { sessionId, finalText, usage, tools, edits, lastActivity, error };
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
function num3(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine3(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}
function describe2(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v ? oneLine3(String(v), 60) : "";
}

// src/backends/opencode/profiles.ts
import fs4 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
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
  const data = process.env.XDG_DATA_HOME ?? path4.join(os4.homedir(), ".local", "share");
  const rules = {
    "*": "deny",
    [path4.join(data, "opencode", "tool-output", "*")]: "allow",
    [path4.join(data, "opencode", "shell", "*", "*")]: "allow"
  };
  for (const tmp of /* @__PURE__ */ new Set([os4.tmpdir(), realpath(os4.tmpdir())])) rules[path4.join(tmp, "opencode", "*")] = "allow";
  return rules;
}
function realpath(p) {
  try {
    return fs4.realpathSync(p);
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
var binary3 = () => findBinary("opencode", "PITROOM_OPENCODE_BIN", ["~/.opencode/bin/opencode"]);
function oc(args, opts = {}) {
  const { command, prefix } = resolveCommand(binary3());
  const r = spawnSync3(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 6e4,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var jsonIn = (s) => JSON.parse(s.slice(s.indexOf("{")));
function invocation3(req) {
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
  const { command, prefix } = resolveCommand(binary3());
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
function classify3(message) {
  if (/model not found|ModelNotFound|unknown model|no such model|deprecated/i.test(message)) return "model-unavailable";
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded|\b50[23]\b|unavailable|capacity/i.test(message)) return "rate-limited";
  if (/provider\.auth|FreeTierError|free tier|unauthori[sz]ed|\b40[13]\b|api.?key|insufficient|credits?\b|billing|payment/i.test(message)) {
    return "auth";
  }
  return "other";
}
function failure3(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `opencode exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify3(message), message };
}
function modelId(m) {
  if (typeof m === "string") return m;
  const id = m?.model ?? m?.id;
  return m?.providerID && id ? `${m.providerID}/${id}` : void 0;
}
function defaultModel2() {
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
function listModels() {
  return oc(["models"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
}
function doctor3({ models, hasFallback }) {
  const checks = [];
  const version = oc(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `opencode not runnable (${binary3()}). Install: https://opencode.ai or set PITROOM_OPENCODE_BIN` }];
  }
  const v = version.out.trim().replace(/^opencode\s+/i, "");
  const major = majorVersion(v);
  if (major !== void 0 && major < 2) {
    return [{ level: "fail", message: `OpenCode ${v} is too old: Pitroom needs OpenCode v2 or newer (run \`opencode upgrade\`)` }];
  }
  checks.push({ level: "ok", message: `opencode ${v} at ${binary3()} (private --standalone server per run)` });
  const known = new Set(listModels());
  const def = defaultModel2();
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
  binary: binary3,
  invocation: invocation3,
  parse: parseEvents3,
  failure: failure3,
  defaultModel: defaultModel2,
  resolveModel: resolveModel2,
  listModels,
  doctor: doctor3
};

// src/backends/index.ts
var REGISTRY = new Map([opencode, codex, claude].map((b) => [b.id, b]));
var DEFAULT_BACKEND = opencode.id;
var PLANNED = ["gemini"];
var backendIds = () => [...REGISTRY.keys()];
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
import fs7 from "node:fs";

// src/core/config.ts
import fs5 from "node:fs";
import os5 from "node:os";
import path5 from "node:path";
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
  tiers: "record"
};
function configPath() {
  if (process.env.PITROOM_CONFIG) return path5.resolve(process.env.PITROOM_CONFIG);
  const base = process.platform === "win32" ? process.env.APPDATA ?? path5.join(os5.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path5.join(os5.homedir(), ".config");
  return path5.join(base, "pitroom", "config.json");
}
var cached;
function loadConfig() {
  if (cached) return cached;
  const file = configPath();
  const config = {};
  const warnings = [];
  if (fs5.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs5.readFileSync(file, "utf8"));
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
  return typeof v === type;
}
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
    maxParallel: setting(void 0, positiveInt(e.PITROOM_MAX_PARALLEL), positiveInt(c.maxParallel), 4),
    models: setting(void 0, void 0, c.models, {}),
    tiers: setting(void 0, void 0, c.tiers, {})
  };
}

// src/core/store.ts
import fs6 from "node:fs";
import os6 from "node:os";
import path6 from "node:path";
import crypto from "node:crypto";
var TERMINAL = ["done", "failed", "timeout", "stopped"];
var isActive = (s) => !TERMINAL.includes(s);
function home() {
  if (process.env.PITROOM_HOME) return path6.resolve(process.env.PITROOM_HOME);
  if (process.platform === "win32") {
    return path6.join(process.env.LOCALAPPDATA ?? path6.join(os6.homedir(), "AppData", "Local"), "pitroom");
  }
  return path6.join(process.env.XDG_STATE_HOME ?? path6.join(os6.homedir(), ".local", "state"), "pitroom");
}
var runsDir = () => path6.join(home(), "runs");
var worktreesDir = () => path6.join(home(), "worktrees");
var ledgerFile = () => path6.join(home(), "ledger.jsonl");
var runDir = (id) => path6.join(runsDir(), id);
var runFile = (id, name) => path6.join(runDir(id), name);
function newRunId(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}
function writeMeta(meta) {
  fs6.mkdirSync(runDir(meta.id), { recursive: true });
  const file = runFile(meta.id, "meta.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs6.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs6.renameSync(tmp, file);
}
function readMeta(id) {
  return upgrade(JSON.parse(fs6.readFileSync(runFile(id, "meta.json"), "utf8")));
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
  if (!fs6.existsSync(runsDir())) return [];
  return fs6.readdirSync(runsDir()).filter((d) => fs6.existsSync(runFile(d, "meta.json"))).sort();
}
function resolveRun(ref) {
  const ids = listRunIds();
  if (!ids.length) throw new UserError("no runs yet");
  if (!ref || ref === "latest" || ref === "last") return ids[ids.length - 1];
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((id) => id.startsWith(ref) || id.endsWith(ref));
  if (hits.length === 1) return hits[0];
  throw new UserError(hits.length ? `ambiguous run "${ref}": ${hits.join(", ")}` : `unknown run "${ref}"`);
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
    meta.state = "failed";
    meta.error ??= "worker process exited unexpectedly";
    meta.endedAt ??= (/* @__PURE__ */ new Date()).toISOString();
    writeMeta(meta);
  }
  return meta;
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
  "--plan": "plan",
  "--step": "step"
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
  "--force": "force",
  "--yes": "yes",
  "--any": "any",
  "--brief": "brief",
  "--running": "running",
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
  if (file) return fs7.readFileSync(file, "utf8");
  const words = p.positional;
  if (words.length === 1 && words[0] === "-") return fs7.readFileSync(0, "utf8");
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

// src/cli/commands.ts
import fs20 from "node:fs";
import path17 from "node:path";

// src/core/report.ts
import fs10 from "node:fs";

// src/core/plan.ts
import fs8 from "node:fs";
import path7 from "node:path";
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
  const abs = path7.resolve(file);
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
var planName = (file) => path7.basename(file).replace(/\.md$/i, "");

// src/core/receipt.ts
import fs9 from "node:fs";
import path8 from "node:path";
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
function savedUsd(usage, returnedTokens, price = primaryPrice()) {
  const wouldCost = (usage.input * price.input + usage.cacheRead * price.cachedInput + (usage.output + usage.reasoning) * price.output) / 1e6;
  const readingTheReport = returnedTokens * price.input / 1e6;
  return Math.max(0, wouldCost - (usage.cost ?? 0) - readingTheReport);
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
  fs9.mkdirSync(path8.dirname(ledgerFile()), { recursive: true });
  fs9.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}
`);
}
function readLedger(sinceMs2) {
  if (!fs9.existsSync(ledgerFile())) return [];
  return fs9.readFileSync(ledgerFile(), "utf8").split("\n").filter(Boolean).flatMap((l) => {
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
  const stat = (x, value, label) => `<text x="${x}" y="148" class="v">${esc(value)}</text><text x="${x}" y="170" class="l">${esc(label)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="pitroom saved ${esc(usd(t.saved))}">
<style>
text{font-family:ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#ede9fe}
.h{font-size:15px;font-weight:600;fill:#a78bfa;letter-spacing:.08em}
.big{font-size:54px;font-weight:800;fill:#fff}
.sub{font-size:15px;fill:#c4b5fd}
.v{font-size:22px;font-weight:700;fill:#fff}
.l{font-size:12px;fill:#a78bfa}
.f{font-size:11px;fill:#8b5cf6}
</style>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#3b0764"/></linearGradient></defs>
<rect width="600" height="220" rx="18" fill="url(#g)"/>
<text x="32" y="42" class="h">PITROOM \xB7 ${esc(period.toUpperCase())}</text>
<text x="32" y="98" class="big">${esc(usd(t.saved))}</text>
<text x="${Math.min(60 + usd(t.saved).length * 30, 330)}" y="98" class="sub">saved on my main coding agent</text>
${stat(32, compact(t.tokens), "tokens offloaded")}
${stat(200, t.ratio ? `${Math.round(t.ratio)}\xD7` : "\u2014", "context compression")}
${stat(380, String(t.runs), "delegated tasks")}
<text x="32" y="202" class="f">estimated vs. ${esc(primaryPrice().name)} pricing \xB7 npx pitroom</text>
</svg>
`;
}

// src/core/report.ts
var ICON = {
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
  return fs10.existsSync(f) ? fs10.readFileSync(f, "utf8").trim() : "";
}
function formatReport(meta, finalText = readSummary(meta), maxLines = 400) {
  const out = [];
  out.push(`pitroom ${ICON[meta.state]} ${meta.state} \xB7 ${meta.mode} \xB7 ${duration(meta)} \xB7 run ${meta.id}`);
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
  if (!fs10.existsSync(f)) return { steps: 0, toolCalls: 0 };
  const p = getBackend((meta.ran ?? meta.worker).backend).parse(fs10.readFileSync(f, "utf8"));
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
var oneLine4 = (s, max) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
function headline(meta, max = 160) {
  const text = readSummary(meta);
  const line = text.split("\n").find((l) => /^SUMMARY:/i.test(l.trim())) ?? text.split("\n").find((l) => l.trim()) ?? "";
  return oneLine4(line.replace(/^SUMMARY:\s*/i, ""), max);
}
function table(metas) {
  if (!metas.length) return "no runs";
  const rows = metas.map((m) => {
    const l = m.state === "running" ? live(m) : void 0;
    const steps = l ? String(l.steps) : m.usage ? String(m.usage.steps) : "-";
    const note = l?.last ? oneLine4(l.last, 48) : isActive(m.state) ? oneLine4(m.task, 48) : headline(m, 48) || oneLine4(m.error ?? m.task, 48);
    return [m.id, m.state, m.mode, duration(m), steps, describeTarget(m.ran ?? m.worker), note];
  });
  const head = ["RUN", "STATE", "MODE", "TIME", "STEPS", "WORKER", "NOW / RESULT"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => i === r.length - 1 ? c : c.padEnd(widths[i])).join("  ");
  return [fmt(head), ...rows.map(fmt)].join("\n");
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
  const emit = (e) => opts.write(`${JSON.stringify(e)}
`);
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;
  for (; ; ) {
    const metas = select().map((id) => freshMeta(id));
    if (opts.json) {
      for (const m of metas) {
        const prev = seen.get(m.id);
        const l = m.state === "running" ? live(m) : { steps: m.usage?.steps ?? 0, toolCalls: m.usage?.toolCalls ?? 0 };
        const attempts = m.attempts?.length ?? 0;
        const base = { run: m.id, mode: m.mode, task: oneLine4(m.task, 60) };
        if (!prev) emit({ event: m.state === "queued" ? "queued" : "started", ...base });
        else if (prev.state === "queued" && m.state === "running") emit({ event: "started", ...base });
        if (attempts > (prev?.attempts ?? 0)) {
          const a = m.attempts[attempts - 1];
          emit({ event: "fallback", run: m.id, failed: a.target, reason: oneLine4(a.error, 120) });
        }
        if (m.state === "running" && l.steps > (prev?.steps ?? 0)) {
          emit({ event: "progress", run: m.id, steps: l.steps, tools: l.toolCalls, last: "last" in l && l.last ? oneLine4(String(l.last), 80) : void 0 });
        }
        if (TERMINAL.includes(m.state) && prev?.state !== m.state) {
          emit({
            event: m.state,
            run: m.id,
            time: duration(m),
            worker: describeTarget(m.ran ?? m.worker),
            summary: headline(m) || void 0,
            error: m.error ? oneLine4(m.error, 160) : void 0,
            refs: m.refs ? `${m.refs.valid}/${m.refs.total}` : void 0,
            changes: m.changes?.length || void 0
          });
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
      if (opts.json) {
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
import fs11 from "node:fs";
import os7 from "node:os";
import path9 from "node:path";
import { fileURLToPath } from "node:url";
var LEGACY = ["pitroom", "opencode-worker"];
function packageRoot() {
  return path9.resolve(path9.dirname(fileURLToPath(import.meta.url)), "..");
}
function skillNames(root = packageRoot()) {
  const dir = path9.join(root, "skills");
  if (!fs11.existsSync(dir)) return [];
  return fs11.readdirSync(dir).filter((d) => fs11.existsSync(path9.join(dir, d, "SKILL.md"))).sort();
}
function skillTargets() {
  const home2 = os7.homedir();
  const targets = [path9.join(home2, ".agents", "skills")];
  if (fs11.existsSync(path9.join(home2, ".claude"))) targets.push(path9.join(home2, ".claude", "skills"));
  return targets;
}
var launcherPath = () => path9.join(os7.homedir(), ".local", "bin", "pitroom");
var LAUNCHER_MARK = "# pitroom launcher";
function launcherScript(bundle) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
${LAUNCHER_MARK} (created by \`pitroom install\`; \`pitroom uninstall\` removes it)
cli=${q(bundle)}
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; }
for n in "\${PITROOM_NODE:-}" ${q(process.execPath)} "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if ok "$n"; then exec "$n" "$cli" "$@"; fi
done
echo "pitroom: needs Node.js 18 or newer (set PITROOM_NODE to its path)" >&2
exit 127
`;
}
function isOurLauncher(file, root) {
  if (linksInto(file, root)) return true;
  try {
    const s = fs11.readFileSync(file, "utf8");
    return s.includes(LAUNCHER_MARK) && s.includes(root);
  } catch {
    return false;
  }
}
function placeLauncher(bundle, root, force) {
  const dest = launcherPath();
  fs11.mkdirSync(path9.dirname(dest), { recursive: true });
  const exists = fs11.lstatSync(dest, { throwIfNoEntry: false });
  if (exists && !isOurLauncher(dest, root)) {
    if (!force) return `! ${dest} exists and is not Pitroom's launcher; kept (use --force to back it up and replace)`;
    fs11.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (exists) {
    fs11.rmSync(dest, { force: true });
  }
  fs11.writeFileSync(dest, launcherScript(bundle), { mode: 493 });
  return `\u2714 ${dest} \u2192 launcher for ${bundle} (Node 18+)`;
}
function linksInto(link, dir) {
  const st = fs11.lstatSync(link, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) return false;
  const target = path9.resolve(path9.dirname(link), fs11.readlinkSync(link));
  const rel = path9.relative(dir, target);
  return !rel.startsWith("..") && !path9.isAbsolute(rel);
}
function place(src, dest, opts) {
  fs11.mkdirSync(path9.dirname(dest), { recursive: true });
  const st = fs11.lstatSync(dest, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    if (!opts.force) return `! ${dest} exists and is not a link; kept (use --force to back it up and replace)`;
    fs11.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (st) {
    fs11.unlinkSync(dest);
  }
  if (opts.copy) fs11.cpSync(src, dest, { recursive: true });
  else fs11.symlinkSync(src, dest, process.platform === "win32" ? "junction" : fs11.statSync(src).isDirectory() ? "dir" : "file");
  return `\u2714 ${dest} \u2192 ${opts.copy ? "copied" : src}`;
}
function install(opts) {
  const root = packageRoot();
  const skills = skillNames(root);
  if (!skills.length) throw new Error(`no skills found under ${path9.join(root, "skills")}`);
  const out = [];
  for (const base of skillTargets()) {
    for (const legacy of LEGACY) {
      const l = path9.join(base, legacy);
      if (!skills.includes(legacy) && linksInto(l, root)) {
        fs11.unlinkSync(l);
        out.push(`\u2714 removed old link ${l}`);
      }
    }
    for (const name of skills) out.push(place(path9.join(root, "skills", name), path9.join(base, name), opts));
  }
  const bundle = path9.join(root, "dist", "pitroom.mjs");
  if (fs11.existsSync(bundle)) {
    out.push(placeLauncher(bundle, root, opts.force));
    const onPath = (process.env.PATH ?? "").split(path9.delimiter).some((d) => path9.resolve(d) === path9.dirname(launcherPath()));
    if (!onPath) out.push(`! ${path9.dirname(launcherPath())} is not on PATH; add it, or run ${launcherPath()} directly`);
  }
  return out;
}
function uninstall() {
  const root = packageRoot();
  const out = [];
  for (const base of skillTargets()) {
    if (!fs11.existsSync(base)) continue;
    for (const name of fs11.readdirSync(base)) {
      const l = path9.join(base, name);
      if (linksInto(l, root)) {
        fs11.unlinkSync(l);
        out.push(`\u2714 removed ${l}`);
      }
    }
  }
  if (isOurLauncher(launcherPath(), root)) {
    fs11.rmSync(launcherPath(), { force: true });
    out.push(`\u2714 removed ${launcherPath()}`);
  }
  return out.length ? out : ["nothing to remove"];
}
function installedSkills() {
  const names = skillNames();
  return skillTargets().map((base) => ({ base, names: names.filter((n) => fs11.existsSync(path9.join(base, n, "SKILL.md"))) }));
}

// src/core/review.ts
import crypto3 from "node:crypto";
import fs13 from "node:fs";
import path11 from "node:path";

// src/vcs/git.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import crypto2 from "node:crypto";
import fs12 from "node:fs";
import os8 from "node:os";
import path10 from "node:path";
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
  const r = spawnSync4("git", [...SAFE, ...args], {
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
  return r.code === 0 ? path10.resolve(r.stdout.trim()) : void 0;
}
function snapshotTree(root, exclude = []) {
  const tmp = path10.join(os8.tmpdir(), `pitroom-index-${process.pid}-${crypto2.randomBytes(4).toString("hex")}`);
  const real = path10.resolve(root, must(root, ["rev-parse", "--git-path", "index"]).trim());
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    if (fs12.existsSync(real)) fs12.copyFileSync(real, tmp);
    else must(root, ["read-tree", "--empty"], env);
    must(root, ["add", "-A", "--", ":/", ...exclude.map((p) => `:(top,exclude)${p}`)], env);
    return must(root, ["write-tree"], env).trim();
  } finally {
    fs12.rmSync(tmp, { force: true });
    fs12.rmSync(`${tmp}.lock`, { force: true });
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
  const objects = path10.join(path10.resolve(root, must(root, ["rev-parse", "--git-common-dir"]).trim()), "objects");
  fs12.mkdirSync(path10.dirname(dest), { recursive: true });
  must(path10.dirname(dest), ["init", "--quiet", dest]);
  fs12.writeFileSync(path10.join(dest, ".git", "objects", "info", "alternates"), `${objects}
`);
  must(dest, ["read-tree", tree]);
  must(dest, ["checkout-index", "--all", "--force"]);
}
function removeIsolatedCopy(dest, ownedBy) {
  const rel = path10.relative(ownedBy, dest);
  if (!rel || rel.startsWith("..") || path10.isAbsolute(rel)) throw new Error(`refusing to remove ${dest}`);
  fs12.rmSync(dest, { recursive: true, force: true });
}
function linkIntoWorktree(root, worktree, rels) {
  const linked = [];
  for (const rel of rels) {
    const src = path10.join(root, rel);
    const dst = path10.join(worktree, rel);
    if (!fs12.existsSync(src) || fs12.existsSync(dst)) continue;
    fs12.mkdirSync(path10.dirname(dst), { recursive: true });
    fs12.symlinkSync(src, dst, process.platform === "win32" ? "junction" : void 0);
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
  return fs13.existsSync(f) ? fs13.readFileSync(f, "utf8") : root.task;
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
  if (where && fs13.existsSync(where) && from && m.afterTree) return reviewDiff(where, from, m.afterTree);
  if (from !== m.baseTree) {
    throw new UserError(`the isolated copy of ${m.id} is gone, so its fix round cannot be shown on its own; review a run that is not applied yet`, 3);
  }
  return fs13.readFileSync(runFile(m.id, "changes.patch"), "utf8");
}
function runReview(id) {
  const m = freshMeta(id);
  if (isActive(m.state)) throw new UserError(`run ${m.id} is still ${m.state}; pitroom wait ${m.id} first`, 3);
  if (m.reviewOf) throw new UserError(`run ${m.id} is itself a review`);
  if (m.mode === "read") throw new UserError(`run ${m.id} was read-only; there is no change to review`);
  if (!m.changes?.length) throw new UserError(`run ${m.id} made no changes; nothing to review`);
  const chain = ancestors(m);
  const previous = latestReview(chain.map((a) => a.id));
  const dir = m.mode === "isolate" && m.worktree && fs13.existsSync(m.worktree) ? m.cwd : m.dir;
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
function rangeReview(range, dir) {
  const root = repoRoot(dir);
  if (!root) throw new UserError("--range needs a git repository");
  const i = range.indexOf("..");
  const a = i > 0 ? range.slice(0, i) : "";
  const b = i > 0 ? range.slice(i + 2) || "HEAD" : "";
  if (!a || b.startsWith(".")) throw new UserError(`--range takes A..B (e.g. main..HEAD), not "${range}"`);
  for (const ref of [a, b]) if (!commitOf(root, ref)) throw new UserError(`not a commit: ${ref}`);
  return {
    kind: "range",
    of: `${a}..${b}`,
    dir: root,
    package: [
      `# Review package \xB7 ${a}..${b}
`,
      section("WHAT WAS IMPLEMENTED", "The commits below."),
      section("REQUIREMENTS", "(none given; judge the change on its own terms)"),
      rangeDiff(root, a, b)
    ].join("\n")
  };
}
function pickReviewer(job) {
  const eff = effective();
  const tiers = eff.tiers.value;
  if (job.kind === "range") return tiers.capable;
  const implementer = job.implementer;
  if (!implementer) return void 0;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const candidates = [tiers.standard, tiers.capable, ...eff.fallback.value, eff.worker.value].filter((s) => !!s);
  return candidates.find((c) => parseTarget(c, def).backend !== implementer.backend);
}
function writePackage(job) {
  const g = gitDir(job.dir);
  if (!g) throw new UserError(`not a git repository: ${job.dir}`);
  const file = path11.join(g, "pitroom", `review-${crypto3.randomBytes(4).toString("hex")}.md`);
  fs13.mkdirSync(path11.dirname(file), { recursive: true });
  fs13.writeFileSync(file, job.package);
  return file;
}

// src/core/templates.ts
import fs14 from "node:fs";
import path12 from "node:path";
var FILES = {
  implementer: "pitroom-driven-development/implementer-prompt.md",
  "task-reviewer": "pitroom-driven-development/task-reviewer-prompt.md",
  "re-review": "pitroom-driven-development/re-review-prompt.md",
  "code-reviewer": "pitroom-review/code-reviewer.md"
};
function loadTemplate(name, root = packageRoot()) {
  const file = path12.join(root, "skills", FILES[name]);
  if (!fs14.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs14.readFileSync(file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}
function fill(template, values) {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in values));
  if (missing.length) throw new Error(`no value for template placeholder(s): ${[...new Set(missing)].join(", ")}`);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key]);
}

// src/core/run.ts
import { spawn as spawn2, spawnSync as spawnSync5 } from "node:child_process";
import fs19 from "node:fs";
import path16 from "node:path";

// src/core/chain.ts
function resolveChain(flags = {}) {
  const warnings = [];
  let spec = flags.worker;
  if (!spec && flags.tier) {
    spec = effective().tiers.value[flags.tier];
    if (!spec) warnings.push(`tier "${flags.tier}" is not configured (config "tiers"); using the default worker`);
  }
  const eff = effective({ worker: spec, model: flags.model });
  const models = eff.models.value;
  const withDefault = (t) => t.model || !models[t.backend] ? t : { ...t, model: models[t.backend] };
  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);
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
import fs16 from "node:fs";

// src/vcs/guard.ts
import fs15 from "node:fs";
import path13 from "node:path";
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
  return path13.join(home(), "shim", `v${VERSION}`);
}
function findRealGit(skip) {
  for (const dir of (process.env.PATH ?? "").split(path13.delimiter).filter(Boolean)) {
    if (path13.resolve(dir) === skip) continue;
    const p = path13.join(dir, "git");
    try {
      fs15.accessSync(p, fs15.constants.X_OK);
      if (fs15.statSync(p).isFile()) return p;
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
var hooksDir = () => path13.join(home(), "git-hooks", `v${HOOK_VERSION}`);
function writeIfChanged(file, content) {
  if (fs15.existsSync(file) && fs15.readFileSync(file, "utf8") === content) return;
  fs15.mkdirSync(path13.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs15.writeFileSync(tmp, content, { mode: 493 });
  fs15.renameSync(tmp, file);
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
  writeIfChanged(path13.join(hooksDir(), "reference-transaction"), REF_HOOK);
  env = withGitConfig(env, [
    ["core.hooksPath", hooksDir()],
    ["url.pitroom-push-blocked://.pushInsteadOf", ""]
  ]);
  const dir = shimDir();
  const real = findRealGit(dir);
  if (!real) return { ...env, ...quiet };
  writeIfChanged(path13.join(dir, "git"), SHIM);
  return { ...env, ...quiet, PITROOM_REAL_GIT: real, PATH: `${dir}${path13.delimiter}${env.PATH ?? ""}` };
}

// src/core/process.ts
async function spawnWorker(inv, opts) {
  const out = fs16.openSync(opts.stdoutFile, "w");
  const err = fs16.openSync(opts.stderrFile, "w");
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
  fs16.closeSync(out);
  fs16.closeSync(err);
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
import crypto4 from "node:crypto";
import fs17 from "node:fs";
import path14 from "node:path";
var slotsDir = () => path14.join(home(), "slots");
var locksDir = () => path14.join(home(), "locks");
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
  fs17.mkdirSync(path14.dirname(file), { recursive: true });
  try {
    fs17.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let owner = "";
  try {
    owner = fs17.readFileSync(file, "utf8").trim();
  } catch {
  }
  if (owner === runId) return true;
  if (holderActive(owner, runId)) return false;
  fs17.rmSync(file, { force: true });
  try {
    fs17.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseIfOwner(file, runId) {
  if (!file) return;
  try {
    if (fs17.readFileSync(file, "utf8").trim() === runId) fs17.rmSync(file, { force: true });
  } catch {
  }
}
function tryAcquireSlot(runId, maxParallel) {
  for (let n = 0; n < Math.max(1, maxParallel); n++) {
    const file = path14.join(slotsDir(), `slot-${n}`);
    if (tryClaim(file, runId)) return file;
  }
  return void 0;
}
var releaseSlot = (file, runId) => releaseIfOwner(file, runId);
var lockFile = (repoRoot2) => path14.join(locksDir(), `write-${crypto4.createHash("sha1").update(path14.resolve(repoRoot2)).digest("hex").slice(0, 16)}`);
function acquireWriteLock(repoRoot2, runId) {
  const file = lockFile(repoRoot2);
  if (tryClaim(file, runId)) return;
  let owner = "";
  try {
    owner = fs17.readFileSync(file, "utf8").trim();
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
import fs18 from "node:fs";
import path15 from "node:path";
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
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path15.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file) => {
    if (!lineCache.has(file)) {
      const size = fs18.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs18.readFileSync(file, "utf8").split("\n");
      if (lines && lines[lines.length - 1] === "") lines.pop();
      lineCache.set(file, lines);
    }
    return lineCache.get(file);
  };
  for (const ref of refs) {
    const file = resolve(ref.file, roots);
    if (!file) {
      invalid.push({ ref: ref.text, reason: path15.isAbsolute(ref.file) && !inside(ref.file, roots) ? "outside the project" : "file not found" });
      continue;
    }
    const lines = load(file);
    if (!lines) continue;
    if (ref.end > lines.length) {
      invalid.push({ ref: ref.text, reason: `file has ${lines.length} lines` });
      continue;
    }
    if (ref.symbol && !mentions(lines, ref) && !enclosedBy(lines, ref)) {
      invalid.push({ ref: ref.text, reason: `\`${ref.symbol}\` not near line ${ref.start}` });
    }
  }
  return { total: refs.length, valid: refs.length - invalid.length, invalid };
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
function resolve(ref, roots) {
  const candidates = path15.isAbsolute(ref) ? inside(ref, roots) ? [ref] : [] : roots.map((r) => path15.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs18.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}
function inside(file, roots) {
  return roots.some((r) => {
    const rel = path15.relative(r, path15.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path15.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// src/core/run.ts
var VERSION2 = true ? "0.5.0" : "0.0.0-dev";
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
    if (o.worker || o.tier) throw new UserError("a follow-up runs on the same worker as its parent; drop --worker/--tier");
    if (!parent.sessionId) throw new UserError(`run ${parent.id} has no worker session to continue`, 3);
    if (parent.mode === "isolate" && (!parent.worktree || !fs19.existsSync(parent.worktree))) {
      throw new UserError(`the isolated copy of run ${parent.id} is gone (applied or discarded)`, 3);
    }
    const ran = parent.ran ?? parent.worker;
    worker = o.model ? { ...ran, model: o.model } : ran;
    fallback = o.noFallback ? [] : parent.fallback.filter((t) => t.backend === ran.backend);
  } else {
    const chain = resolveChain({ worker: o.worker, model: o.model, tier: work.tier, noFallback: o.noFallback });
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
  const dir = path16.resolve(parent?.dir ?? o.dir);
  if (!fs19.existsSync(dir) || !fs19.statSync(dir).isDirectory()) throw new UserError(`not a directory: ${dir}`);
  const root = repoRoot(dir);
  if (mode === "isolate" && !root) throw new UserError("--isolate needs a git repository", 3);
  if (mode === "write" && !root && !o.allowNonGit) {
    throw new UserError("--write outside a git repo cannot be tracked or reverted; pass --allow-non-git to accept that", 3);
  }
  const files = o.files.map((f) => path16.resolve(f));
  for (const f of files) if (!fs19.existsSync(f)) throw new UserError(`file not found: ${f}`);
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
      fs19.rmSync(runDir(meta.id), { recursive: true, force: true });
      throw e;
    }
  }
  fs19.writeFileSync(runFile(meta.id, "task.md"), `${meta.task}
`);
  if (work.brief) fs19.writeFileSync(runFile(meta.id, "brief.md"), work.brief);
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
  const child = spawn2(process.execPath, [script, "__exec", meta.id], {
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
        if (fs19.existsSync(from)) fs19.renameSync(from, runFile(meta.id, f.replace(".", `.attempt-${i + 1}.`)));
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
    meta.worktree = path16.join(worktreesDir(), meta.id);
    createIsolatedCopy(root, meta.baseTree, meta.worktree);
    meta.cwd = path16.join(meta.worktree, path16.relative(root, meta.dir));
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
var read = (f) => fs19.existsSync(f) ? fs19.readFileSync(f, "utf8") : "";
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
  fs19.writeFileSync(runFile(meta.id, "summary.md"), `${run.finalText}
`);
  if (meta.plan && !meta.reviewOf) meta.taskStatus = parseStatus(run.finalText);
  if (meta.reviewOf) {
    meta.verdict = parseVerdict(run.finalText);
    if (meta.packageFile) fs19.rmSync(meta.packageFile, { force: true });
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
  fs19.writeFileSync(runFile(meta.id, "changes.patch"), d.patch);
}
function runVerify(meta) {
  const r = spawnSync5(meta.verify, {
    cwd: meta.cwd,
    shell: true,
    encoding: "utf8",
    timeout: 15 * 6e4,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PWD: meta.cwd, PITROOM_ACTIVE: "1" }
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  fs19.writeFileSync(runFile(meta.id, "verify.log"), output);
  return { ok: r.status === 0, code: r.status, tail: output.trimEnd().split("\n").slice(-25).join("\n") };
}
function applyRun(meta) {
  if (meta.mode !== "isolate") throw new UserError(`run ${meta.id} edited your tree directly (${meta.mode}); nothing to apply`);
  if (meta.applied) throw new UserError(`run ${meta.id} was already applied`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
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
  if (meta.worktree && fs19.existsSync(meta.worktree)) removeIsolatedCopy(meta.worktree, worktreesDir());
}

// src/cli/commands.ts
async function launch(p, meta) {
  if (has(p, "bg")) {
    startInBackground(meta);
    console.log(
      has(p, "json") ? JSON.stringify(meta, null, 2) : `pitroom started ${meta.mode} run ${meta.id} in background${meta.group ? ` (group ${meta.group})` : ""}
   wait:   pitroom wait ${meta.id}
   status: pitroom status ${meta.id}`
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
  if (has(p, "write") || has(p, "isolate")) throw new UserError("reviews are read-only; drop -w/-i");
  if (has(p, "continue")) throw new UserError("to review a follow-up, pass its run id: pitroom review <run>");
  const job = range ? rangeReview(range, flag(p, "dir") ?? process.cwd()) : runReview(resolveRun(p.positional[0]));
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
  } catch (e) {
    fs20.rmSync(packageFile, { force: true });
    throw e;
  }
  fs20.writeFileSync(runFile(meta.id, "package.md"), job.package);
  return launch(p, meta);
}
function cmdCrew(p) {
  const file = flag(p, "task-file");
  const tasks = (file ? fs20.readFileSync(file, "utf8").split(/^\s*---\s*$/m) : p.positional).map((t) => t.trim()).filter(Boolean);
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
  const { metas, timedOut } = await watch(group ? () => groupIds(group) : () => initial, {
    json: has(p, "json") || !process.stdout.isTTY,
    intervalMs: parseDuration(flag(p, "interval") ?? "2") * 1e3,
    timeoutMs: flag(p, "timeout") ? parseDuration(flag(p, "timeout")) * 1e3 : 0,
    write: (s) => process.stdout.write(s)
  });
  if (timedOut) return 75;
  return metas.some((m) => m.state !== "done") ? 1 : 0;
}
function cmdShow(p) {
  const meta = freshMeta(resolveRun(p.positional[0]));
  const dump = (name) => {
    const f = runFile(meta.id, name);
    process.stdout.write(fs20.existsSync(f) ? fs20.readFileSync(f, "utf8") : `(no ${name})
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
    console.log(applyRun(freshMeta(resolveRun(p.positional[0]))));
    return 0;
  }
  const pending = groupIds(group).map((id) => freshMeta(id)).filter((m) => m.mode === "isolate" && m.state === "done" && m.changes?.length && !m.applied && !m.discarded);
  if (!pending.length) throw new UserError(`group "${group}" has no finished isolate patches to apply`);
  for (const [i, m] of pending.entries()) {
    try {
      console.log(applyRun(m));
    } catch (e) {
      const rest = pending.slice(i + 1).map((r) => r.id);
      console.log(`\u2718 ${m.id}: ${e.message}`);
      if (rest.length) console.log(`   not applied yet: ${rest.join(" ")}`);
      console.log(`   resolve it (e.g. pitroom run --continue ${m.id} "rebase your change on the current tree"), then apply the rest`);
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
function cmdSavings(p) {
  const since = flag(p, "since") ?? "all";
  const t = totals(readLedger(sinceMs(since)));
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
    fs20.writeFileSync(out, card(t, period));
    console.log(`card written to ${path17.resolve(out)}`);
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
  console.log(`config file: ${configPath()}${fs20.existsSync(configPath()) ? "" : " (not present)"}`);
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
    fs20.rmSync(runDir(id), { recursive: true, force: true });
  }
  console.log(`removed ${old.length} run(s); the savings ledger is kept`);
  return 0;
}
var cmdRevert = (p) => (console.log(revertRun(freshMeta(resolveRun(p.positional[0])))), 0);
var cmdDiscard = (p) => (console.log(discardRun(freshMeta(resolveRun(p.positional[0])))), 0);

// src/core/doctor.ts
import { spawnSync as spawnSync6 } from "node:child_process";
import fs21 from "node:fs";
import os9 from "node:os";
import path18 from "node:path";
var MARK = { ok: "\u2714", warn: "!", fail: "\u2718" };
var READ_ONLY_HOW = {
  "permission-rules": "per-run permission rules",
  "os-sandbox": "an OS sandbox",
  "tool-allowlist": "a tool allowlist",
  "approval-mode": "the CLI's read-only approval mode"
};
function doctor4(probe) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });
  add("ok", `pitroom ${VERSION2} \xB7 node ${process.versions.node} \xB7 state in ${home()}`);
  add(gitAvailable() ? "ok" : "warn", gitAvailable() ? "git available" : "git not found: --write/--isolate tracking disabled");
  const cfg = loadConfig();
  add(cfg.warnings.length ? "warn" : "ok", `config: ${configPath()}${fs21.existsSync(configPath()) ? "" : " (not present, defaults in use)"}`);
  for (const w of cfg.warnings) add("warn", w);
  if (process.platform !== "win32") {
    const guarded = guardEnv(process.env).PATH?.startsWith(shimDir());
    add(guarded ? "ok" : "warn", guarded ? "git guard shim ready" : "git guard unavailable (git not on PATH)");
  }
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
    checks.push(...backend.doctor({ models: [...new Set(models)], hasFallback: chain.length > 1 }));
    add("ok", `${backend.name}: read-only runs enforced by ${READ_ONLY_HOW[backend.capabilities.readOnly]}`);
  }
  checks.push(...skillChecks());
  if (probe && chain[0]) checks.push(liveProbe(chain[0]));
  for (const c of checks) console.log(`${MARK[c.level]} ${c.message}`);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
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
  const r = spawnSync6(inv.command, inv.args, {
    encoding: "utf8",
    timeout: 3e5,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: guardEnv({ ...process.env, ...inv.env, PWD: process.cwd(), PITROOM_ACTIVE: "1" })
  });
  const secs = ((Date.now() - t0) / 1e3).toFixed(1);
  const run = backend.parse(r.stdout ?? "");
  if (run.finalText.includes("PONG")) return { level: "ok", message: `live probe (${describeTarget(target)}) answered in ${secs}s` };
  const why = backend.failure(run, r.stderr ?? "", r.status)?.message ?? run.finalText.slice(0, 200);
  return { level: "fail", message: `live probe (${describeTarget(target)}) failed after ${secs}s: ${why}` };
}
function skillChecks() {
  const checks = [];
  const all = skillNames();
  const viaPlugin = pluginInstalled();
  for (const { base, names } of installedSkills()) {
    if (names.length === all.length) checks.push({ level: "ok", message: `skills in ${base}: ${names.join(", ")}` });
    else if (names.length) checks.push({ level: "warn", message: `skills in ${base}: only ${names.join(", ")} of ${all.length}; run \`pitroom install\`` });
    else if (!viaPlugin) checks.push({ level: "warn", message: `no Pitroom skills in ${base}; run \`pitroom install\`` });
  }
  if (viaPlugin) {
    const linked = installedSkills().some((i) => i.base.includes(`${path18.sep}.claude${path18.sep}`) && i.names.length);
    checks.push(
      linked ? { level: "warn", message: "Pitroom is installed as a Claude Code plugin and linked into ~/.claude/skills: skills load twice; run `pitroom uninstall` or remove the plugin" } : { level: "ok", message: "Claude Code plugin installed (skills + session-start hook)" }
    );
  }
  const launcher = launcherPath();
  if (fs21.existsSync(launcher)) {
    const r = spawnSync6(launcher, ["--version"], { encoding: "utf8", timeout: 3e4, stdio: ["ignore", "pipe", "pipe"] });
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
    const f = path18.join(os9.homedir(), ".claude", "plugins", "installed_plugins.json");
    const plugins = JSON.parse(fs21.readFileSync(f, "utf8")).plugins ?? {};
    return Object.keys(plugins).some((k) => k.startsWith("pitroom@"));
  } catch {
    return false;
  }
}

// src/cli.ts
var HELP = `pitroom ${VERSION2} \u2014 a free pit crew for your expensive coding agent.
Delegates bounded tasks to a worker agent CLI (${backendIds().join(", ")}), using the
worker's own default model, and returns a compact answer, exact changes and a receipt.

Usage
  pitroom [run] [options] "task"        run a worker (task: argument, "-" for stdin, or --task-file)
  pitroom crew [options] -g NAME "task 1" "task 2" \u2026
                                        start several workers in background as one group
  pitroom review [run | --range A..B] [--tier T | -W T] [--bg]
                                        read-only review of a run's change (a follow-up: only its
                                        fix round) or of a commit range; by default on another worker
  pitroom status [run | -g NAME]        state / live progress (default: latest run)
  pitroom wait [run\u2026 | -g NAME] [--any] [--brief] [--timeout 540]
                                        block until all (or any) are done, then print reports
  pitroom watch [run\u2026 | -g NAME] [--json] [--interval 2]
                                        live table (TTY) or one JSON line per change, until done
  pitroom show [run] [--patch|--events|--full|--json]
  pitroom ls [--running] [-g NAME]      recent runs
  pitroom apply [run | -g NAME]         apply --isolate patch(es) to your tree (checked first)
  pitroom discard [run]                 drop an --isolate run's copy (the patch is kept)
  pitroom revert [run]                  undo the changes of a --write run (checked first)
  pitroom stop [run | -g NAME]          stop running or queued workers
  pitroom savings [--since 7d|30d|all] [--card file.svg] [--badge]
  pitroom doctor [--probe]              check workers, models, permissions, skills
  pitroom config                        effective settings, where each comes from, config file path
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

Parallel: at most maxParallel workers (default 4, PITROOM_MAX_PARALLEL) run at once; others queue.
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
  status: cmdStatus,
  wait: cmdWait,
  watch: cmdWatch,
  show: cmdShow,
  ls: cmdLs,
  list: cmdLs,
  apply: cmdApply,
  revert: cmdRevert,
  discard: cmdDiscard,
  stop: cmdStop,
  savings: cmdSavings,
  doctor: (p) => doctor4(has(p, "probe")),
  config: cmdConfig,
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
