// `pitroom dash`: a live page of what Pitroom is doing, for the places where hooks and status
// lines do not reach (the Claude Code and Codex apps). A small read-only HTTP server on
// 127.0.0.1 only; it never starts, stops or changes a run. Open the address in any browser,
// including the browser pane of an agent app.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { UserError } from './errors.js';
import { PAGE } from './dash-page.js';
import { headline } from './group.js';
import { readLedger, totals } from './receipt.js';
import { formatReport, live, progress } from './report.js';
import { type RunMeta, freshMeta, home, isActive, isAlive, listRunIds } from './store.js';
import { elapsed, kind, what, workerName } from './ui.js';

export const DEFAULT_PORT = 7878;
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** How many of the newest run records one request reads at most. */
const SCAN = 400;
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;

export interface DashRun {
  id: string;
  state: string;
  kind: string;
  worker: string;
  task: string;
  group?: string;
  startedAt: string;
  time: string;
  steps: number;
  tokens?: number;
  saved?: number;
  verdict?: string;
  changes?: number;
  applied?: boolean;
  note: string;
}

export interface DashState {
  running: number;
  saved: number;
  groups: string[];
  runs: DashRun[];
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function toRun(m: RunMeta): DashRun {
  const l = m.state === 'running' ? live(m) : undefined;
  return {
    id: m.id,
    state: m.state,
    kind: kind(m),
    worker: workerName(m.ran ?? m.worker),
    task: what(m),
    group: m.group,
    startedAt: m.startedAt,
    time: elapsed(m),
    steps: l ? l.steps : (m.usage?.steps ?? 0),
    tokens: m.usage?.total,
    saved: m.savedUsd || undefined,
    verdict: m.verdict ? `SPEC ${m.verdict.spec.toUpperCase()} · QUALITY ${m.verdict.quality.toUpperCase()}` : undefined,
    changes: m.changes?.length || undefined,
    applied: m.applied || undefined,
    note: l?.last ? oneLine(String(l.last), 140) : isActive(m.state) ? '' : headline(m, 200) || oneLine(m.error ?? '', 200),
  };
}

/** What the page shows: the newest runs (optionally of one group), the running count, this week's savings. */
export function dashState(opts: { group?: string; limit?: number } = {}): DashState {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const runs: DashRun[] = [];
  const groups = new Set<string>();
  for (const id of listRunIds().slice(-SCAN).reverse()) {
    let m: RunMeta;
    try {
      m = freshMeta(id); // a crashed worker is shown as failed, not as running forever
    } catch {
      continue; // a record being written right now
    }
    if (m.group) groups.add(m.group);
    if (opts.group && m.group !== opts.group) continue;
    if (runs.length < limit) runs.push(toRun(m));
  }
  return {
    running: runs.filter((r) => r.state === 'running' || r.state === 'queued').length,
    saved: totals(readLedger(Date.now() - WEEK_MS)).saved,
    groups: [...groups].sort(),
    runs,
  };
}

/** The report of one run, as `pitroom show` prints it. */
export function runDetail(id: string): { id: string; report: string } | undefined {
  if (!RUN_ID.test(id)) return undefined;
  try {
    const m = freshMeta(id);
    return { id, report: isActive(m.state) ? progress(m) : formatReport(m, undefined, 120) };
  } catch {
    return undefined;
  }
}

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
};

function handler(touch: () => void): http.RequestListener {
  const send = (res: http.ServerResponse, code: number, type: string, body: string) => {
    res.writeHead(code, { ...HEADERS, 'content-type': type });
    res.end(body);
  };
  const json = (res: http.ServerResponse, code: number, value: unknown) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
  return (req, res) => {
    touch();
    // Only the machine itself, under its own name: a web page in the user's browser must not be able
    // to read run records through a rebinding trick.
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (url.pathname === '/api/state') {
      const group = url.searchParams.get('group') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 40);
      return json(res, 200, dashState({ group: group && group.length <= 100 ? group : undefined, limit: Number.isFinite(limit) ? limit : 40 }));
    }
    const m = /^\/api\/run\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const d = runDetail(m[1]!);
      return d ? json(res, 200, d) : json(res, 404, { error: 'no such run' });
    }
    return json(res, 404, { error: 'not found' });
  };
}

export interface Dash {
  port: number;
  url: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}

/** Starts the server on 127.0.0.1. `port` 0 picks a free one; `idleMs` > 0 closes it after that long without a request. */
export function startDash(opts: { port: number; idleMs?: number }): Promise<Dash> {
  let lastRequest = Date.now();
  const server = http.createServer(handler(() => (lastRequest = Date.now())));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      let done!: () => void;
      const closed = new Promise<void>((r) => (done = r));
      let timer: NodeJS.Timeout | undefined;
      const close = () => {
        if (timer) clearInterval(timer);
        server.closeAllConnections?.();
        return new Promise<void>((r) => server.close(() => (done(), r())));
      };
      if (opts.idleMs && opts.idleMs > 0) {
        timer = setInterval(() => Date.now() - lastRequest > opts.idleMs! && void close(), Math.min(60_000, opts.idleMs));
        timer.unref();
      }
      resolve({ port, url: `http://127.0.0.1:${port}/`, closed, close });
    });
  });
}

// ── the running instance: one per user, found through a small file ──────────────────────────

const registryFile = () => path.join(home(), 'dash.json');
interface Registry {
  pid: number;
  port: number;
}

async function ping(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state?limit=1`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The address of the dash that is already running, or undefined. */
export async function runningDash(): Promise<(Registry & { url: string }) | undefined> {
  try {
    const r = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as Registry;
    if (isAlive(r.pid) && (await ping(r.port))) return { ...r, url: `http://127.0.0.1:${r.port}/` };
  } catch {
    // no file, or not a dash any more
  }
  fs.rmSync(registryFile(), { force: true });
  return undefined;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd!, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // best effort
  }
}

export interface DashOptions {
  port?: number;
  idleMs?: number;
  detach?: boolean;
  stop?: boolean;
  open?: boolean;
  /** Internal: run as the detached server, quietly. */
  serve?: boolean;
  log: (s: string) => void;
}

/** `pitroom dash`: serve in the foreground, `--detach` to start (or reuse) a background one, `--stop` to end it. */
export async function dashCommand(o: DashOptions): Promise<number> {
  const existing = await runningDash();
  if (o.stop) {
    if (!existing) throw new UserError('pitroom dash is not running');
    process.kill(existing.pid, 'SIGTERM');
    fs.rmSync(registryFile(), { force: true });
    o.log(`stopped pitroom dash (${existing.url})`);
    return 0;
  }
  if (existing && !o.serve) {
    o.log(existing.url);
    if (o.open) openBrowser(existing.url);
    return 0;
  }
  if (o.detach) {
    const child = spawn(process.execPath, [process.argv[1]!, 'dash', '--serve', ...(o.port !== undefined ? ['--port', String(o.port)] : []), '--idle', '4h'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', () => undefined);
    child.unref();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await runningDash();
      if (r && r.pid === child.pid) {
        o.log(r.url);
        if (o.open) openBrowser(r.url);
        return 0;
      }
    }
    throw new UserError('pitroom dash did not start (is the port taken? try --port 0)');
  }
  const explicit = o.port !== undefined;
  let dash: Dash;
  try {
    dash = await startDash({ port: o.port ?? DEFAULT_PORT, idleMs: o.idleMs });
  } catch (e) {
    if (explicit || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new UserError(`pitroom dash: ${(e as Error).message}`);
    dash = await startDash({ port: 0, idleMs: o.idleMs });
  }
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify({ pid: process.pid, port: dash.port }));
  const stop = () => void dash.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (!o.serve) o.log(`${dash.url}\n(read-only, this machine only; Ctrl-C stops it)`);
  if (o.open) openBrowser(dash.url);
  await dash.closed;
  try {
    if ((JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as Registry).pid === process.pid) fs.rmSync(registryFile(), { force: true });
  } catch {
    // already gone
  }
  return 0;
}
