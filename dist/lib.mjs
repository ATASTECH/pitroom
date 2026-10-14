// src/core/errors.ts
var UserError = class extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
};

// src/backends/antigravity/index.ts
import crypto3 from "node:crypto";
import { spawnSync } from "node:child_process";
import fs6 from "node:fs";
import os3 from "node:os";
import path5 from "node:path";

// src/core/secrets.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache"]);
var MAX_VISITED = 2e4;
var MAX_DEPTH = 4;
var TEMPLATE = /\.(example|sample|template|dist|defaults?|tpl)$/i;
function looksSecret(file) {
  const name = file.toLowerCase();
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
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile() && looksSecret(e.name)) {
        found.push(slash(path.relative(dir, path.join(d, e.name))));
      }
    }
  };
  walk(dir, 0);
  return found.sort();
}
function findSecretFilesInTree(root, dir) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return out.split("\0").filter((f) => f && looksSecret(path.basename(f)) && !path.relative(dir, path.join(root, f)).startsWith("..")).map((f) => slash(path.relative(dir, path.join(root, f)))).sort();
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
var slash = (p) => p.split(path.sep).join("/");

// src/core/store.ts
import fs3 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import crypto from "node:crypto";

// src/core/fs-atomic.ts
import fs2 from "node:fs";
var BUSY = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
function renameOver(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs2.renameSync(tmp, file);
      return;
    } catch (e) {
      if (process.platform !== "win32" || !BUSY.has(e.code ?? "") || attempt >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// src/core/store.ts
var TERMINAL = ["done", "failed", "timeout", "stopped"];
var isActive = (s) => !TERMINAL.includes(s);
function home() {
  if (process.env.PITROOM_HOME) return path2.resolve(process.env.PITROOM_HOME);
  if (process.platform === "win32") {
    return path2.join(process.env.LOCALAPPDATA ?? path2.join(os.homedir(), "AppData", "Local"), "pitroom");
  }
  return path2.join(process.env.XDG_STATE_HOME ?? path2.join(os.homedir(), ".local", "state"), "pitroom");
}
var runsDir = () => path2.join(home(), "runs");
var ledgerFile = () => path2.join(home(), "ledger.jsonl");
var runDir = (id2) => path2.join(runsDir(), id2);
var runFile = (id2, name) => path2.join(runDir(id2), name);
function newRunId(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp2 = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp2}-${crypto.randomBytes(2).toString("hex")}`;
}
var onFinished;
var archive;
function writeMeta(meta) {
  fs3.mkdirSync(runDir(meta.id), { recursive: true });
  const file = runFile(meta.id, "meta.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs3.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameOver(tmp, file);
  if (TERMINAL.includes(meta.state)) {
    try {
      onFinished?.(meta);
    } catch {
    }
  }
}
function readMeta(id2) {
  const file = runFile(id2, "meta.json");
  if (!fs3.existsSync(file)) {
    const kept = archive?.meta(id2);
    if (kept) return upgrade(kept);
  }
  return upgrade(JSON.parse(fs3.readFileSync(file, "utf8")));
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
  if (!fs3.existsSync(runsDir())) return [];
  return fs3.readdirSync(runsDir()).filter((d) => fs3.existsSync(runFile(d, "meta.json"))).sort();
}
function resolveRun(ref) {
  const ids = listRunIds();
  if (!ref || ref === "latest" || ref === "last") {
    if (!ids.length) throw new UserError("no runs yet");
    return ids[ids.length - 1];
  }
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((id2) => id2.startsWith(ref) || id2.endsWith(ref));
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
var requestStop = (id2) => fs3.writeFileSync(runFile(id2, STOP_FILE), "");
function freshMeta(id2) {
  const meta = readMeta(id2);
  if (!TERMINAL.includes(meta.state) && meta.pid && !isAlive(meta.pid)) {
    const latest = readMeta(id2);
    if (TERMINAL.includes(latest.state)) return latest;
    const stopped = latest.stopRequested || fs3.existsSync(runFile(id2, STOP_FILE));
    latest.state = stopped ? "stopped" : "failed";
    if (!stopped) latest.error ??= "worker process exited unexpectedly";
    latest.endedAt ??= (/* @__PURE__ */ new Date()).toISOString();
    writeMeta(latest);
    return latest;
  }
  return meta;
}

// src/backends/deny.ts
var FORBIDDEN_COMMANDS = [
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
  "rm -r",
  "rm -R",
  "rm --recursive",
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
  "gemini",
  "qwen",
  "kilo",
  "kilocode",
  "agy"
];

// src/backends/exec.ts
import fs4 from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
function findBinary(name, envVar, known = []) {
  const override = process.env[envVar];
  if (override) return override;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path3.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path3.join(dir, `${name}${ext}`);
      if (isFile(p)) return p;
    }
  }
  return known.map((k) => k.replace(/^~/, os2.homedir())).find(isFile) ?? name;
}
function isFile(p) {
  try {
    return fs4.statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveCommand(bin) {
  try {
    const real = fs4.realpathSync(bin);
    const fd = fs4.openSync(real, "r");
    const head = Buffer.alloc(128);
    const n = fs4.readSync(fd, head, 0, 128, 0);
    fs4.closeSync(fd);
    const firstLine = head.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    if (/^#!.*\bnode\b/.test(firstLine)) return { command: process.execPath, prefix: [real] };
  } catch {
  }
  return { command: bin, prefix: [] };
}

// src/backends/home.ts
import crypto2 from "node:crypto";
import fs5 from "node:fs";
import path4 from "node:path";
function writeIfChanged(file, body) {
  try {
    if (fs5.readFileSync(file, "utf8") === body) return;
  } catch {
  }
  fs5.mkdirSync(path4.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${crypto2.randomBytes(3).toString("hex")}.tmp`;
  fs5.writeFileSync(tmp, body);
  for (let tries = 0; ; tries++) {
    try {
      fs5.renameSync(tmp, file);
      return;
    } catch (e) {
      const busy = ["EPERM", "EBUSY", "EACCES"].includes(e.code ?? "");
      if (busy && tries < 10) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      fs5.rmSync(tmp, { force: true });
      if (!busy) throw e;
      fs5.writeFileSync(file, body);
      return;
    }
  }
}
function linkInto(dir, from) {
  const to = path4.join(dir, path4.basename(from));
  try {
    let st;
    try {
      st = fs5.lstatSync(to);
    } catch {
    }
    if (st && !st.isSymbolicLink()) return;
    if (st) {
      if (fs5.readlinkSync(to) === from && fs5.existsSync(from)) return;
      fs5.unlinkSync(to);
    }
    if (fs5.existsSync(from)) fs5.symlinkSync(from, to);
  } catch {
  }
}

// src/backends/text.ts
var clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine(s, max = 80) {
  return clip(s.replace(/\s+/g, " ").trim(), max);
}
function splitModel(model) {
  if (!model) return {};
  const [m, effort] = model.split("#");
  return { model: m || void 0, effort: effort || void 0 };
}

// src/backends/types.ts
var MAX_STEPS = 400;

// src/backends/antigravity/events.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "write_file"]);
var SHELL = "run_command";
var DENIED = /soft-denied|permission|denied|not allowed|blocked|refus|requires approval/i;
var FAILED = /error|fail|denied|cancel|reject/i;
var OK = /^(success|succeeded|ok|done|completed?)$/i;
function parseEvents(jsonl) {
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, toolCalls: 0, denied: 0 };
  const stepUsage = [];
  const usageSeen = /* @__PURE__ */ new Set();
  const tools = {};
  const edits = [];
  const timeline = [];
  const said = /* @__PURE__ */ new Map();
  const stepOf = /* @__PURE__ */ new Map();
  const toolSeen = /* @__PURE__ */ new Set();
  const done = /* @__PURE__ */ new Set();
  let sessionId;
  let model;
  let lastText = "";
  let response;
  let lastActivity;
  let error;
  let streamError;
  let resultSeen = false;
  let haveResultUsage = false;
  const open = /* @__PURE__ */ new Map();
  let unnamed = 0;
  let turns = 0;
  let inTurn = false;
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
    const type = String(e.event ?? e.type ?? "").toLowerCase();
    const body = (name) => e[name] && typeof e[name] === "object" ? e[name] : e;
    if (type === "init") {
      sessionId ??= id(e.conversation_id ?? e.session_id ?? body("init").conversation_id);
      model ??= id(body("init").model);
    } else if (type === "step_update") {
      const s = body("step_update");
      sessionId ??= id(s.conversation_id);
      const kind2 = String(s.step_type ?? "").toLowerCase();
      const state = String(s.state ?? "").toUpperCase();
      const failedStep = state === "ERROR";
      const finished = state === "DONE" || failedStep;
      let key = s.step_index ?? s.step_id;
      if (key === void 0 || key === null) {
        key = open.get(kind2) ?? `${kind2}#${unnamed++}`;
        if (finished) open.delete(kind2);
        else open.set(kind2, key);
      }
      key = String(key);
      if (kind2 === "agent_response") {
        startTurn();
        const text = (said.get(key) ?? "") + str(s.text_delta);
        said.set(key, text);
        if (finished && !done.has(key)) {
          done.add(key);
          const t = text.trim();
          if (t) {
            lastText = t;
            lastActivity = `says: ${oneLine(t)}`;
            if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip(t, 600) });
          }
        }
      } else if (kind2 === "tool") {
        const info = s.tool_info && typeof s.tool_info === "object" ? s.tool_info : {};
        const name = String(info.name ?? info.tool_name ?? s.tool_name ?? "tool");
        const p = info.parameters ?? info.args ?? info.arguments ?? s.parameters ?? {};
        if (!toolSeen.has(key)) {
          toolSeen.add(key);
          startTurn();
          lastText = "";
          usage.toolCalls++;
          tools[name] = (tools[name] ?? 0) + 1;
          const target = p.CommandLine ?? p.command ?? p.TargetFile ?? p.AbsolutePath ?? p.file_path ?? p.path ?? p.SearchPath ?? p.Query ?? p.query ?? p.Url ?? p.url;
          lastActivity = `${name} ${target ? oneLine(String(target), 60) : ""}`.trim();
          if (timeline.length < MAX_STEPS) {
            const step = { kind: EDIT_TOOLS.has(name) ? "edit" : name === SHELL ? "shell" : "tool", name, text: clip(String(target ?? ""), 240) };
            timeline.push(step);
            stepOf.set(key, step);
          }
        }
        if (finished && !done.has(key)) {
          done.add(key);
          inTurn = false;
          const problem = `${errText(info.error)} ${str(info.status ?? s.status)}`.trim();
          const ok = !failedStep && (!problem || OK.test(problem) || !FAILED.test(problem));
          const step = stepOf.get(key);
          if (step) step.ok = ok;
          if (!ok && DENIED.test(`${problem} ${str(info.output)}`)) usage.denied++;
          const file = p.TargetFile ?? p.AbsolutePath ?? p.file_path ?? p.path;
          if (ok && EDIT_TOOLS.has(name) && file) edits.push(String(file));
        }
      }
      if (finished && s.usage && typeof s.usage === "object" && !usageSeen.has(`${kind2}:${key}`)) {
        usageSeen.add(`${kind2}:${key}`);
        stepUsage.push(s.usage);
      }
    } else if (type === "result") {
      const r = body("result");
      sessionId ??= id(r.conversation_id);
      model ??= id(r.model);
      if (typeof r.response === "string") response = r.response.trim();
      if (r.usage && typeof r.usage === "object") {
        add(usage, r.usage);
        haveResultUsage = true;
      }
      if (Array.isArray(r.denied_actions)) usage.denied = Math.max(usage.denied, r.denied_actions.length);
      resultSeen = true;
      const status = str(r.status);
      const message = errText(r.error);
      if (status ? !OK.test(status) : !!message) {
        error ??= message || (/^waiting$/i.test(status) ? "agy stopped waiting for an approval a headless run cannot give" : `agy ended with status ${status}`);
      }
    } else if (type === "error") {
      streamError ??= typeof e.message === "string" && e.message || errText(e.error) || "Antigravity CLI error";
    }
  }
  if (streamError && (!resultSeen || !response)) error ??= streamError;
  if (!haveResultUsage) for (const u of stepUsage) add(usage, u);
  usage.steps = turns;
  const finalText = error ? "" : response || lastText;
  return { sessionId, model, finalText, usage, tools, edits, lastActivity, timeline, error };
}
function add(u, r) {
  const cached3 = num(r.cache_read_tokens ?? r.cached_tokens);
  const input = num(r.input_tokens);
  u.cacheRead += cached3;
  u.input += Math.max(0, input - cached3);
  u.output += num(r.output_tokens);
  u.reasoning += num(r.thinking_tokens ?? r.reasoning_tokens);
  u.total += num(r.total_tokens) || input + num(r.output_tokens) + num(r.thinking_tokens ?? r.reasoning_tokens);
}
var id = (v) => typeof v === "string" && v ? v : void 0;
function errText(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || !Object.keys(v).length) return "";
  const code = typeof v.code === "string" || typeof v.code === "number" ? String(v.code) : "";
  const message = typeof v.message === "string" ? v.message : typeof v.reason === "string" ? v.reason : "";
  return [code, message].filter(Boolean).join(": ") || JSON.stringify(v);
}
var str = (v) => typeof v === "string" ? v : v === void 0 || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

// src/backends/antigravity/index.ts
var binary = () => findBinary("agy", "PITROOM_ANTIGRAVITY_BIN", ["~/.local/bin/agy", "~/.antigravity/bin/agy"]);
function agy(args, timeout = 3e4) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var dataDir = (h) => path5.join(h, ".gemini", "antigravity-cli");
var userDir = () => dataDir(os3.homedir());
var TOKEN = "antigravity-oauth-token";
var HOME_SECRETS = [".ssh", ".aws", ".gnupg", ".netrc", ".docker", ".kube", ".config/gcloud", ".config/gh", ".gemini", "Library/Keychains"];
function denyCommandRules() {
  const subcommands = FORBIDDEN_COMMANDS.filter((c) => c.startsWith("git ")).map((c) => c.slice(4));
  const anywhere = (cmd, option) => [0, 1, 2, 3, 4, 5].map((n) => `${cmd} ${".* ".repeat(n)}${option}`);
  return [
    ...FORBIDDEN_COMMANDS.map((c) => `command(${c})`),
    ...FORBIDDEN_COMMANDS.filter((c) => !c.startsWith("git ")).map((c) => `command(regex:.*/${c})`),
    // git by path would bypass the git guard's PATH shim; -C, -c, --git-dir and --work-tree point it elsewhere
    "command(regex:.*/git)",
    "command(regex:git (-C|-c|--git-dir.*|--work-tree.*))",
    `command(regex:git -.* (${subcommands.join("|")}))`,
    `command(regex:git -.* -.* (${subcommands.join("|")}))`,
    // a recursive delete however its options are spelled or placed (rm -Rf, rm -r -f, rm dir -rf, rm --recursive)
    ...["rm", ".*/rm"].flatMap((rm) => [...anywhere(rm, "-[a-zA-Z]*[rR][a-zA-Z]*"), ...anywhere(rm, "--recursive")]).map((r) => `command(regex:${r})`),
    // find runs what follows -exec itself, and agy does not take it apart; such a rule only holds when it spans the
    // whole command (a prefix of it was seen not to match), so find with -exec, -ok or -delete is refused outright,
    // up to six words before and after (grep -r does what find -exec grep did)
    ...["find", ".*/find"].flatMap((find) => [0, 1, 2, 3, 4, 5, 6].flatMap((before) => [0, 1, 2, 3, 4, 5, 6].flatMap((after) => {
      const words = (n) => " .*".repeat(n);
      return [
        ...after ? [`${find}${words(before)} -(exec|execdir|ok|okdir)${words(after)}`] : [],
        `${find}${words(before)} -delete${words(after)}`
      ];
    }))).map((r) => `command(regex:${r})`),
    // xargs runs its arguments as a command, and agy does not take it apart either; with a `{}` in it a rule has
    // to span the whole command again, so the words after the command are spelled out too
    ...["xargs", ".*/xargs"].flatMap((xargs) => [0, 1, 2, 3].flatMap((n) => [0, 1, 2, 3].flatMap((after) => [
      `${xargs}${" .*".repeat(n)} (.*/)?(${FORBIDDEN_COMMANDS.filter((c) => !c.includes(" ")).join("|")})${" .*".repeat(after)}`,
      `${xargs}${" .*".repeat(n)} (.*/)?git (${subcommands.join("|")})${" .*".repeat(after)}`,
      `${xargs}${" .*".repeat(n)} (.*/)?rm -[a-zA-Z]*[rR][a-zA-Z]*${" .*".repeat(after)}`
    ]))).map((r) => `command(regex:${r})`),
    // a command line with a `{}` in it is not split into commands: a rule is then matched against the whole line,
    // so these find xargs and find wherever they stand in it
    `command(regex:.*git (${subcommands.join("|")}).*)`,
    "command(regex:.*rm -[a-zA-Z]*[rR].*)",
    `command(regex:.*xargs .*rm -[a-zA-Z]*[rR].*)`,
    `command(regex:.*xargs .*git .*(${subcommands.join("|")}).*)`,
    "command(regex:.*find .*-(exec|execdir|ok|okdir) .*)",
    "command(regex:.*find .*-delete.*)",
    // a command inside a string is not matched above
    "command(regex:(ba|z|da|k)?sh -[a-zA-Z]*c[a-zA-Z]*)",
    "command(regex:.*/(ba|z|da|k)?sh -[a-zA-Z]*c[a-zA-Z]*)",
    "command(eval)"
  ];
}
function workerSettings(workspace, workerHome3, reads = []) {
  const real = (p) => {
    try {
      return fs6.realpathSync(p);
    } catch {
      return p;
    }
  };
  const both = (p) => [.../* @__PURE__ */ new Set([p, real(p)])];
  const secrets = [
    ...findSecretFiles(workspace).map((f) => path5.join(workspace, f)),
    ...reads.flatMap((r) => r.secrets),
    ...HOME_SECRETS.map((f) => path5.join(os3.homedir(), f)).filter((p) => fs6.existsSync(p)),
    // the keychain link of the worker's own home
    path5.join(workerHome3, "Library")
  ];
  return {
    ...baseSettings(),
    permissions: {
      // plan mode writes its plan into agy's own data folder, which is outside the workspace; the user's toolchains
      // under their home stay usable in the sandbox (read-only), which sees only what is granted besides the system
      allow: [
        "command(*)",
        ...both(path5.join(dataDir(workerHome3), "brain")).map((p) => `write_file(${rulePath(p)})`),
        ...toolchains().flatMap(both).map((p) => `read_file(${rulePath(p)})`),
        // what the task names outside the workspace: a headless agy cannot ask, and would end the turn unanswered
        ...reads.map((r) => r.path).flatMap(both).map((p) => `read_file(${rulePath(p)})`)
      ],
      deny: [
        ...secrets.flatMap(both).map((p) => `read_file(${rulePath(p)})`),
        ...denyCommandRules(),
        "mcp(*)",
        // No web for agy workers: the rule is in the settings file, so --web cannot switch it on per run.
        "read_url(*)",
        "execute_url(*)"
      ]
    }
  };
}
function toolchains() {
  const homeDir = os3.homedir();
  const inHome = (d) => {
    const rel = path5.relative(homeDir, d);
    return !!rel && !rel.startsWith("..") && !path5.isAbsolute(rel);
  };
  const dirs = (process.env.PATH ?? "").split(path5.delimiter).filter((d) => d && path5.isAbsolute(d) && inHome(d) && fs6.existsSync(d));
  const install = (d) => path5.basename(d) === "bin" && /[\\/](versions|toolchains)[\\/]/.test(d) ? path5.dirname(d) : d;
  return [...new Set(dirs.map(install))].filter((d) => !inHome(home()) || path5.relative(home(), d).startsWith(".."));
}
var isDir = (p) => {
  try {
    return fs6.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var MAX_READS = 20;
function pathsIn(prompt) {
  const out = [];
  for (const m of prompt.matchAll(/(^|[\s"'`(\[<{=])((?:~|[A-Za-z]:)?[\\/][^\s"'`)\]>}]*)/g)) {
    const raw = m[2].replace(/[.,;:!?]+$/, "");
    const abs = raw.startsWith("~") ? path5.join(os3.homedir(), raw.slice(1)) : raw;
    if (raw && path5.isAbsolute(abs)) out.push({ raw, at: m.index + m[1].length, abs });
  }
  return out;
}
var realOf = (p) => {
  try {
    return fs6.realpathSync(p);
  } catch {
    return void 0;
  }
};
function resolved(p) {
  let dir = path5.resolve(p);
  const rest = [];
  for (; ; ) {
    const r = realOf(dir);
    if (r) return path5.join(r, ...rest);
    const up = path5.dirname(dir);
    if (up === dir) return path5.resolve(p);
    rest.unshift(path5.basename(dir));
    dir = up;
  }
}
var inside = (p, dir) => {
  const rel = path5.relative(dir, p);
  return !rel || !rel.startsWith("..") && !path5.isAbsolute(rel);
};
var MAX_SCANNED = 2e4;
function allSecrets(dir) {
  const found = [];
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs6.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_SCANNED) return void 0;
      const p = path5.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (looksSecret(e.name)) found.push(p);
    }
  }
  return found;
}
function outsideReads(prompt, workspace, project) {
  if (process.platform === "win32") return [];
  const homeDir = realOf(os3.homedir()) ?? os3.homedir();
  const ws = realOf(workspace) ?? path5.resolve(workspace);
  const proj = project ? resolved(project) : void 0;
  const own = realOf(home()) ?? home();
  const found = /* @__PURE__ */ new Map();
  for (const { abs } of pathsIn(prompt)) {
    const p = realOf(abs);
    if (!p || found.has(p) || inside(p, ws) || inside(p, own)) continue;
    if (inside(homeDir, p) || inside(ws, p) || proj && inside(proj, p)) continue;
    if (p.split(/[\\/]/).filter(Boolean).length < 2) continue;
    if (inside(p, homeDir) && path5.relative(homeDir, p).startsWith(".")) continue;
    if (!isDir(p)) {
      if (!looksSecret(path5.basename(p))) found.set(p, { path: p, secrets: [] });
    } else {
      const secrets = allSecrets(p);
      if (secrets) found.set(p, { path: p, secrets });
    }
    if (found.size >= MAX_READS) break;
  }
  return [...found.values()];
}
function baseSettings() {
  return {
    enableTerminalSandbox: true,
    toolPermission: "proceed-in-sandbox",
    artifactReviewPolicy: "always-proceed",
    allowNonWorkspaceAccess: false
  };
}
var rulePath = (p) => p.replace(/^[A-Za-z]:(?=[\\/])/, "").replace(/\\/g, "/");
var HOMES_KEPT_DAYS = 14;
function workerHome(workspace, reads = []) {
  const root = path5.join(home(), "antigravity-home");
  const id2 = crypto3.createHash("sha256").update(path5.resolve(workspace)).digest("hex").slice(0, 16);
  const dir = path5.join(root, id2);
  fs6.mkdirSync(dataDir(dir), { recursive: true });
  writeIfChanged(path5.join(dataDir(dir), "settings.json"), `${JSON.stringify(workerSettings(workspace, dir, reads), null, 2)}
`);
  if (process.platform === "darwin") {
    fs6.mkdirSync(path5.join(dir, "Library"), { recursive: true });
    linkInto(path5.join(dir, "Library"), path5.join(os3.homedir(), "Library", "Keychains"));
  } else {
    linkInto(dataDir(dir), path5.join(userDir(), TOKEN));
  }
  const now = /* @__PURE__ */ new Date();
  fs6.utimesSync(dir, now, now);
  pruneHomes(root, dir);
  return dir;
}
function pruneHomes(root, keep) {
  const cutoff = Date.now() - HOMES_KEPT_DAYS * 864e5;
  try {
    for (const name of fs6.readdirSync(root)) {
      const dir = path5.join(root, name);
      if (dir === keep || !/^[0-9a-f]{16}$/.test(name)) continue;
      if (fs6.statSync(dir).mtimeMs < cutoff) fs6.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
  }
}
function inCopy(prompt, project) {
  if (!project || project.root === project.copy) return prompt;
  const root = resolved(project.root);
  let out = "";
  let from = 0;
  for (const { raw, at, abs } of pathsIn(prompt)) {
    const p = resolved(abs);
    if (!inside(p, root)) continue;
    out += prompt.slice(from, at) + path5.join(project.copy, path5.relative(root, p));
    from = at + raw.length;
  }
  return out + prompt.slice(from);
}
function invocation(req) {
  const prompt = inCopy(req.prompt, req.project);
  const args = [
    // -p takes the prompt as its value; one that starts with "-" would be read as an option: a leading space keeps it a value.
    "-p",
    prompt.startsWith("-") ? ` ${prompt}` : prompt,
    "--output-format",
    "stream-json",
    "--mode",
    req.mode === "read" ? "plan" : "accept-edits",
    "--sandbox",
    // agy's own limit (5m by default) would end a long run with partial output and exit 0; Pitroom's timeout governs.
    "--print-timeout",
    "24h"
  ];
  if (req.sessionId) args.push("--conversation", req.sessionId);
  const { model, effort } = splitModel(req.model);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  const { command, prefix } = resolveCommand(binary());
  const workerDir = workerHome(req.cwd, outsideReads(prompt, req.cwd, req.project?.root));
  const env = { HOME: workerDir };
  if (process.platform === "win32") env.USERPROFILE = workerDir;
  return { command, args: [...prefix, ...args], env };
}
function classify(message) {
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|capacity/i.test(message)) return "rate-limited";
  if (/not (signed|logged) in|\bsign.?in\b|\blog ?in\b|authenticat|PERMISSION_DENIED|oauth|credential|keyring|keychain|\b401\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unknown|unsupported|invalid)|unknown model|invalid model|NOT_FOUND|\b404\b/i.test(message)) {
    return "model-unavailable";
  }
  return "other";
}
var TIMED_OUT = /print timeout after/i;
var BLOCKED = /^This request was blocked by \S+ filters\b/;
function failure(run, stderr, exitCode) {
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const envelope = lines.find((l) => l.startsWith("AGY_ERROR"));
  const detail = (envelope && fromEnvelope(envelope)) ?? lines.find((l) => /RESOURCE_EXHAUSTED|error|failed|quota|exhausted|denied|not found|\bsign.?in\b/i.test(l) && !TIMED_OUT.test(l));
  if (exitCode === 0 && !run.error) {
    if (BLOCKED.test(run.finalText)) return { kind: "other", message: `the model's filter blocked the request: ${run.finalText.split("\n")[0]}` };
    if (run.finalText) return void 0;
    if (detail) return { kind: classify(detail), message: detail };
    if (lines.some((l) => TIMED_OUT.test(l))) return { kind: "other", message: "agy stopped at its own --print-timeout before answering" };
    if (run.usage.denied) return { kind: "other", message: "agy ended its turn without an answer when a tool call was refused" };
    if (!run.sessionId && !stderr.trim()) return { kind: "other", message: "agy printed nothing (some agy versions write no output to a pipe); update agy" };
    return { kind: "other", message: "agy ended without an answer (a refused tool call ends its turn with no other sign)" };
  }
  const message = run.error ?? detail ?? lines.at(-1) ?? `agy exited with code ${exitCode}`;
  return { kind: classify(`${message} ${detail ?? ""}`), message };
}
function warnings(_run, stderr) {
  const lost = /conversation "([^"]+)" not found/i.exec(stderr);
  return lost ? [`agy did not find the earlier conversation (${lost[1]}) and started a new one: this answer does not know the earlier turns`] : [];
}
function fromEnvelope(line) {
  try {
    const e = JSON.parse(line.slice(line.indexOf("{")));
    if (typeof e.short_error === "string" && e.short_error) return e.short_error;
    const text = [e.status ?? e.code, e.message ?? e.error].filter((v) => typeof v === "string" && v).join(": ");
    return text || void 0;
  } catch {
    return line.replace(/^AGY_ERROR:?\s*/, "") || void 0;
  }
}
function doctor({ models, hasFallback }) {
  const version = agy(["--version"]);
  if (version.missing || !version.ok) {
    return [{
      level: "fail",
      message: `agy not runnable (${binary()}). Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash), or set PITROOM_ANTIGRAVITY_BIN`
    }];
  }
  const checks = [
    { level: "ok", message: `Antigravity CLI ${version.out.trim().split("\n")[0]} at ${binary()}` },
    {
      level: "warn",
      message: "the Antigravity worker is in beta (checked against agy 1.3.5). agy has no read-only mode for headless runs, so its read runs always read a snapshot of the project; prefer -i for changes"
    }
  ];
  if (process.platform === "win32") {
    checks.push({ level: "warn", message: "agy's permission rules and terminal sandbox are for macOS and Linux; on Windows run the Antigravity worker only with -i (an isolated copy)" });
  }
  if (process.platform === "linux" && !fs6.existsSync(path5.join(userDir(), TOKEN))) {
    checks.push({ level: "warn", message: "no Antigravity sign-in file found: if a run fails to sign in, run `agy` once and sign in with your Google account" });
  }
  for (const m of models) checks.push({ level: "ok", message: m ? `Antigravity model: ${m}` : "Antigravity model: agy's own choice (`agy models` lists yours)" });
  checks.push({ level: "ok", message: "Antigravity workers have no web access (--web does not apply to them)" });
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Antigravity runs (its quota is per account and can run out for hours)" });
  return checks;
}
var antigravity = {
  id: "antigravity",
  name: "Antigravity CLI",
  capabilities: { readOnly: "snapshot", resume: "by-id", reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  warnings,
  doctor
};

// src/backends/claude/index.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import fs7 from "node:fs";
import os4 from "node:os";
import path6 from "node:path";

// src/backends/claude/events.ts
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var DENIED2 = /permission|not allowed|denied|blocked|disallowed/i;
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
          if (EDIT_TOOLS2.has(c.name) && c.input?.file_path) pendingEdits.set(c.id, String(c.input.file_path));
          if (timeline.length < MAX_STEPS) {
            const step = { kind: EDIT_TOOLS2.has(c.name) ? "edit" : c.name === "Bash" ? "shell" : "tool", name: c.name, text: clip(String(target ?? ""), 240) };
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
          if (DENIED2.test(text)) usage.denied++;
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

// src/backends/claude/index.ts
var binary2 = () => findBinary("claude", "PITROOM_CLAUDE_BIN", ["~/.local/bin/claude", "~/.claude/local/claude"]);
function cl(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary2());
  const r = spawnSync2(command, [...prefix, ...args], {
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
var DENY_BASH = FORBIDDEN_COMMANDS.map((c) => `Bash(${c}:*)`);
var SECRETS = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "**/id_ed25519*"].map((p) => `Read(${p})`);
function toolsFor(mode, web2) {
  return [...mode === "read" ? READ_TOOLS : WRITE_TOOLS, ...web2 ? WEB_TOOLS : []];
}
function invocation2(req) {
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
  const { command, prefix } = resolveCommand(binary2());
  return { command, args: [...prefix, ...args], env: { DISABLE_AUTOUPDATER: "1" } };
}
function classify2(message) {
  if (/authentication_failed|failed to authenticate|oauth|not logged in|\/login|invalid api key|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/rate.?limit|too many requests|\b429\b|\b529\b|overloaded|usage limit|limit reached|quota|capacity/i.test(message)) return "rate-limited";
  if (/model[^.]*(not found|does not exist|invalid|not available)|invalid model|not_found_error/i.test(message)) return "model-unavailable";
  return "other";
}
function failure2(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.trim().split("\n").filter(Boolean).pop();
  const message = run.error ?? detail ?? `claude exited with code ${exitCode}`;
  return { kind: classify2(message), message };
}
function defaultModel() {
  try {
    const settings2 = JSON.parse(fs7.readFileSync(path6.join(os4.homedir(), ".claude", "settings.json"), "utf8"));
    return typeof settings2.model === "string" ? settings2.model : void 0;
  } catch {
    return void 0;
  }
}
function doctor2({ models, hasFallback }) {
  const version = cl(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `claude not runnable (${binary2()}). Install Claude Code, or set PITROOM_CLAUDE_BIN` }];
  }
  const checks = [{ level: "ok", message: `Claude Code ${version.out.trim()} at ${binary2()}` }];
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
  const models = ["haiku", "sonnet", "opus"].map((id2) => ({ id: id2, efforts: CLAUDE_EFFORTS }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def, efforts: CLAUDE_EFFORTS });
  return { models, source: "Claude Code aliases (latest of each size) and --effort levels from `claude --help`" };
}
var claude = {
  id: "claude",
  name: "Claude Code",
  capabilities: { readOnly: "tool-allowlist", resume: "by-id", reportsCost: true, attachFiles: false },
  binary: binary2,
  catalog,
  invocation: invocation2,
  parse: parseEvents2,
  failure: failure2,
  defaultModel,
  doctor: doctor2
};

// src/backends/codex/index.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import fs8 from "node:fs";
import os5 from "node:os";
import path7 from "node:path";

// src/backends/codex/events.ts
var WORK = /* @__PURE__ */ new Set(["agent_message", "reasoning", "command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"]);
var TOOLS = /* @__PURE__ */ new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
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
          lastActivity = `says: ${oneLine(finalText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip(finalText, 600) });
        } else if (it.type === "command_execution") {
          if (it.status === "declined" || /operation not permitted|sandbox/i.test(String(it.aggregated_output ?? ""))) usage.denied++;
          lastActivity = `shell ${oneLine(String(it.command ?? ""), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "shell", name: "shell", text: clip(String(it.command ?? "").replace(/^\/bin\/\w+ -lc /, ""), 240), ok: it.exit_code === 0 });
        } else if (it.type === "file_change") {
          const paths = (it.changes ?? []).map((c) => String(c.path));
          if (it.status !== "failed" && it.status !== "declined") edits.push(...paths);
          else usage.denied++;
          lastActivity = `edit ${oneLine(paths.join(", "), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: "edit", name: "edit", text: clip(paths.join(", "), 240), ok: it.status !== "failed" && it.status !== "declined" });
        }
        break;
      }
      case "turn.completed": {
        const u = e.usage ?? {};
        const cached3 = num(u.cached_input_tokens);
        const reasoning = num(u.reasoning_output_tokens);
        usage.input += Math.max(0, num(u.input_tokens) - cached3);
        usage.cacheRead += cached3;
        usage.cacheWrite += num(u.cache_write_input_tokens);
        usage.output += Math.max(0, num(u.output_tokens) - reasoning);
        usage.reasoning += reasoning;
        usage.total += num(u.input_tokens) + num(u.output_tokens);
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

// src/backends/codex/index.ts
var binary3 = () => findBinary("codex", "PITROOM_CODEX_BIN");
var codexHome = () => process.env.CODEX_HOME ?? path7.join(os5.homedir(), ".codex");
function cx(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary3());
  const r = spawnSync3(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, missing: !!r.error };
}
var SANDBOX = { read: "read-only", write: "workspace-write", isolate: "workspace-write" };
var toml = (s) => JSON.stringify(s);
function invocation3(req) {
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
  const { command, prefix } = resolveCommand(binary3());
  return { command, args: [...prefix, ...args], env: {} };
}
function classify3(message) {
  if (/not supported|model[^.]*(not found|does not exist|unknown|unavailable)|unsupported model|no such model/i.test(message)) {
    return "model-unavailable";
  }
  if (/rate.?limit|too many requests|\b429\b|usage limit|quota|overloaded|\b50[23]\b|capacity/i.test(message)) return "rate-limited";
  if (/unauthori[sz]ed|\b40[13]\b|not logged in|log ?in|api.?key|credits?\b|billing|subscription/i.test(message)) return "auth";
  return "other";
}
function failure3(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.split("\n").find((l) => /^Error[: ]|ERROR/.test(l) && !/rmcp|models cache/.test(l));
  let message = run.error ?? (detail ? detail.trim() : `codex exited with code ${exitCode}`);
  if (/not supported when using Codex/i.test(message)) message += " (an outdated Codex CLI says this too: npm i -g @openai/codex@latest)";
  return { kind: classify3(message), message };
}
function resolveModel(sessionId) {
  const root = path7.join(codexHome(), "sessions");
  const day = (d) => path7.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  const now = /* @__PURE__ */ new Date();
  for (const dir of [day(now), day(new Date(now.getTime() - 864e5))]) {
    let files = [];
    try {
      files = fs8.readdirSync(dir).filter((f) => f.includes(sessionId));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /"model":"([^"]+)"/.exec(fs8.readFileSync(path7.join(dir, f), "utf8"));
      if (m) return m[1];
    }
  }
  return void 0;
}
function doctor3({ models, hasFallback }) {
  const version = cx(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `codex not runnable (${binary3()}). Install: npm i -g @openai/codex, or set PITROOM_CODEX_BIN` }];
  }
  const checks = [{ level: "ok", message: `${version.out.trim()} at ${binary3()}` }];
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
  const file = path7.join(codexHome(), "models_cache.json");
  try {
    const raw = JSON.parse(fs8.readFileSync(file, "utf8"));
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
  binary: binary3,
  invocation: invocation3,
  parse: parseEvents3,
  failure: failure3,
  resolveModel,
  doctor: doctor3
};

// src/backends/gemini/index.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import fs9 from "node:fs";
import os6 from "node:os";
import path8 from "node:path";
import { fileURLToPath } from "node:url";

// src/backends/gemini/events.ts
var EDIT_TOOLS3 = /* @__PURE__ */ new Set(["replace", "write_file", "edit"]);
var DENIED3 = /policy|permission|not allowed|denied|blocked|disallowed|refus/i;
function parseEvents4(jsonl) {
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
    lastActivity = `says: ${oneLine(said)}`;
    if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip(said, 600) });
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
      lastActivity = `${name} ${target ? oneLine(String(target), 60) : ""}`.trim();
      const file = p.file_path ?? p.absolute_path ?? p.path;
      if (EDIT_TOOLS3.has(name) && file) pendingEdits.set(String(e.tool_id), String(file));
      if (timeline.length < MAX_STEPS) {
        const step = { kind: EDIT_TOOLS3.has(name) ? "edit" : name === "run_shell_command" ? "shell" : "tool", name, text: clip(String(target ?? ""), 240) };
        timeline.push(step);
        stepOf.set(String(e.tool_id), step);
      }
    } else if (e.type === "tool_result") {
      inTurn = false;
      const ok = e.status === "success";
      const step = stepOf.get(String(e.tool_id));
      if (step) step.ok = ok;
      if (!ok && DENIED3.test(`${e.error?.type ?? ""} ${e.error?.message ?? ""}`)) usage.denied++;
      if (ok && pendingEdits.has(String(e.tool_id))) edits.push(pendingEdits.get(String(e.tool_id)));
    } else if (e.type === "error") {
      if (e.severity === "error") error ??= String(e.message ?? "Gemini CLI error");
    } else if (e.type === "result") {
      const s = e.stats ?? {};
      const cached3 = num(s.cached);
      usage.cacheRead += cached3;
      usage.input += s.input !== void 0 ? num(s.input) : Math.max(0, num(s.input_tokens) - cached3);
      usage.output += num(s.output_tokens);
      usage.total += num(s.total_tokens) || num(s.input_tokens) + num(s.output_tokens);
      usage.toolCalls = Math.max(usage.toolCalls, num(s.tool_calls));
      model ??= Object.keys(s.models ?? {})[0];
      if (e.status === "error") error ??= String(e.error?.message ?? e.error?.type ?? "Gemini CLI error");
    }
  }
  flush();
  usage.steps = turns;
  return { sessionId, model, finalText: error ? "" : lastText, usage, tools, edits, lastActivity, timeline, error };
}

// src/backends/gemini/index.ts
var binary4 = () => findBinary("gemini", "PITROOM_GEMINI_BIN", ["~/.local/bin/gemini"]);
function gem(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary4());
  const r = spawnSync4(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var policyDir = () => path8.resolve(path8.dirname(fileURLToPath(import.meta.url)), "..", "policies", "gemini");
function workerHome2() {
  const root = path8.join(home(), "gemini-home");
  const dir = path8.join(root, ".gemini");
  const base = JSON.parse(fs9.readFileSync(path8.join(policyDir(), "worker-settings.json"), "utf8"));
  const auth = settings().security?.auth;
  const body = `${JSON.stringify(auth ? { ...base, security: { ...base.security, auth } } : base, null, 2)}
`;
  writeIfChanged(path8.join(dir, "settings.json"), body);
  for (const name of ["oauth_creds.json", "google_accounts.json"]) linkInto(dir, path8.join(geminiHome(), name));
  return root;
}
function invocation4(req) {
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
  for (const p of policies) args.push("--policy", path8.join(dir, p));
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (process.env.PITROOM_GEMINI_TRUST === "1") args.push("--skip-trust");
  const [model] = (req.model ?? "").split("#");
  if (model) args.push("--model", model);
  const { command, prefix } = resolveCommand(binary4());
  const env = { GEMINI_CLI_HOME: workerHome2() };
  const trusted = path8.join(geminiHome(), "trustedFolders.json");
  if (fs9.existsSync(trusted)) env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = trusted;
  return { command, args: [...prefix, ...args], env };
}
function classify4(message) {
  if (/IneligibleTier|no longer supported for Gemini|error authenticating|not logged in|please (log ?in|sign in)|credentials|api key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return "auth";
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|exhausted your capacity|capacity/i.test(message)) return "rate-limited";
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unsupported|invalid)|\b404\b|NOT_FOUND|invalid model|is not supported/i.test(message)) return "model-unavailable";
  return "other";
}
var UNTRUSTED = "Gemini CLI does not trust this folder: open `gemini` in it once and trust it, or set PITROOM_GEMINI_TRUST=1 (the folder's own Gemini settings, hooks included, then load)";
function failure4(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const raw = run.error ?? detail ?? `gemini exited with code ${exitCode}`;
  const message = /not running in a trusted directory/i.test(`${stderr} ${raw}`) ? UNTRUSTED : raw;
  return { kind: classify4(message), message };
}
function geminiHome() {
  return path8.join(process.env.GEMINI_CLI_HOME ?? os6.homedir(), ".gemini");
}
function settings() {
  try {
    return JSON.parse(fs9.readFileSync(path8.join(geminiHome(), "settings.json"), "utf8"));
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
function doctor4({ models, hasFallback }) {
  const version = gem(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `gemini not runnable (${binary4()}). Install Gemini CLI (npm i -g @google/gemini-cli), or set PITROOM_GEMINI_BIN` }];
  }
  const checks = [{ level: "ok", message: `Gemini CLI ${version.out.trim()} at ${binary4()}` }];
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const vertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" || process.env.GOOGLE_GENAI_USE_VERTEXAI === "1";
  const signedIn = fs9.existsSync(path8.join(geminiHome(), "oauth_creds.json"));
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
  const models = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview"].map((id2) => ({ id: id2 }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def });
  return { models, source: "Gemini CLI's built-in model names (it cannot list models); the effort suffix is not used" };
}
var gemini = {
  id: "gemini",
  name: "Gemini CLI",
  capabilities: { readOnly: "approval-mode", resume: "by-id", reportsCost: false, attachFiles: false },
  binary: binary4,
  catalog: catalog3,
  invocation: invocation4,
  parse: parseEvents4,
  failure: failure4,
  defaultModel: defaultModel2,
  doctor: doctor4
};

// src/backends/kilo/index.ts
import { spawnSync as spawnSync6 } from "node:child_process";
import path10 from "node:path";

// src/backends/opencode/index.ts
import { spawnSync as spawnSync5 } from "node:child_process";

// src/backends/opencode/events.ts
var EDIT_TOOLS4 = /* @__PURE__ */ new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
var DENIED4 = /rule which prevents you|permission denied|permission\.rejected/i;
function parseEvents5(ndjson) {
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
        lastActivity = `says: ${oneLine(text)}`;
        if (timeline.length < MAX_STEPS) timeline.push({ kind: "say", text: clip(text.trim(), 600), at: stamp(e.timestamp) });
        break;
      }
      case "tool_use": {
        const name = String(p.tool ?? "tool");
        const st = p.state ?? {};
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === "error" && DENIED4.test(String(st.error ?? ""))) usage.denied++;
        if (st.status === "completed" && EDIT_TOOLS4.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe2(st.input)}`.trim();
        if (timeline.length < MAX_STEPS) {
          const kind2 = EDIT_TOOLS4.has(name) ? "edit" : /^(bash|shell)$/.test(name) ? "shell" : "tool";
          const text = kind2 === "shell" ? String(st.input?.command ?? "") : String(st.input?.filePath ?? st.input?.path ?? st.input?.pattern ?? st.input?.url ?? "") || describe2(st.input);
          timeline.push({ kind: kind2, name, text: clip(text, 240), ok: st.status === "completed" ? true : st.status === "error" ? false : void 0, at: stamp(e.timestamp) });
        }
        break;
      }
      case "step_finish": {
        const t = p.tokens ?? {};
        usage.steps++;
        usage.input += num(t.input);
        usage.output += num(t.output);
        usage.reasoning += num(t.reasoning);
        usage.cacheRead += num(t.cache?.read);
        usage.cacheWrite += num(t.cache?.write);
        usage.total += num(t.total) || num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read);
        usage.cost = (usage.cost ?? 0) + num(p.cost);
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
var stamp = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function describe2(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v ? oneLine(String(v), 60) : "";
}

// src/backends/opencode/profiles.ts
import fs10 from "node:fs";
import os7 from "node:os";
import path9 from "node:path";
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
  "kilo *",
  "kilocode*",
  "agy *",
  "pitroom *",
  "*pitroom*"
];
function scratchDirs(app) {
  const data = process.env.XDG_DATA_HOME ?? path9.join(os7.homedir(), ".local", "share");
  const rules = {
    "*": "deny",
    [path9.join(data, app, "tool-output", "*")]: "allow",
    [path9.join(data, app, "shell", "*", "*")]: "allow"
  };
  for (const tmp of /* @__PURE__ */ new Set([os7.tmpdir(), realpath(os7.tmpdir())])) rules[path9.join(tmp, app, "*")] = "allow";
  return rules;
}
function realpath(p) {
  try {
    return fs10.realpathSync(p);
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
function readProfile(allowWeb = false, app = "opencode") {
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
    external_directory: scratchDirs(app),
    ...COMMON
  };
}
function writeProfile(allowWeb = false, app = "opencode") {
  const bash = { "*": "allow" };
  for (const pattern of FORBIDDEN_BASH) bash[pattern] = "deny";
  return {
    "*": "allow",
    read: READ_FILES,
    ...web(allowWeb),
    bash,
    shell: bash,
    external_directory: scratchDirs(app),
    ...COMMON
  };
}
function agentFor(mode) {
  return mode === "read" ? AGENT.read : AGENT.write;
}
function configContent(existing, allowWeb = false, app = "opencode", extra = {}) {
  const ours = {
    ...extra,
    agent: {
      [AGENT.read]: {
        mode: "primary",
        description: "pitroom: read-only worker (research, search, review)",
        permission: readProfile(allowWeb, app)
      },
      [AGENT.write]: {
        mode: "primary",
        description: "pitroom: editing worker (no git history changes, no bulk deletes)",
        permission: writeProfile(allowWeb, app)
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
var binary5 = () => findBinary("opencode", "PITROOM_OPENCODE_BIN", ["~/.opencode/bin/opencode"]);
function oc(args, opts = {}) {
  const { command, prefix } = resolveCommand(binary5());
  const r = spawnSync5(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 6e4,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var jsonIn = (s) => JSON.parse(s.slice(s.indexOf("{")));
function invocation5(req) {
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
  const { command, prefix } = resolveCommand(binary5());
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
function classify5(message) {
  if (/model not found|ModelNotFound|unknown model|no such model|deprecated/i.test(message)) return "model-unavailable";
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded|\b50[23]\b|unavailable|capacity/i.test(message)) return "rate-limited";
  if (/provider\.auth|FreeTierError|free tier|unauthori[sz]ed|\b40[13]\b|api.?key|insufficient|credits?\b|billing|payment/i.test(message)) {
    return "auth";
  }
  return "other";
}
function failure5(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `opencode exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify5(message), message };
}
function modelId(m) {
  if (typeof m === "string") return m;
  const id2 = m?.model ?? m?.id;
  return m?.providerID && id2 ? `${m.providerID}/${id2}` : void 0;
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
    models: (ids.length ? ids : listModels()).map((id2) => ({ id: id2 })),
    source: "`opencode models` (reasoning variants are provider-specific: provider/model#variant)"
  };
}
function listModels() {
  return oc(["models"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
}
function doctor5({ models, hasFallback }) {
  const checks = [];
  const version = oc(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `opencode not runnable (${binary5()}). Install: https://opencode.ai or set PITROOM_OPENCODE_BIN` }];
  }
  const v = version.out.trim().replace(/^opencode\s+/i, "");
  const major = majorVersion(v);
  if (major !== void 0 && major < 2) {
    return [{ level: "fail", message: `OpenCode ${v} is too old: Pitroom needs OpenCode v2 or newer (run \`opencode upgrade\`)` }];
  }
  checks.push({ level: "ok", message: `opencode ${v} at ${binary5()} (private --standalone server per run)` });
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
  binary: binary5,
  invocation: invocation5,
  parse: parseEvents5,
  failure: failure5,
  defaultModel: defaultModel3,
  resolveModel: resolveModel2,
  listModels,
  catalog: catalog4,
  doctor: doctor5
};

// src/backends/kilo/index.ts
var binary6 = () => findBinary("kilo", "PITROOM_KILO_BIN", ["~/.kilo/bin/kilo"]);
function kilo(args, timeout = 6e4) {
  const { command, prefix } = resolveCommand(binary6());
  const r = spawnSync6(command, [...prefix, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
function invocation6(req) {
  const args = [
    "run",
    "--agent",
    agentFor(req.mode),
    "--format",
    "json",
    "--title",
    req.title,
    // Some failure causes only appear in the server logs (Kilo takes the level in capitals only).
    "--print-logs",
    "--log-level",
    "ERROR"
  ];
  if (req.model) args.push("--model", req.model);
  if (req.sessionId) args.push("--session", req.sessionId);
  for (const f of req.files) args.push("--file", f);
  args.push(req.prompt);
  const { command, prefix } = resolveCommand(binary6());
  return {
    command,
    args: [...prefix, ...args],
    env: {
      // A worker run must not upgrade Kilo underneath the user.
      KILO_CONFIG_CONTENT: configContent(process.env.KILO_CONFIG_CONTENT, req.web, "kilo", { autoupdate: false }),
      // No daemon to attach to: a private server per run (see above).
      XDG_STATE_HOME: path10.join(home(), "kilo-state")
    }
  };
}
function failure6(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `kilo exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify5(message), message };
}
function listModels2() {
  return kilo(["models"]).out.split("\n").map((s) => s.trim()).filter((s) => /^[\w.-]+\/\S+$/.test(s));
}
function defaultModel4() {
  try {
    const out = kilo(["debug", "config"], 3e4).out;
    const model = JSON.parse(out.slice(out.indexOf("{"))).model;
    return typeof model === "string" ? model : void 0;
  } catch {
    return void 0;
  }
}
function catalog5() {
  return { models: listModels2().map((id2) => ({ id: id2 })), source: "`kilo models` (reasoning variants are provider-specific: provider/model#variant)" };
}
function doctor6({ models, hasFallback }) {
  const version = kilo(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `kilo not runnable (${binary6()}). Install Kilo Code's CLI (npm i -g @kilocode/cli), or set PITROOM_KILO_BIN` }];
  }
  const checks = [{ level: "ok", message: `Kilo Code ${version.out.trim().split("\n").pop()} at ${binary6()} (beta worker: checked against 7.8)` }];
  const def = defaultModel4();
  for (const m of models) {
    const model = m ?? def;
    checks.push(model ? { level: "ok", message: `Kilo Code ${m ? "model" : "default model"}: ${model}` } : { level: "warn", message: 'Kilo Code has no default model: pass -W kilo:<provider/model> or set "model" in its config' });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Kilo Code runs" });
  checks.push({ level: "ok", message: `permission profiles ${AGENT.read}/${AGENT.write} injected per run through KILO_CONFIG_CONTENT` });
  return checks;
}
var kiloBackend = {
  id: "kilo",
  name: "Kilo Code",
  capabilities: { readOnly: "permission-rules", resume: "by-id", reportsCost: true, attachFiles: true },
  binary: binary6,
  invocation: invocation6,
  parse: parseEvents5,
  failure: failure6,
  defaultModel: defaultModel4,
  listModels: listModels2,
  catalog: catalog5,
  doctor: doctor6
};

// src/backends/qwen/index.ts
import { spawnSync as spawnSync7 } from "node:child_process";
import fs11 from "node:fs";
import os8 from "node:os";
import path11 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/backends/qwen/events.ts
var EDIT_TOOLS5 = /* @__PURE__ */ new Set(["write_file", "edit", "notebook_edit"]);
var SHELL2 = "run_shell_command";
var DENIED5 = /permission was declined|denied by permission rules|requires permission|not allowed/i;
var API_ERROR = /^\[API Error: /;
function parseEvents6(jsonl) {
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, toolCalls: 0, denied: 0 };
  const tools = {};
  const edits = [];
  const pendingEdits = /* @__PURE__ */ new Map();
  const timeline = [];
  const stepOf = /* @__PURE__ */ new Map();
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
    } else if (e.type === "system" && e.subtype === "retry") {
      lastActivity = `waiting to retry (attempt ${e.data?.attempt ?? "?"} of ${e.data?.maxRetries ?? "?"})`;
    } else if (e.type === "assistant") {
      const content = e.message?.content ?? [];
      const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join(" ").trim();
      if (API_ERROR.test(text)) {
        error = apiError(text);
        continue;
      }
      usage.steps++;
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
          if (EDIT_TOOLS5.has(c.name) && c.input?.file_path) pendingEdits.set(String(c.id), String(c.input.file_path));
          if (timeline.length < MAX_STEPS) {
            const step = { kind: EDIT_TOOLS5.has(c.name) ? "edit" : c.name === SHELL2 ? "shell" : "tool", name: c.name, text: clip(String(target ?? ""), 240) };
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
          if (DENIED5.test(text)) usage.denied++;
        } else if (pendingEdits.has(String(c.tool_use_id))) {
          edits.push(pendingEdits.get(String(c.tool_use_id)));
        }
      }
    } else if (e.type === "result") {
      const u = e.usage ?? {};
      usage.input += Math.max(0, num(u.input_tokens) - num(u.cache_read_input_tokens));
      usage.cacheRead += num(u.cache_read_input_tokens);
      usage.output += num(u.output_tokens);
      usage.total += num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens);
      usage.denied = Math.max(usage.denied, Array.isArray(e.permission_denials) ? e.permission_denials.length : 0);
      if (e.is_error) {
        error ??= apiError(String(e.error?.message ?? e.result ?? e.subtype ?? "Qwen Code error"));
      } else if (typeof e.result === "string") {
        finalText = e.result.trim();
      }
    }
  }
  return { sessionId, model, finalText: finalText ?? (error ? "" : lastText), usage, tools, edits, lastActivity, timeline, error };
}
var apiError = (text) => text.replace(API_ERROR, "").replace(/\](?=\s*(\n|$))/, "").replace(/\s+/g, " ").trim() || text;

// src/backends/qwen/index.ts
var binary7 = () => findBinary("qwen", "PITROOM_QWEN_BIN", ["~/.local/bin/qwen", "~/.npm-global/bin/qwen"]);
var policyDir2 = () => path11.resolve(path11.dirname(fileURLToPath2(import.meta.url)), "..", "policies", "qwen");
var EXCLUDED = [
  "agent",
  "send_message",
  "skill",
  "manage_memory",
  "search_memory",
  "enter_worktree",
  "exit_worktree",
  "record_artifact",
  "cron_create",
  "cron_list",
  "cron_delete",
  "loop_wakeup",
  "task_stop",
  "update_goal",
  "get_goal",
  "list_agents",
  "report_findings",
  "tool_call",
  "tool_search",
  "read_mcp_resource"
];
var WEB = ["web_fetch", "web_search"];
var EDITS_HERE = ["Edit(./**)", "write_file(./**)", "notebook_edit(./**)"];
var DENY_SHELL = FORBIDDEN_COMMANDS.map((c) => `run_shell_command(${c})`);
function invocation7(req) {
  const read = req.mode === "read";
  const exclude = [...EXCLUDED, ...req.web ? [] : WEB, ...read ? [] : DENY_SHELL];
  const args = [
    // The prompt is the first word: the list options below take every word that follows them, and Qwen Code reads
    // no prompt after "--". One that starts with "-" would be read as an option: a leading space keeps it the prompt.
    req.prompt.startsWith("-") ? ` ${req.prompt}` : req.prompt,
    "--safe-mode",
    "--output-format",
    "stream-json",
    "--approval-mode",
    read ? "plan" : "default",
    "--exclude-tools",
    ...exclude
  ];
  if (!read) args.push("--allowed-tools", ...EDITS_HERE, "run_shell_command");
  const model = (req.model ?? "").split("#")[0];
  if (model) args.push("--model", model);
  if (req.sessionId) args.push("--resume", req.sessionId);
  const { command, prefix } = resolveCommand(binary7());
  return {
    command,
    args: [...prefix, ...args],
    env: {
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path11.join(policyDir2(), "worker-defaults.json"),
      QWEN_CODE_DISABLE_CRON: "1",
      QWEN_DISABLE_AUTO_TITLE: "1"
    }
  };
}
function classify6(message) {
  if (/\b40[13]\b|incorrect api key|invalid api key|unauthori[sz]ed|authenticat|not logged in|no auth/i.test(message)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|quota|capacity|overloaded|\b529\b/i.test(message)) return "rate-limited";
  if (/model[^.]*(not found|does not exist|not available|not supported)|invalid model|model_not_found|\b404\b/i.test(message)) return "model-unavailable";
  return "other";
}
function failure7(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.trim().split("\n").filter((l) => l.trim() && !/SAFE MODE/.test(l)).pop();
  const message = run.error ?? detail ?? `qwen exited with code ${exitCode}`;
  return { kind: classify6(message), message };
}
function userSettings() {
  try {
    return JSON.parse(fs11.readFileSync(path11.join(process.env.QWEN_HOME ?? path11.join(os8.homedir(), ".qwen"), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}
function defaultModel5() {
  const name = userSettings().model?.name;
  return typeof name === "string" && name ? name : void 0;
}
function doctor7({ models, hasFallback }) {
  const { command, prefix } = resolveCommand(binary7());
  const r = spawnSync7(command, [...prefix, "--version"], { encoding: "utf8", timeout: 6e4, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return [{ level: "fail", message: `qwen not runnable (${binary7()}). Install Qwen Code (npm i -g @qwen-code/qwen-code), or set PITROOM_QWEN_BIN` }];
  const checks = [{ level: "ok", message: `Qwen Code ${r.stdout.trim()} at ${binary7()} (beta worker: checked against Qwen Code 0.25)` }];
  const auth = userSettings().security?.auth?.selectedType;
  const key = process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
  checks.push(
    auth || key ? { level: "ok", message: `Qwen Code: sign-in ${auth ?? "from an API key in the environment"}` } : { level: "warn", message: "Qwen Code has no sign-in method set: run `qwen` once to choose one, or set OPENAI_API_KEY (and OPENAI_BASE_URL) for an OpenAI-compatible provider" }
  );
  for (const m of models) {
    const model = m ?? defaultModel5();
    checks.push({ level: model ? "ok" : "warn", message: model ? `Qwen Code model: ${model}` : "Qwen Code model: none pinned (pass -W qwen:<model> or set model.name in ~/.qwen/settings.json)" });
  }
  if (!hasFallback) checks.push({ level: "warn", message: "no fallback workers configured for Qwen Code runs" });
  return checks;
}
var qwen = {
  id: "qwen",
  name: "Qwen Code",
  capabilities: { readOnly: "approval-mode", resume: "by-id", reportsCost: false, attachFiles: false },
  binary: binary7,
  invocation: invocation7,
  parse: parseEvents6,
  failure: failure7,
  defaultModel: defaultModel5,
  doctor: doctor7
};

// src/backends/index.ts
var REGISTRY = new Map([opencode, codex, claude, gemini, qwen, kiloBackend, antigravity].map((b) => [b.id, b]));
var DEFAULT_BACKEND = opencode.id;
var PLANNED = ["hermes"];
var backendIds = () => [...REGISTRY.keys()];
var allBackends = () => [...REGISTRY.values()];
var isBackendId = (id2) => REGISTRY.has(id2) || PLANNED.includes(id2);
function getBackend(id2) {
  const backend = REGISTRY.get(id2);
  if (backend) return backend;
  const available = backendIds().join(", ");
  throw new UserError(
    PLANNED.includes(id2) ? `the "${id2}" worker is not supported yet (available: ${available})` : `unknown worker "${id2}" (available: ${available})`,
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
import fs12 from "node:fs";
import path12 from "node:path";
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
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path12.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file) => {
    if (!lineCache.has(file)) {
      const size = fs12.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs12.readFileSync(file, "utf8").split("\n");
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
    if (path12.isAbsolute(ref.file)) return [];
    const wanted = ref.file.replace(/^(\.{1,2}\/)+/, "");
    return (byName().get(path12.basename(wanted)) ?? []).filter((f) => f.split(path12.sep).join("/").endsWith(`/${wanted}`) || path12.basename(f) === wanted).slice(0, 20);
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
      invalid.push({ ref: ref.text, reason: path12.isAbsolute(ref.file) && !inside2(ref.file, roots) ? "outside the project" : "file not found" });
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
  const base = path12.basename(name);
  return !base.includes(".") || new RegExp(`^(${EXTENSIONLESS})$`).test(base) || FILE_EXTENSIONS.has(base.split(".").pop().toLowerCase());
};
function indexFiles(roots) {
  const index = /* @__PURE__ */ new Map();
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs12.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_INDEXED) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS2.has(e.name)) walk(path12.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
        const list2 = index.get(e.name);
        if (list2) list2.push(path12.join(dir, e.name));
        else index.set(e.name, [path12.join(dir, e.name)]);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}
function resolve(ref, roots) {
  const candidates = path12.isAbsolute(ref) ? inside2(ref, roots) ? [ref] : [] : roots.map((r) => path12.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs12.statSync(c).isFile() && inside2(c, roots);
    } catch {
      return false;
    }
  });
}
function inside2(file, roots) {
  return roots.some((r) => {
    const rel = path12.relative(r, path12.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path12.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// src/core/templates.ts
import fs13 from "node:fs";
import path14 from "node:path";

// src/core/install.ts
import path13 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
function packageRoot() {
  return path13.resolve(path13.dirname(fileURLToPath3(import.meta.url)), "..");
}

// src/core/templates.ts
var FILES = {
  implementer: "pitroom-driven-development/implementer-prompt.md",
  "task-reviewer": "pitroom-driven-development/task-reviewer-prompt.md",
  "re-review": "pitroom-driven-development/re-review-prompt.md",
  "code-reviewer": "pitroom-review/code-reviewer.md"
};
function loadTemplate(name, root = packageRoot()) {
  const file = path14.join(root, "skills", FILES[name]);
  if (!fs13.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs13.readFileSync(file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}
function fill(template, values) {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in values));
  if (missing.length) throw new UserError(`no value for template placeholder(s): ${[...new Set(missing)].join(", ")}`, 3);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key]);
}

// src/core/cooldown.ts
var MAX_MS = 24 * 36e5;
var OVERLOAD_MS = 20 * 6e4;
var DAILY_MS = 4 * 36e5;
function retryAfterMs(message) {
  const compact2 = /(?:retry|try again|resets?|available again)[^0-9]{0,24}((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i.exec(message)?.[1];
  const words = /(?:retry|try again|resets?)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i.exec(message);
  let ms = 0;
  if (compact2) {
    for (const [, n, unit] of compact2.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(n) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[unit.toLowerCase()];
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

// src/core/config.ts
import fs14 from "node:fs";
import os9 from "node:os";
import path15 from "node:path";
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
  auditFix: "boolean",
  auditFocus: "boolean",
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
  priceFeedHours: "number",
  budgetDaily: "number",
  rankWorkers: "boolean"
};
function configPath() {
  if (process.env.PITROOM_CONFIG) return path15.resolve(process.env.PITROOM_CONFIG);
  const base = process.platform === "win32" ? process.env.APPDATA ?? path15.join(os9.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path15.join(os9.homedir(), ".config");
  return path15.join(base, "pitroom", "config.json");
}
var cached;
function loadConfig() {
  if (cached) return cached;
  const file = configPath();
  const config = {};
  const warnings2 = [];
  if (fs14.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs14.readFileSync(file, "utf8"));
    } catch (e) {
      warnings2.push(`${file}: invalid JSON (${e.message}); ignored`);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const type = SCHEMA[key];
        if (!type) {
          warnings2.push(`${file}: unknown key "${key}" ignored`);
        } else if (matches(value, type)) {
          config[key] = value;
        } else {
          warnings2.push(`${file}: "${key}" must be ${type}; ignored`);
        }
      }
    }
  }
  cached = { config, warnings: warnings2 };
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
var amount = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : void 0;
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
function setting(flag, env, conf, fallback) {
  if (flag !== void 0) return { value: flag, source: "flag" };
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
    auditFix: setting(void 0, flag01(e.PITROOM_AUDIT_FIX), c.auditFix, false),
    auditFocus: setting(void 0, flag01(e.PITROOM_AUDIT_FOCUS), c.auditFocus, false),
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
    priceFeedHours: setting(void 0, positiveInt(e.PITROOM_PRICE_FEED_HOURS), positiveInt(c.priceFeedHours), 24),
    rankWorkers: setting(void 0, flag01(e.PITROOM_RANK_WORKERS), c.rankWorkers, false),
    budgetDaily: setting(void 0, amount(e.PITROOM_BUDGET_DAILY), amount(c.budgetDaily), void 0)
  };
}

// src/core/audit.ts
var ASKS_FOR_LIST = /\b(all|every|each|list|lists|enumerate|how many|count|which)\b/i;
function focusedRate(base, task, record) {
  if (base <= 0 || base >= 1) return { rate: base, why: [] };
  let rate2 = base;
  const why = [];
  if (ASKS_FOR_LIST.test(task)) {
    rate2 *= 2;
    why.push("asks for a list or a count");
  }
  if (record && record.audited >= 3 && record.agreed / record.audited < 0.5) {
    rate2 *= 2;
    why.push(`the worker's audited answers were confirmed ${record.agreed} of ${record.audited} times`);
  } else if (record && record.audited >= 5 && record.agreed === record.audited) {
    rate2 /= 2;
    why.push(`the worker's ${record.audited} audited answers were all confirmed`);
  }
  return { rate: Math.min(rate2, 1), why };
}
function fixTask(disputed) {
  return [
    "Another worker audited your answer above and disputed these claims:",
    ...disputed.map((d) => `- ${d}`),
    "",
    "Check each one yourself against the files (the auditor can be wrong too). Then give your whole answer again,",
    "corrected, in the same answer format: keep what holds, fix what does not, and add what was missing.",
    "Under OPEN ISSUES, say which disputed claims you accepted and which you kept, and why."
  ].join("\n");
}

// src/core/rank.ts
var MIN_RUNS = 5;
var MIN_AUDITS = 3;
function scoreOf(r) {
  if (!r || r.runs < MIN_RUNS) return void 0;
  const ok = Math.min(r.ok, r.runs) / r.runs;
  return r.audited >= MIN_AUDITS ? ok * (r.agreed / r.audited) : ok;
}
var pct = (x) => `${Math.round(x * 100)}%`;
function rankChain(chain, recordOf) {
  const scored = chain.map((t, i) => ({ t, i, score: scoreOf(recordOf(t)) }));
  const slots = scored.filter((s) => s.score !== void 0);
  if (slots.length < 2) return { chain };
  const ranked = [...slots].sort((a, b) => Math.round(b.score * 10) - Math.round(a.score * 10) || a.i - b.i);
  const out = [...chain];
  slots.forEach((slot, k) => out[slot.i] = ranked[k].t);
  if (out[0] === chain[0]) return { chain: out };
  const by = (t) => scored.find((s) => s.t === t).score;
  return {
    chain: out,
    note: `ranked by record ("rankWorkers"): ${describeTarget(out[0])} (${pct(by(out[0]))}) goes before ${describeTarget(chain[0])} (${pct(by(chain[0]))})`
  };
}

// src/core/receipt.ts
import fs16 from "node:fs";

// src/core/prices.ts
import fs15 from "node:fs";
import path16 from "node:path";
var RETRY_AFTER_FAILURE_MS = 60 * 6e4;
var catalogFile = () => path16.join(home(), "prices.json");
function trim(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [provider, p] of Object.entries(raw)) {
    for (const [id2, m] of Object.entries(p?.models ?? {})) {
      const c = m?.cost;
      const ok = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
      if (!c || !ok(c.input) || !ok(c.output)) continue;
      out[`${provider}/${id2}`] = [c.input, c.output, ok(c.cache_read) ? c.cache_read : c.input / 10];
    }
  }
  return out;
}
var cached2;
function readCatalog() {
  const file = catalogFile();
  try {
    const { mtimeMs } = fs15.statSync(file);
    if (cached2?.file === file && cached2.mtimeMs === mtimeMs) return cached2.catalog;
    const parsed = JSON.parse(fs15.readFileSync(file, "utf8"));
    const catalog6 = parsed && typeof parsed.models === "object" && parsed.models && Number.isFinite(Date.parse(parsed.fetchedAt)) ? parsed : void 0;
    cached2 = { file, mtimeMs, catalog: catalog6 };
    return catalog6;
  } catch {
    return void 0;
  }
}
var OWN = { codex: ["openai"], claude: ["anthropic"], gemini: ["google"] };
function catalogPrice(backend, ...models) {
  const catalog6 = readCatalog();
  if (!catalog6) return void 0;
  for (const raw of models) {
    const id2 = raw?.split("#")[0];
    if (!id2) continue;
    const keys = [id2, ...[...OWN[backend] ?? [], "anthropic", "openai", "google"].map((p) => `${p}/${id2}`)];
    const any = keys.find((k) => catalog6.models[k]) ?? Object.keys(catalog6.models).filter((k) => k.endsWith(`/${id2}`)).sort()[0];
    const triple = any ? catalog6.models[any] : void 0;
    if (any && triple && triple.length === 3 && triple.every((n) => Number.isFinite(n) && n >= 0)) {
      const [input, output, cachedInput] = triple;
      return { input, output, cachedInput, key: any };
    }
  }
  return void 0;
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
var costAt = (usage, price) => (usage.input * price.input + usage.cacheRead * price.cachedInput + (usage.output + usage.reasoning) * price.output) / 1e6;
var workerCostOf = (usage) => usage?.cost ?? usage?.costEstimate;
function savedUsd(usage, returnedTokens, price = primaryPrice()) {
  const readingTheReport = returnedTokens * price.input / 1e6;
  return Math.max(0, costAt(usage, price) - (workerCostOf(usage) ?? 0) - readingTheReport);
}
function readLedger(sinceMs) {
  if (!fs16.existsSync(ledgerFile())) return [];
  return fs16.readFileSync(ledgerFile(), "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  }).filter((e) => !sinceMs || Date.parse(e.at) >= sinceMs);
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
  const when = period.toUpperCase();
  const pill = 22 + when.length * 7.4;
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
<text x="${W - M - pill / 2}" y="51" class="pill" text-anchor="middle">${esc(when)}</text>
<text x="${M}" y="112" class="lab">SAVED ON YOUR MAIN CODING AGENT</text>
<text x="${M}" y="168" class="big">${esc(usd(t.saved))}</text>
${tile(0, compact(t.tokens), "Tokens offloaded")}${tile(1, t.ratio ? `${Math.round(t.ratio)}\xD7` : "\u2014", "Context compression")}${tile(2, String(t.runs), "Delegated tasks")}
<text x="${M}" y="296" class="foot">Estimated against ${esc(primaryPrice().name)} pricing \xB7 npx pitroom</text>
</svg>
`;
}

// src/core/ui.ts
var WEEK_MS = 7 * 24 * 3600 * 1e3;

// src/core/plan.ts
import fs17 from "node:fs";
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
  const abs = path17.resolve(file);
  if (!fs17.existsSync(abs) || !fs17.statSync(abs).isFile()) throw new UserError(`plan not found: ${file}`);
  const plan = parsePlan(fs17.readFileSync(abs, "utf8"), fs17.realpathSync(abs));
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
var planName = (file) => path17.basename(file).replace(/\.md$/i, "");

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

// src/core/group.ts
var retryShell = (platform = process.platform) => platform === "win32" ? "powershell" : "sh";
var quoteFor = (shell) => (s) => /^[\w./:@=\\-]+$/.test(s) && !(shell === "sh" && s.includes("\\")) ? s : shell === "sh" ? `'${s.replace(/'/g, `'\\''`)}'` : `'${s.replace(/'/g, "''")}'`;
function retryCommands(metas, shell = retryShell()) {
  const quote = quoteFor(shell);
  return metas.filter((m) => ["failed", "timeout", "stopped"].includes(m.state) && !m.auditOf && !m.reviewOf && !m.parent && !m.fixOf).map((m) => {
    const where = ["-d", quote(m.dir), ...m.group ? ["-g", quote(m.group)] : []];
    if (m.plan) return ["pitroom run", m.mode === "write" ? "-w" : "-i", "--plan", quote(m.plan.file), "--step", String(m.plan.step), ...where, "--bg"].join(" ");
    const mode = m.mode === "isolate" ? ["-i"] : m.mode === "write" ? ["-w"] : [];
    const end = shell === "sh" || m.task.startsWith("-") ? ["--"] : [];
    return ["pitroom run", ...mode, ...where, "--bg", ...end, quote(m.task)].join(" ");
  });
}

// src/core/eval.ts
import { spawnSync as spawnSync8 } from "node:child_process";
import fs18 from "node:fs";
var KINDS = ["definition", "count", "set"];
function loadEval(file) {
  let raw;
  try {
    raw = JSON.parse(fs18.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`cannot read ${file}: ${e.message}`);
  }
  const list2 = raw?.questions;
  if (!Array.isArray(list2) || !list2.length) throw new UserError(`${file}: expected {"questions": [{"id", "task", "kind", "truth"}, \u2026]}`);
  const ids = /* @__PURE__ */ new Set();
  return list2.map((q, i) => {
    const where = `${file}: question ${i + 1}`;
    if (!q || typeof q !== "object") throw new UserError(`${where} is not an object`);
    const id2 = typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${i + 1}`;
    if (ids.has(id2)) throw new UserError(`${where}: the id "${id2}" is used twice`);
    ids.add(id2);
    if (typeof q.task !== "string" || !q.task.trim()) throw new UserError(`${where} (${id2}) has no task`);
    if (!KINDS.includes(q.kind)) throw new UserError(`${where} (${id2}): kind must be one of ${KINDS.join(", ")}`);
    const t = q.truth;
    const grep = t && typeof t === "object" && !Array.isArray(t) && typeof t.grep === "string" && t.grep;
    const literal = q.kind === "definition" && typeof t === "string" && /:\d+$/.test(t) || q.kind === "count" && typeof t === "number" && Number.isInteger(t) && t >= 0 || q.kind === "set" && Array.isArray(t) && t.every((s) => typeof s === "string");
    if (!grep && !literal) {
      const want = { definition: '"path:line"', count: "a whole number", set: "a list of paths" }[q.kind];
      throw new UserError(`${where} (${id2}): truth must be ${want} or {"grep": "pattern", \u2026}`);
    }
    return { id: id2, task: q.task.trim(), kind: q.kind, truth: t };
  });
}
var clean = (p) => p.replace(/\\/g, "/").replace(/^\.?\//, "");
function gitGrep(root, flags, t) {
  const r = spawnSync8("git", ["-C", root, "grep", ...flags, t.regex ? "-E" : "-F", ...t.word ? ["-w"] : [], "-e", t.grep, "--", t.dir ?? "."], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new UserError(`git grep "${t.grep}" failed: ${(r.stderr || r.error?.message || "").trim()}`);
  const exclude = t.exclude ? new RegExp(t.exclude) : void 0;
  return r.stdout.split("\n").filter(Boolean).filter((l) => !exclude?.test(l.split(":")[0]));
}
function truthOf(q, root) {
  const t = q.truth;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    if (!root) throw new UserError(`question ${q.id}: a "grep" truth needs a git repository`);
    if (q.kind === "definition") {
      const hit = gitGrep(root, ["-n"], t).map((l) => /^(.*?):(\d+):/.exec(l)).find(Boolean);
      if (!hit) throw new UserError(`question ${q.id}: git grep found no definition for "${t.grep}"`);
      return { path: clean(hit[1]), line: Number(hit[2]) };
    }
    const files = [...new Set(gitGrep(root, ["-l"], t).map(clean))];
    return q.kind === "count" ? { count: files.length } : { files };
  }
  if (q.kind === "definition") {
    const m = /^(.*):(\d+)$/.exec(t);
    return { path: clean(m[1]), line: Number(m[2]) };
  }
  if (q.kind === "count") return { count: t };
  return { files: [...new Set(t.map(clean))] };
}
function answerParts(answer) {
  const text = answer.replace(/`/g, "");
  const s = /SUMMARY:\s*([\s\S]*?)(?=^\s*(?:DETAILS|FILES CHANGED|VERIFICATION|OPEN ISSUES):|$(?![\s\S]))/m.exec(text);
  const d = /^\s*DETAILS:\s*([\s\S]*?)(?=^\s*(?:FILES CHANGED|VERIFICATION|OPEN ISSUES):|$(?![\s\S]))/m.exec(text);
  const summary = s ? s[1] : text.split(/^\s*(?:DETAILS|FILES CHANGED|VERIFICATION|OPEN ISSUES):/m)[0];
  return { summary: summary.trim(), details: (d?.[1] ?? "").trim() };
}
function pathsIn2(text) {
  const found = text.replace(/\\/g, "/").match(/[A-Za-z0-9_.@\-/]+\.[A-Za-z0-9]{1,8}(?::\d+)?/g) ?? [];
  return [...new Set(found.map((p) => clean(p.replace(/:\d+$/, ""))))];
}
function scoreAnswer(q, truth, answer, root) {
  const prefix = root ? `${clean(root).replace(/\/$/, "")}/` : "";
  const text = prefix ? answer.replace(/\\/g, "/").split(prefix).join("") : answer;
  const { summary, details } = answerParts(text);
  if (!summary && !details) return { score: 0, got: "(no answer)" };
  if ("line" in truth) {
    const flat = summary.replace(/\s+/g, " ");
    if (new RegExp(`(^|[^\\w./-])\\.?/?${escape2(truth.path)}:${truth.line}(?!\\d)`).test(flat)) return { score: 1, got: `${truth.path}:${truth.line}` };
    const named = pathsIn2(flat).includes(truth.path);
    return { score: named ? 0.5 : 0, got: flat.slice(0, 120) };
  }
  if ("count" in truth) {
    const n = /\d[\d,]*/.exec(summary);
    const got2 = n ? Number(n[0].replace(/,/g, "")) : void 0;
    return { score: got2 === truth.count ? 1 : 0, got: got2 === void 0 ? "(no number)" : String(got2) };
  }
  let got = pathsIn2(summary);
  if (!got.length) got = pathsIn2(details);
  const hit = got.filter((p) => truth.files.includes(p)).length;
  const precision = got.length ? hit / got.length : 0;
  const recall = truth.files.length ? hit / truth.files.length : got.length ? 0 : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { score: !truth.files.length && !got.length ? 1 : f1, got: `${hit}/${truth.files.length} found, ${got.length - hit} extra` };
}
var escape2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
var median = (a) => {
  const s = a.filter((x) => x !== void 0).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : void 0;
};
function summarize(rows) {
  const by = /* @__PURE__ */ new Map();
  for (const r of rows) by.set(r.worker, [...by.get(r.worker) ?? [], r]);
  return [...by.entries()].map(([worker, rs]) => ({
    worker,
    questions: rs.length,
    failed: rs.filter((r) => r.state !== "done").length,
    score: mean(rs.map((r) => r.score)),
    byKind: Object.fromEntries(KINDS.filter((k) => rs.some((r) => r.kind === k)).map((k) => [k, mean(rs.filter((r) => r.kind === k).map((r) => r.score))])),
    medianSeconds: median(rs.map((r) => r.seconds)),
    medianTokens: median(rs.map((r) => r.tokens))
  })).sort((a, b) => b.score - a.score || (a.medianSeconds ?? 1e9) - (b.medianSeconds ?? 1e9));
}

// src/vcs/guard.ts
import fs19 from "node:fs";
import path18 from "node:path";
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
  return path18.join(home(), "shim", `v${VERSION}`);
}
function findRealGit(skip) {
  const same = (a, b) => WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const dir of (process.env.PATH ?? "").split(path18.delimiter).filter(Boolean)) {
    if (same(path18.resolve(dir), skip)) continue;
    const p = path18.join(dir, WINDOWS ? "git.exe" : "git");
    try {
      fs19.accessSync(p, fs19.constants.X_OK);
      if (fs19.statSync(p).isFile()) return p;
    } catch {
    }
  }
  return void 0;
}
function findGitSh(realGit) {
  let dir = path18.dirname(realGit);
  for (let i = 0; i < 4; i++) {
    for (const rel of ["bin/sh.exe", "usr/bin/sh.exe"]) {
      const p = path18.join(dir, rel);
      if (fs19.existsSync(p)) return p;
    }
    const up = path18.dirname(dir);
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
var hooksDir = () => path18.join(home(), "git-hooks", `v${HOOK_VERSION}`);
function writeIfChanged2(file, content) {
  if (fs19.existsSync(file) && fs19.readFileSync(file, "utf8") === content) return;
  fs19.mkdirSync(path18.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs19.writeFileSync(tmp, content, { mode: 493 });
  renameOver(tmp, file);
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
  writeIfChanged2(path18.join(hooksDir(), "reference-transaction"), REF_HOOK);
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
    writeIfChanged2(path18.join(dir, "git.cmd"), cmdShim(sh));
  }
  writeIfChanged2(path18.join(dir, "git"), SHIM);
  const key = pathKey(env);
  return { ...env, ...quiet, PITROOM_REAL_GIT: fwd(real), [key]: `${dir}${path18.delimiter}${env[key] ?? ""}` };
}
function shimReady() {
  const env = guardEnv({ ...process.env });
  return Boolean(env[pathKey(env)]?.startsWith(shimDir()));
}

// src/core/slots.ts
import crypto4 from "node:crypto";
import fs20 from "node:fs";
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
  fs20.mkdirSync(path19.dirname(file), { recursive: true });
  try {
    fs20.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let owner = "";
  try {
    owner = fs20.readFileSync(file, "utf8").trim();
  } catch {
  }
  if (owner === runId) return true;
  if (holderActive(owner, runId)) return false;
  fs20.rmSync(file, { force: true });
  try {
    fs20.writeFileSync(file, runId, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseIfOwner(file, runId) {
  if (!file) return;
  try {
    if (fs20.readFileSync(file, "utf8").trim() === runId) fs20.rmSync(file, { force: true });
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
function slotHolders() {
  if (!fs20.existsSync(slotsDir())) return [];
  return fs20.readdirSync(slotsDir()).map((f) => {
    try {
      return fs20.readFileSync(path19.join(slotsDir(), f), "utf8").trim();
    } catch {
      return "";
    }
  }).filter((id2) => holderActive(id2, ""));
}
var lockFile = (repoRoot) => path19.join(locksDir(), `write-${crypto4.createHash("sha1").update(path19.resolve(repoRoot)).digest("hex").slice(0, 16)}`);
function acquireWriteLock(repoRoot, runId) {
  const file = lockFile(repoRoot);
  if (tryClaim(file, runId)) return;
  let owner = "";
  try {
    owner = fs20.readFileSync(file, "utf8").trim();
  } catch {
  }
  throw new UserError(`another --write run (${owner}) is active in this repo; use --isolate for parallel changes`, 3);
}
var releaseWriteLock = (repoRoot, runId) => releaseIfOwner(lockFile(repoRoot), runId);

// src/core/process.ts
import { spawn } from "node:child_process";
import fs21 from "node:fs";
async function spawnWorker(inv, opts) {
  const out = fs21.openSync(opts.stdoutFile, "w");
  const err = fs21.openSync(opts.stderrFile, "w");
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
      res.spawnError = e.code === "ENOENT" ? fs21.existsSync(opts.cwd) ? `${inv.command} not found` : `the working directory ${opts.cwd} does not exist` : e.message;
      resolve2(127);
    });
    child.on("close", (c) => resolve2(c));
  });
  clearTimeout(timer);
  if (killer) clearTimeout(killer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  fs21.closeSync(out);
  fs21.closeSync(err);
  return res;
}
export {
  ASKS_FOR_LIST,
  DEFAULT_BACKEND,
  FORBIDDEN_COMMANDS,
  STOP_FILE,
  TERMINAL,
  acquireWriteLock,
  allBackends,
  answerParts,
  backendIds,
  badgeUrl,
  brief,
  card,
  catalogPrice,
  compact,
  cooldownMs,
  costAt,
  describeTarget,
  estimateTokens,
  extractRefs,
  fill,
  findSecretFiles,
  findSecretFilesInTree,
  fixTask,
  focusedRate,
  formatTarget,
  freshMeta,
  getBackend,
  guardEnv,
  home,
  isActive,
  isAlive,
  linkInto,
  listRunIds,
  loadEval,
  loadPlan,
  loadTemplate,
  looksSecret,
  newRunId,
  parseAudit,
  parsePlan,
  parsePriceSpec,
  parseStatus,
  parseTarget,
  parseVerdict,
  pathsIn2 as pathsIn,
  planName,
  planTask,
  primaryPrice,
  rankChain,
  readCatalog,
  readLedger,
  readMeta,
  releaseSlot,
  releaseWriteLock,
  requestStop,
  resolveRun,
  retryAfterMs,
  retryCommands,
  runDir,
  runFile,
  runsDir,
  savedUsd,
  scoreAnswer,
  scoreOf,
  secretWarning,
  shimDir,
  shimReady,
  slotHolders,
  spawnWorker,
  summarize,
  totals,
  trim,
  truthOf,
  tryAcquireSlot,
  usd,
  verifyRefs,
  workerCostOf,
  writeIfChanged,
  writeMeta
};
