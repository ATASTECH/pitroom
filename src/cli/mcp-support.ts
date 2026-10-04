// What the MCP tools are built from: argument checks, running the CLI, and waiting for runs with progress.
import { spawn } from 'node:child_process';
import { groupIds } from '../core/group.js';
import { progress } from '../core/report.js';
import { freshMeta, isActive } from '../core/store.js';

export type Json = Record<string, unknown>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** What a tool call can do besides returning: say how far it is, and notice that the client gave up. */
export interface Ctx {
  /** Aborted when the client cancels the request (reason "cancelled": what it started is stopped), or when its
   *  session ends (reason "closed": only the waiting ends, the runs go on). */
  signal: AbortSignal;
  /** A progress message; reaches the client only when it asked for progress on this request. */
  progress(message: string): void;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  call(args: Json, ctx: Ctx): Promise<ToolResult>;
}

export const MAX_OUTPUT = 120_000;
export const DEFAULT_WAIT = 50;
export const MAX_WAIT = 540;
export const MAX_TASKS = 20;
const PROGRESS_EVERY_MS = 5000;

export class ToolError extends Error {}

// ── argument helpers ──────────────────────────────────────────────────────────────────────────────

export const str = (a: Json, key: string, required = false): string | undefined => {
  const v = a[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  return v;
};
export const strs = (a: Json, key: string): string[] => {
  const v = a[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`"${key}" must be a list of strings`);
  return v as string[];
};
export const bool = (a: Json, key: string): boolean => {
  const v = a[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" must be true or false`);
  return v;
};
export const waitSeconds = (a: Json): number => {
  const v = a.waitSeconds;
  if (v === undefined || v === null) return DEFAULT_WAIT;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw new ToolError('"waitSeconds" must be a number of seconds, 1 or more');
  return Math.min(Math.round(v), MAX_WAIT);
};
export const oneOf = <T extends string>(a: Json, key: string, allowed: readonly T[], fallback: T): T => {
  const v = str(a, key);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new ToolError(`"${key}" must be one of: ${allowed.join(', ')}`);
  return v as T;
};
/** A "30d" / "all" window, checked here so a typo is a tool error with the right words. */
export const since = (a: Json): string[] => {
  const v = str(a, 'since');
  if (v === undefined) return [];
  if (v !== 'all' && !/^\d+d$/.test(v)) throw new ToolError('"since" takes 7d, 30d, … or all');
  return ['--since', v];
};

/** The options every run-like tool shares, as CLI flags (`only` limits them to some). */
export function workerFlags(a: Json, only?: string[]): string[] {
  const out: string[] = [];
  const on = (key: string) => !only || only.includes(key);
  const pairs: [string, string][] = [['worker', '-W'], ['model', '-m'], ['tier', '--tier'], ['effort', '--effort'], ['dir', '-d'], ['verify', '--verify'], ['group', '-g']];
  for (const [key, flag] of pairs) {
    const v = on(key) ? str(a, key) : undefined;
    if (v !== undefined) out.push(flag, v);
  }
  if (on('files')) for (const f of strs(a, 'files')) out.push('-f', f);
  const link = on('link') ? strs(a, 'link') : [];
  if (link.length) out.push('--link', link.join(','));
  if (on('web') && bool(a, 'web')) out.push('--web');
  return out;
}

// ── running the CLI ───────────────────────────────────────────────────────────────────────────────

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
export const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} more characters)` : s);

export interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** Runs one `pitroom` command in a child process; an aborted `signal` ends it. */
export function pit(args: string[], timeoutMs = 60 * 60_000, signal?: AbortSignal): Promise<Ran> {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) return resolve({ code: 1, out: '', err: 'cannot locate the pitroom executable' });
    const child = spawn(process.execPath, [script, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.on('error', (e) => resolve({ code: 1, out, err: err || String(e.message) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, out: strip(out).trim(), err: strip(err).trim() });
    });
  });
}

/** The CLI's text as a tool result: usage mistakes and refusals (exit 2, 3) are errors, a failed run is a report. */
export function asResult(r: Ran, still?: string): ToolResult {
  const text = [r.out, r.err && r.code !== 0 ? r.err : ''].filter(Boolean).join('\n\n') || '(no output)';
  if (r.code === 75 && still) return { text: clip(`${text}\n\n${still}`) };
  return { text: clip(text), isError: r.code === 2 || r.code === 3 || (r.code === 1 && !r.out) };
}

/** Plain CLI command as a tool: its text, with a time limit and the client's cancel. */
export const plain = async (args: string[], ctx: Ctx, timeoutMs = 60_000): Promise<ToolResult> => asResult(await pit(args, timeoutMs, ctx.signal));

/** Tells the client how the runs are doing, every few seconds, until the returned function is called. */
function trackProgress(ctx: Ctx, ids: () => string[]): () => void {
  const tick = () => {
    try {
      const lines = ids()
        .map((id) => freshMeta(id))
        .filter((m) => isActive(m.state))
        .map((m) => progress(m).replace(/^pitroom\s+/, ''));
      if (lines.length) ctx.progress(lines.slice(0, 3).join('\n') + (lines.length > 3 ? `\n… and ${lines.length - 3} more` : ''));
    } catch {
      // a run that is not readable right now: the next tick tries again
    }
  };
  const first = setTimeout(tick, 800);
  const timer = setInterval(tick, PROGRESS_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export async function waitFor(ids: string[], seconds: number, ctx: Ctx, group?: string): Promise<ToolResult> {
  const args = group ? ['wait', '-g', group, '--timeout', String(seconds)] : ['wait', ...ids, '--timeout', String(seconds)];
  const done = trackProgress(ctx, () => (group ? groupIds(group) : ids));
  let r: Ran;
  try {
    r = await pit(args, (seconds + 60) * 1000, ctx.signal);
  } finally {
    done();
  }
  const again = group ? `{"group": "${group}"}` : `{"runs": ${JSON.stringify(ids)}}`;
  return asResult(r, `Not finished yet: call pitroom_wait with ${again} (waitSeconds up to ${MAX_WAIT}); pitroom_stop ends it.`);
}

/** The client cancelled the request (it did not just close the pipe): what it started should not go on unseen. */
const cancelled = (ctx: Ctx) => ctx.signal.aborted && ctx.signal.reason === 'cancelled';

/** Stops what a cancelled request started; nobody can be told if it fails, so it goes to the log. */
async function stopQuietly(args: string[]): Promise<void> {
  const r = await pit(args, 30_000);
  if (r.code !== 0) process.stderr.write(`pitroom mcp: ${args.join(' ')} failed: ${r.err || r.out}\n`);
}

/** Starts a run (or review, audit) in the background and waits for it a while. */
export async function startAndWait(start: string[], seconds: number, ctx: Ctx, task?: string): Promise<ToolResult> {
  // the task goes last, after "--", so that it can start with a dash
  // not cancellable: it is over in a moment, and ending it half way could leave a worker running that nobody knows the id of
  const started = await pit([...start, '--bg', '--json', ...(task === undefined ? [] : ['--', task])]);
  if (started.code !== 0) return asResult(started);
  let id: string;
  try {
    id = (JSON.parse(started.out) as { id: string }).id;
  } catch {
    return { text: `could not read the run id from: ${started.out.slice(0, 200)}`, isError: true };
  }
  const result = await waitFor([id], seconds, ctx);
  if (cancelled(ctx)) await stopQuietly(['stop', id]);
  return result;
}

/** Starts several tasks as one group of background workers and waits for the group a while. */
export async function startCrew(flags: string[], tasks: string[], seconds: number, ctx: Ctx): Promise<ToolResult> {
  const started = await pit(['crew', ...flags, '--json', '--', ...tasks]); // not cancellable, as in startAndWait
  if (started.code !== 0) return asResult(started);
  let group: string;
  try {
    group = (JSON.parse(started.out) as { group: string }).group;
  } catch {
    return { text: `could not read the group from: ${started.out.slice(0, 200)}`, isError: true };
  }
  const result = await waitFor([], seconds, ctx, group);
  if (cancelled(ctx)) await stopQuietly(['stop', '-g', group]);
  return result;
}
