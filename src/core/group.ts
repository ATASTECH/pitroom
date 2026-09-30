// Working with several runs at once: selection, a status table, waiting for
// all/any, and a live watch stream. The JSON stream is one line per meaningful
// change, so an agent can follow it (e.g. Claude Code's Monitor tool) without
// paying for a line per tool call.
import { type RunMeta, TERMINAL, freshMeta, isActive, listRunIds, readMeta } from './store.js';
import { duration, live, readSummary } from './report.js';
import { describeTarget } from './target.js';

export function groupIds(group: string): string[] {
  return listRunIds().filter((id) => {
    try {
      return readMeta(id).group === group;
    } catch {
      return false;
    }
  });
}

export const activeIds = (): string[] => listRunIds().filter((id) => isActive(freshMeta(id).state));

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The worker's SUMMARY line (or first line), for compact listings. */
export function headline(meta: RunMeta, max = 160): string {
  const text = readSummary(meta);
  const line = text.split('\n').find((l) => /^SUMMARY:/i.test(l.trim())) ?? text.split('\n').find((l) => l.trim()) ?? '';
  return oneLine(line.replace(/^SUMMARY:\s*/i, ''), max);
}

export function table(metas: RunMeta[]): string {
  if (!metas.length) return 'no runs';
  const rows = metas.map((m) => {
    const l = m.state === 'running' ? live(m) : undefined;
    const steps = l ? String(l.steps) : m.usage ? String(m.usage.steps) : '-';
    const note = l?.last ? oneLine(l.last, 48) : isActive(m.state) ? oneLine(m.task, 48) : headline(m, 48) || oneLine(m.error ?? m.task, 48);
    return [m.id, m.state, m.mode, duration(m), steps, describeTarget(m.ran ?? m.worker), note];
  });
  const head = ['RUN', 'STATE', 'MODE', 'TIME', 'STEPS', 'WORKER', 'NOW / RESULT'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitMany(
  ids: string[],
  opts: { any: boolean; timeoutMs: number },
): Promise<{ metas: RunMeta[]; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const metas = ids.map((id) => freshMeta(id));
    const done = metas.filter((m) => TERMINAL.includes(m.state)).length;
    if (opts.any ? done > 0 : done === metas.length) return { metas, timedOut: false };
    if (Date.now() >= deadline) return { metas, timedOut: true };
    await sleep(1500);
  }
}

type WatchEvent = Record<string, unknown> & { event: string; run?: string };

/**
 * Follows runs until all have finished. `select` is re-evaluated every tick, so
 * runs added to a group later are picked up. Emits NDJSON events (json) or a
 * redrawn table (TTY). Returns the final records.
 */
export async function watch(
  select: () => string[],
  opts: { json: boolean; intervalMs: number; timeoutMs: number; write: (s: string) => void },
): Promise<{ metas: RunMeta[]; timedOut: boolean }> {
  const seen = new Map<string, { state: string; steps: number; attempts: number }>();
  const emit = (e: WatchEvent) => opts.write(`${JSON.stringify(e)}\n`);
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    const metas = select().map((id) => freshMeta(id));
    if (opts.json) {
      for (const m of metas) {
        const prev = seen.get(m.id);
        const l = m.state === 'running' ? live(m) : { steps: m.usage?.steps ?? 0, toolCalls: m.usage?.toolCalls ?? 0 };
        const attempts = m.attempts?.length ?? 0;
        const base = { run: m.id, mode: m.mode, task: oneLine(m.task, 60) };
        if (!prev) emit({ event: m.state === 'queued' ? 'queued' : 'started', ...base });
        else if (prev.state === 'queued' && m.state === 'running') emit({ event: 'started', ...base });
        if (attempts > (prev?.attempts ?? 0)) {
          const a = m.attempts![attempts - 1]!;
          emit({ event: 'fallback', run: m.id, failed: a.target, reason: oneLine(a.error, 120) });
        }
        if (m.state === 'running' && l.steps > (prev?.steps ?? 0)) {
          emit({ event: 'progress', run: m.id, steps: l.steps, tools: l.toolCalls, last: 'last' in l && l.last ? oneLine(String(l.last), 80) : undefined });
        }
        if (TERMINAL.includes(m.state as never) && prev?.state !== m.state) {
          emit({
            event: m.state,
            run: m.id,
            time: duration(m),
            worker: describeTarget(m.ran ?? m.worker),
            summary: headline(m) || undefined,
            error: m.error ? oneLine(m.error, 160) : undefined,
            refs: m.refs ? `${m.refs.valid}/${m.refs.total}` : undefined,
            changes: m.changes?.length || undefined,
          });
        }
        seen.set(m.id, { state: m.state, steps: l.steps, attempts });
      }
    } else {
      opts.write(`\x1b[H\x1b[2J${table(metas)}\n\n${new Date().toLocaleTimeString()} · Ctrl-C to stop watching (workers keep running)\n`);
    }
    const allDone = metas.length > 0 && metas.every((m) => TERMINAL.includes(m.state));
    if (allDone || (metas.length === 0 && seen.size === 0)) {
      if (opts.json) {
        const ok = metas.filter((m) => m.state === 'done').length;
        emit({ event: 'all-done', runs: metas.length, ok, failed: metas.length - ok });
      }
      return { metas, timedOut: false };
    }
    if (Date.now() >= deadline) return { metas, timedOut: true };
    await sleep(opts.intervalMs);
  }
}
