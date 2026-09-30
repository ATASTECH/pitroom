// src/core/errors.ts
var UserError = class extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
};

// src/backends/opencode/index.ts
import { spawnSync } from "node:child_process";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/backends/opencode/events.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
var DENIED = /rule which prevents you|permission denied|permission\.rejected/i;
function parseEvents(ndjson) {
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
        lastActivity = `says: ${oneLine(text)}`;
        break;
      }
      case "tool_use": {
        const name = String(p.tool ?? "tool");
        const st = p.state ?? {};
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === "error" && DENIED.test(String(st.error ?? ""))) usage.denied++;
        if (st.status === "completed" && EDIT_TOOLS.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe(st.input)}`.trim();
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
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function oneLine(s, max = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}
function describe(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v ? oneLine(String(v), 60) : "";
}

// src/backends/opencode/profiles.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  const rules = {
    "*": "deny",
    [path.join(data, "opencode", "tool-output", "*")]: "allow",
    [path.join(data, "opencode", "shell", "*", "*")]: "allow"
  };
  for (const tmp of /* @__PURE__ */ new Set([os.tmpdir(), realpath(os.tmpdir())])) rules[path.join(tmp, "opencode", "*")] = "allow";
  return rules;
}
function realpath(p) {
  try {
    return fs.realpathSync(p);
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
function binary() {
  if (process.env.PITROOM_OPENCODE_BIN) return process.env.PITROOM_OPENCODE_BIN;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path2.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path2.join(dir, `opencode${ext}`);
      if (fs2.existsSync(p) && fs2.statSync(p).isFile()) return p;
    }
  }
  const installer = path2.join(os2.homedir(), ".opencode", "bin", "opencode");
  return fs2.existsSync(installer) ? installer : "opencode";
}
function oc(args, opts = {}) {
  const r = spawnSync(binary(), args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 6e4,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", missing: !!r.error };
}
var jsonIn = (s) => JSON.parse(s.slice(s.indexOf("{")));
function invocation(req) {
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
  return {
    command: binary(),
    args,
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
function classify(message) {
  if (/model not found|ModelNotFound|unknown model|no such model|deprecated/i.test(message)) return "model-unavailable";
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded|\b50[23]\b|unavailable|capacity/i.test(message)) return "rate-limited";
  if (/provider\.auth|FreeTierError|free tier|unauthori[sz]ed|\b40[13]\b|api.?key|insufficient|credits?\b|billing|payment/i.test(message)) {
    return "auth";
  }
  return "other";
}
function failure(run, stderr, exitCode) {
  if (exitCode === 0 && !run.error) return void 0;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `opencode exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify(message), message };
}
function modelId(m) {
  if (typeof m === "string") return m;
  const id = m?.model ?? m?.id;
  return m?.providerID && id ? `${m.providerID}/${id}` : void 0;
}
function defaultModel() {
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
function resolveModel(sessionId) {
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
function doctor({ models, hasFallback }) {
  const checks = [];
  const version = oc(["--version"]);
  if (version.missing || !version.ok) {
    return [{ level: "fail", message: `opencode not runnable (${binary()}). Install: https://opencode.ai or set PITROOM_OPENCODE_BIN` }];
  }
  const v = version.out.trim().replace(/^opencode\s+/i, "");
  const major = majorVersion(v);
  if (major !== void 0 && major < 2) {
    return [{ level: "fail", message: `OpenCode ${v} is too old: Pitroom needs OpenCode v2 or newer (run \`opencode upgrade\`)` }];
  }
  checks.push({ level: "ok", message: `opencode ${v} at ${binary()} (private --standalone server per run)` });
  const known = new Set(listModels());
  const def = defaultModel();
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
  binary,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  resolveModel,
  listModels,
  doctor
};

// src/backends/index.ts
var REGISTRY = /* @__PURE__ */ new Map([[opencode.id, opencode]]);
var DEFAULT_BACKEND = opencode.id;
var PLANNED = ["codex", "claude", "gemini"];
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
import fs3 from "node:fs";
import path3 from "node:path";
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
function extractRefs(answer) {
  const seen = /* @__PURE__ */ new Map();
  for (const line of answer.split("\n")) {
    const matches = [...line.matchAll(REF)];
    const seps = [...line.matchAll(CLAUSE)].map((s) => s.index ?? 0);
    const sepBetween = (a, b) => seps.some((s) => s >= a && s < b);
    const idents = [...line.matchAll(IDENT)].filter((i) => {
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
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path3.resolve(d)))];
  const invalid = [];
  const lineCache = /* @__PURE__ */ new Map();
  const load = (file) => {
    if (!lineCache.has(file)) {
      const size = fs3.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs3.readFileSync(file, "utf8").split("\n");
      if (lines && lines[lines.length - 1] === "") lines.pop();
      lineCache.set(file, lines);
    }
    return lineCache.get(file);
  };
  for (const ref of refs) {
    const file = resolve(ref.file, roots);
    if (!file) {
      invalid.push({ ref: ref.text, reason: path3.isAbsolute(ref.file) && !inside(ref.file, roots) ? "outside the project" : "file not found" });
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
  const candidates = path3.isAbsolute(ref) ? inside(ref, roots) ? [ref] : [] : roots.map((r) => path3.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs3.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}
function inside(file, roots) {
  return roots.some((r) => {
    const rel = path3.relative(r, path3.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path3.isAbsolute(rel);
  });
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export {
  DEFAULT_BACKEND,
  allBackends,
  backendIds,
  describeTarget,
  extractRefs,
  formatTarget,
  getBackend,
  parseTarget,
  verifyRefs
};
