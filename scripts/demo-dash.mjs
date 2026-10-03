#!/usr/bin/env node
// Builds a sample Pitroom home (made-up runs of an imaginary "shop-api" project), serves the dashboard
// on it and takes the screenshots in docs/ with Chrome. The data is invented; it only shows the UI.
//
//   npm run build && node scripts/demo-dash.mjs            # needs Chrome (set CHROME=/path if not on macOS)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
  console.error('Chrome was not found: set CHROME=/path/to/chrome');
  process.exit(1);
}
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-demo-'));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const PROJECT = '/home/dev/shop-api';

let seed = 20261002;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => Math.round(a + rnd() * (b - a));
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

const WORKERS = [
  { backend: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', w: 6, price: 1 },
  { backend: 'opencode', model: 'opencode/mimo-v2.6-flash-free', w: 4, price: 1 },
  { backend: 'opencode', model: 'opencode/space-bunny-free', w: 3, price: 1 },
  { backend: 'codex', model: 'gpt-6-sol', w: 3, price: 1 },
  { backend: 'claude', model: 'sonnet', w: 1, price: 1 },
  { backend: 'gemini', model: 'gemini-3.8-flash', w: 3, price: 1 },
];
const pickWorker = () => { const bag = WORKERS.flatMap((x) => Array(x.w).fill(x)); return pick(bag); };

const FILES = ['src/http/client.ts', 'src/http/retry.ts', 'src/orders/total.ts', 'src/orders/routes.ts', 'src/auth/session.ts', 'src/billing/invoice.ts', 'src/users/get-user.ts', 'src/config/rate-limit.ts', 'test/http/client.test.ts', 'test/orders/total.test.ts'];
const RESEARCH = [
  ['Where is the rate limit configured, and which callers override it?', 'The limit lives in `src/config/rate-limit.ts:12`; `src/orders/routes.ts:41` and `src/auth/session.ts:88` override it per route.'],
  ['Which tests cover the checkout flow, and what does each one assert?', '`test/orders/total.test.ts` covers totals and discounts (lines 14-96); no test covers the coupon path in `src/orders/routes.ts`.'],
  ['List every place where the session cookie is read outside the auth module', 'Three places: `src/orders/routes.ts:23`, `src/billing/invoice.ts:57` and `src/users/get-user.ts:9`.'],
  ['How is the order total computed? Name each function with file:line', '`computeTotal` (`src/orders/total.ts:18`) sums `lineTotal` (:41), applies `applyDiscount` (:63) and then `addTax` (:88).'],
  ['Which packages depend on the logger, and how does each import it?', 'Four: api, billing, auth and jobs. All use `import { log } from "@shop/logger"` except jobs, which imports the default export.'],
];
const CHANGES = [
  ['Add retry with exponential backoff to the HTTP client and cover it with a test', ['src/http/client.ts', 'src/http/retry.ts', 'test/http/client.test.ts']],
  ['Rename the legacy fetchUser helper to getUser across the API package', ['src/users/get-user.ts', 'src/orders/routes.ts', 'src/auth/session.ts', 'src/billing/invoice.ts', 'test/orders/total.test.ts']],
  ['Add input validation to POST /orders and return 422 with the field errors', ['src/orders/routes.ts', 'test/orders/total.test.ts']],
  ['Replace the deprecated moment calls with date-fns in src/billing', ['src/billing/invoice.ts']],
];
const REVIEWS = ['main..feature/retry-backoff', 'main..fix/order-total', '3f9c2a1b7..e81d40c55', 'main..feature/validation'];
const SEARCHES = ['retry', 'rate.?limit', 'getUser|fetchUser', 'computeTotal', 'session'];

// ── event streams in the two formats the dashboard reads (OpenCode's and Codex's) ────────────────────────
function opencodeEvents(start, end, kind, files, answer, tokens) {
  const ev = []; let t = start; const span = (end - start) / 12; const sid = 'ses_demo';
  const at = () => (t += span * (0.4 + rnd()));
  ev.push({ type: 'step_start', timestamp: at(), sessionID: sid, part: { type: 'step-start' } });
  const tool = (name, input, status = 'completed') => ev.push({ type: 'tool_use', timestamp: at(), sessionID: sid, part: { tool: name, state: { status, input } } });
  for (const f of files.slice(0, 2)) tool('read', { filePath: f });
  tool('grep', { pattern: pick(SEARCHES) });
  if (kind !== 'research') tool('glob', { pattern: 'src/**/*.ts' });
  if (kind === 'change') { for (const f of files) tool('edit', { filePath: f }); tool('bash', { command: 'npm test --silent' }); }
  if (kind === 'review') { tool('read', { filePath: pick(FILES) }); tool('grep', { pattern: pick(SEARCHES) }); }
  ev.push({ type: 'text', timestamp: at(), sessionID: sid, part: { messageID: 'm1', text: answer } });
  ev.push({ type: 'step_finish', timestamp: end, sessionID: sid, part: { cost: 0, tokens: { input: Math.round(tokens * 0.93), output: Math.round(tokens * 0.01), reasoning: 0, cache: { read: Math.round(tokens * 0.06), write: 0 }, total: tokens } } });
  return ev;
}
function geminiEvents(start, end, kind, files, answer, tokens) {
  const iso = (t) => new Date(t).toISOString();
  let t = start; const span = (end - start) / 12; const at = () => iso((t += span * (0.4 + rnd())));
  const ev = [{ type: 'init', timestamp: iso(start), session_id: 'gem_demo', model: 'gemini-3.8-flash' }];
  let n = 0;
  const tool = (tool_name, parameters) => { const tool_id = `${tool_name}__call_${++n}`; ev.push({ type: 'tool_use', timestamp: at(), tool_name, tool_id, parameters }, { type: 'tool_result', timestamp: at(), tool_id, status: 'success' }); };
  for (const f of files.slice(0, 2)) tool('read_file', { file_path: f });
  tool('grep_search', { pattern: pick(SEARCHES) });
  if (kind === 'change') { for (const f of files) tool('replace', { file_path: f, old_string: 'fetchUser', new_string: 'getUser' }); tool('run_shell_command', { command: 'npm test --silent' }); }
  ev.push({ type: 'message', timestamp: at(), role: 'assistant', content: answer, delta: true });
  ev.push({ type: 'result', timestamp: iso(end), status: 'success', stats: { total_tokens: tokens, input_tokens: Math.round(tokens * 0.99), output_tokens: Math.round(tokens * 0.01), cached: Math.round(tokens * 0.3), input: Math.round(tokens * 0.69), tool_calls: n } });
  return ev;
}
function codexEvents(kind, files, answer, tokens) {
  const ev = [{ type: 'thread.started', thread_id: 'thr_demo' }];
  const cmd = (c, code = 0) => ev.push({ type: 'item.completed', item: { id: `i${ev.length}`, type: 'command_execution', command: `/bin/zsh -lc '${c}'`, exit_code: code, status: 'completed', aggregated_output: '' } });
  cmd(`rg -n "${pick(SEARCHES)}" src`); cmd(`sed -n '1,120p' ${files[0] ?? 'src/http/client.ts'}`);
  if (kind === 'change') { ev.push({ type: 'item.completed', item: { id: 'f1', type: 'file_change', status: 'completed', changes: files.map((p) => ({ path: p, kind: 'update' })) } }); cmd('npm test --silent'); }
  ev.push({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: answer } });
  ev.push({ type: 'turn.completed', usage: { input_tokens: Math.round(tokens * 0.95), cached_input_tokens: Math.round(tokens * 0.5), output_tokens: Math.round(tokens * 0.01) } });
  return ev;
}

// A believable diff per file: a rename of fetchUser to getUser in the sources, new test files as additions.
const SNIPPETS = {
  'src/users/get-user.ts': ['export async function fetchUser(id: string) {', 'export async function getUser(id: string) {', 'const row = await db.users.findById(id);'],
  'src/orders/routes.ts': ['  const user = await fetchUser(req.session.userId);', '  const user = await getUser(req.session.userId);', '  if (!user) return res.status(401).end();'],
  'src/auth/session.ts': ['import { fetchUser } from "../users/get-user";', 'import { getUser } from "../users/get-user";', 'import { signToken } from "./token";'],
  'src/billing/invoice.ts': ['  const owner = await fetchUser(order.userId);', '  const owner = await getUser(order.userId);', '  const lines = order.items.map(toLine);'],
};
const PATCH = (files) => files.map((f) => {
  if (f.startsWith('test/')) {
    const body = ['import { describe, expect, it } from "vitest";', 'import { computeTotal } from "../../src/orders/total";', '', 'describe("computeTotal", () => {', '  it("applies a 100% coupon before tax", () => {', '    expect(computeTotal({ items: [{ price: 40, qty: 1 }], coupon: 1 })).toBe(0);', '  });', '});'];
    return `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join('\n')}\n`;
  }
  const [from, to, ctx] = SNIPPETS[f] ?? ['  return call(config);', '  return withRetry(() => call(config), { retries: 3 });', '  const config = load();'];
  return `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -8,5 +8,5 @@\n ${ctx}\n ${ctx.startsWith('  ') ? '  ' : ''}// ${path.basename(f)}\n-${from}\n+${to}\n ${ctx.startsWith('  ') ? '  ' : ''}const result = ok(value);\n }\n`;
}).join('');

// ── the runs ─────────────────────────────────────────────────────────────────────────────────────────────
const runs = [];
const used = new Set();
function addRun(o) {
  const startedAt = new Date(o.startedAt);
  const kind = o.kind, w = o.worker ?? pickWorker();
  const dur = o.state === 'running' ? Math.round((Date.now() - startedAt.getTime()) / 1000) : o.seconds ?? (kind === 'review' ? between(25, 220) : between(14, 160));
  const endedAt = o.state === 'running' ? undefined : new Date(startedAt.getTime() + dur * 1000);
  let id; do { id = `${stamp(startedAt)}-${Math.floor(rnd() * 65536).toString(16).padStart(4, '0')}`; } while (used.has(id)); used.add(id);
  const tokens = o.tokens ?? between(75_000, kind === 'review' ? 1_400_000 : 1_000_000);
  const task = o.task, files = o.files ?? [];
  const meta = {
    id, version: VERSION, mode: kind === 'change' ? 'isolate' : 'read', task: kind === 'review' ? 'You are a senior code reviewer. Review completed work against its plan or requirements.' : task,
    dir: PROJECT, cwd: PROJECT, repoRoot: PROJECT, worker: { backend: w.backend, model: w.model }, fallback: [], ran: { backend: w.backend, model: w.model }, resolvedModel: w.model,
    files: [], link: [], timeoutSec: 1800, state: o.state, startedAt: startedAt.toISOString(), warnings: [], sessionId: 'ses_demo',
    ...(o.group ? { group: o.group } : {}),
    ...(endedAt ? { endedAt: endedAt.toISOString(), exitCode: o.state === 'done' ? 0 : 1 } : { pid: o.pid }),
    ...(o.state === 'failed' ? { error: o.error } : {}),
    ...(kind === 'review' ? { reviewOf: task, reviewKind: 'range', verdict: o.verdict } : {}),
    ...(kind === 'change' && o.state === 'done' ? { changes: files.map((p) => ({ status: p.startsWith('test/') ? 'A' : 'M', path: p })), stats: { files: files.length, insertions: files.length * 9, deletions: files.length * 2 }, afterTree: 'demo', baseTree: 'demo', applied: o.applied ?? false } : {}),
    usage: { input: Math.round(tokens * 0.93), output: Math.round(tokens * 0.01), reasoning: 0, cacheRead: Math.round(tokens * 0.06), cacheWrite: 0, total: tokens, cost: w.backend === 'opencode' ? 0 : w.backend === 'claude' ? 0.04 : undefined, steps: between(3, 9), toolCalls: between(4, 12), denied: 0 },
    returnedTokens: between(400, 1400), savedUsd: Math.round((tokens / 1e6) * 3 * 100 * (0.8 + rnd() * 0.5)) / 100,
    ...(o.state === 'done' && kind !== 'change' ? { refs: { total: 4, valid: o.refsOk ?? 4, invalid: o.refsOk === 3 ? [{ ref: 'src/orders/total.ts:154', reason: 'file has 120 lines' }] : [] } } : {}),
  };
  const dir = path.join(HOME, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const answer = o.answer ?? (kind === 'change' ? `Done. Changed ${files.length} file${files.length === 1 ? '' : 's'}; the test suite passes.` : '');
  if (o.state !== 'failed' || o.events) {
    const evs = w.backend === 'codex' ? codexEvents(kind, files, answer || 'Working…', tokens) : w.backend === 'gemini' ? geminiEvents(startedAt.getTime(), (endedAt ?? new Date()).getTime(), kind, files, answer || 'Working…', tokens) : opencodeEvents(startedAt.getTime(), (endedAt ?? new Date()).getTime(), kind, files, answer || 'Working…', tokens);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  if (o.state !== 'running') fs.writeFileSync(path.join(dir, 'summary.md'), `${answer}\n`);
  if (kind === 'change' && o.state === 'done') fs.writeFileSync(path.join(dir, 'changes.patch'), PATCH(files));
  runs.push(meta);
  return meta;
}

const now = Date.now();
const sleeper = spawn('sleep', ['1200'], { detached: true, stdio: 'ignore' });
sleeper.unref();
let chrome;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
let serving = false;
// Runs on every way out, a failure included: nothing is left running and the sample home is removed.
process.on('exit', () => {
  try { chrome?.kill(); } catch { /* gone */ }
  if (serving) try { execFileSync(process.execPath, [path.join(root, 'dist', 'pitroom.mjs'), 'dash', '--stop'], { env: { ...process.env, PITROOM_HOME: HOME }, stdio: 'ignore' }); } catch { /* not running */ }
  try { process.kill(sleeper.pid); } catch { /* gone */ }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
});

// ~21 days of history for the statistics
for (let day = 21; day >= 1; day--) {
  for (let i = between(25, 60); i > 0; i--) {
    const kind = pick(['research', 'research', 'change', 'review']);
    const when = now - day * 86_400_000 + between(8, 19) * 3_600_000 + between(0, 59) * 60_000;
    const state = rnd() < 0.86 ? 'done' : rnd() < 0.7 ? 'failed' : 'timeout';
    const r = pick(RESEARCH), c = pick(CHANGES);
    addRun({
      kind, startedAt: when, state: state === 'timeout' ? 'timeout' : state,
      task: kind === 'review' ? pick(REVIEWS) : kind === 'change' ? c[0] : r[0], files: kind === 'change' ? c[1] : [pick(FILES), pick(FILES)],
      answer: state === 'done' ? (kind === 'review' ? 'STRENGTHS: small, focused change.\nIMPORTANT: none.\nMINOR: one comment is out of date.' : kind === 'change' ? undefined : r[1]) : undefined,
      error: state === 'failed' ? 'Rate limit exceeded: free-models-per-day' : undefined, seconds: state === 'timeout' ? 1800 : undefined,
      verdict: kind === 'review' ? { spec: 'pass', quality: rnd() < 0.6 ? 'approved' : 'needs-fixes', critical: 0, important: rnd() < 0.4 ? 1 : 0, minor: between(0, 2) } : undefined,
    });
  }
}

// the last hours, what the Live tab shows
const mins = (m) => now - m * 60_000;
const codex = WORKERS[3], muse = WORKERS[0], mimo = WORKERS[1], bunny = WORKERS[2];
addRun({ kind: 'change', worker: codex, startedAt: now - 83_000, state: 'running', pid: sleeper.pid, task: CHANGES[0][0], files: CHANGES[0][1], answer: 'Adding the backoff helper and wiring it into the client.', tokens: 41_000 });
addRun({ kind: 'change', worker: mimo, startedAt: now - 52_000, state: 'running', pid: sleeper.pid, task: CHANGES[3][0], files: CHANGES[3][1], answer: 'Swapping the moment calls for date-fns equivalents.', tokens: 28_000 });
addRun({ kind: 'research', worker: WORKERS[5], startedAt: now - 11_000, state: 'running', pid: sleeper.pid, task: RESEARCH[1][0], files: ['test/orders/total.test.ts'], answer: 'Listing the checkout tests.', tokens: 9_000 });
addRun({ kind: 'research', worker: muse, startedAt: now - 26_000, state: 'running', pid: sleeper.pid, task: RESEARCH[0][0], files: ['src/config/rate-limit.ts'], answer: 'Reading where the limiter is configured.', tokens: 22_000 });
addRun({ kind: 'change', worker: muse, startedAt: mins(7), seconds: 118, state: 'done', task: CHANGES[1][0], files: CHANGES[1][1], applied: true, tokens: 520_000, group: 'rename-user' });
addRun({ kind: 'review', worker: bunny, startedAt: mins(12), seconds: 142, state: 'done', task: REVIEWS[0], verdict: { spec: 'pass', quality: 'approved', critical: 0, important: 0, minor: 1 }, answer: 'STRENGTHS: the backoff is bounded and tested.\nIMPORTANT: none.\nMINOR: `retry.ts:31` could name the jitter constant.', tokens: 940_000 });
addRun({ kind: 'research', worker: mimo, startedAt: mins(24), seconds: 64, state: 'done', task: RESEARCH[2][0], files: ['src/orders/routes.ts'], answer: RESEARCH[2][1], tokens: 310_000 });
addRun({ kind: 'review', worker: mimo, startedAt: mins(41), seconds: 207, state: 'done', task: REVIEWS[1], verdict: { spec: 'pass', quality: 'needs-fixes', critical: 0, important: 2, minor: 1 }, answer: 'STRENGTHS: the fix is minimal.\nIMPORTANT:\n- src/orders/total.ts:63 — the discount is applied before tax in one branch only.\n- test/orders/total.test.ts:40 — no case for a 100% coupon.\nMINOR: stale comment at total.ts:18.', refsOk: 3, tokens: 1_180_000 });
addRun({ kind: 'research', worker: bunny, startedAt: mins(58), state: 'failed', task: RESEARCH[1][0], error: 'Rate limit exceeded: free-models-per-day', seconds: 9, tokens: 3_000 });
addRun({ kind: 'research', worker: muse, startedAt: mins(75), seconds: 41, state: 'done', task: RESEARCH[3][0], files: ['src/orders/total.ts'], answer: RESEARCH[3][1], tokens: 260_000 });

// the savings ledger (this week's total on the Live tab)
console.log(`sample week: $${runs.filter((m) => m.endedAt && now - Date.parse(m.startedAt) < 7 * 86_400_000).reduce((a, m) => a + m.savedUsd, 0).toFixed(0)} saved, ${runs.length} runs`);
fs.writeFileSync(path.join(HOME, 'ledger.jsonl'), runs.filter((m) => m.endedAt && m.usage?.steps && now - Date.parse(m.startedAt) < 30 * 86_400_000).map((m) => JSON.stringify({ id: m.id, at: m.endedAt, mode: m.mode, state: m.state, backend: m.worker.backend, model: m.worker.model, tokens: m.usage.total, returned: m.returnedTokens, workerCost: 0, saved: m.savedUsd, price: 'Claude Sonnet' })).join('\n') + '\n');

// ── serve it and take the screenshots ────────────────────────────────────────────────────────────────────
const env = { ...process.env, PITROOM_HOME: HOME };
const cli = path.join(root, 'dist', 'pitroom.mjs');
execFileSync(process.execPath, [cli, 'history', 'import'], { env, stdio: 'ignore' });
execFileSync(process.execPath, [cli, 'savings', '--since', '30d', '--card', path.join(root, 'docs', 'card.svg')], { env, stdio: 'ignore' });
const url = execFileSync(process.execPath, [cli, 'dash', '--detach', '--port', '0'], { env, encoding: 'utf8' }).trim().split('\n')[0];
serving = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9455', `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
let tab;
for (let i = 0; i < 60 && !tab; i++) { try { tab = (await (await fetch('http://127.0.0.1:9455/json')).json()).find((t) => t.type === 'page'); } catch { await sleep(200); } }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) waiting.get(d.id)(d.result); };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = (expression) => send('Runtime.evaluate', { expression });

const OPEN_CARD = "[...document.querySelectorAll('[data-slot=\"expandable-card-body\"]')].find((e) => e.textContent.includes('Rename the legacy'))?.click()";
// Opens the Changes section and its second file, and scrolls that file into view.
const SHOW_DIFF = "(() => { const h = [...document.querySelectorAll('button[aria-expanded]')].find((b) => /^Changes/.test(b.textContent)); if (h?.getAttribute('aria-expanded') === 'false') h.click(); setTimeout(() => { const f = h?.closest('section')?.querySelectorAll('[data-slot=\"file-diff\"] > button')[1]; if (f?.getAttribute('aria-expanded') === 'false') f.click(); setTimeout(() => f?.scrollIntoView({ block: 'center' }), 500); }, 700); })()";
async function shot(file, { hash = '', height = 900, click, wait = 2200, then, wait2 = 0 }) {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height, deviceScaleFactor: 1.5, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url: `${url}${hash}` });
  await sleep(2600);
  if (click) { await evaluate(click); await sleep(wait); }
  if (then) { await evaluate(then); await sleep(wait2 + 1800); }
  const data = (await send('Page.captureScreenshot', { format: 'png' })).data;
  fs.writeFileSync(path.join(root, 'docs', file), Buffer.from(data, 'base64'));
  console.log(`docs/${file}`);
}

await send('Page.enable');
await send('Page.navigate', { url });
await sleep(1000);
await evaluate("localStorage.setItem('pitroom-theme','dark')");
await shot('dash-live.png', { height: 1020 });
await shot('dash-card.png', { height: 1240, click: OPEN_CARD, wait: 3000, then: SHOW_DIFF, wait2: 1200 });
await shot('dash-history.png', { hash: '#history', height: 940 });
await shot('dash-stats.png', { hash: '#stats', height: 980 });

// ── a short screen recording for the README (needs ffmpeg; skipped without it) ────────────────────────────
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
let hasFfmpeg = true;
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }
if (hasFfmpeg) {
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-frames-'));
  let f = 0;
  const grab = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      const data = (await send('Page.captureScreenshot', { format: 'png' })).data;
      fs.writeFileSync(path.join(frames, `f${String(f++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    }
  };
  const click = (text) => evaluate(`[...document.querySelectorAll('[role=tab]')].find((e) => e.textContent === ${JSON.stringify(text)})?.click()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url });
  await sleep(2200);
  await grab(22);                                        // the Live tab: spinners, mascots, timers
  await evaluate("[...document.querySelectorAll('[data-slot=\"expandable-card-body\"]')].find((e) => e.textContent.includes('Rename the legacy'))?.click()");
  await grab(20);                                        // the card opens
  for (let i = 0; i < 6; i++) { await evaluate("document.querySelector('[data-slot=\"scroll-area-viewport\"]')?.scrollBy({ top: 70 })"); await grab(1); }
  await evaluate(SHOW_DIFF);                             // Changes → a file's diff
  await grab(18);
  await grab(4);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await grab(10);
  await click('History'); await sleep(500); await grab(12);
  await click('Stats'); await sleep(500); await grab(14);
  const out = path.join(root, 'docs', 'dash-demo.gif');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '9', '-i', path.join(frames, 'f%04d.png'), '-vf', 'scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', out]);
  fs.rmSync(frames, { recursive: true, force: true });
  console.log(`docs/dash-demo.gif (${f} frames, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

ws.close();
process.exit(0);
