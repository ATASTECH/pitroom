import type { DashRun } from '@/api';

export type Item = { kind: 'run'; run: DashRun } | { kind: 'group'; name: string; runs: DashRun[] };

export const isActive = (r: DashRun) => r.state === 'running' || r.state === 'queued';
export const isProblem = (r: DashRun) => r.state === 'failed' || r.state === 'timeout' || r.state === 'stopped' || !!r.verifyFailed;

/**
 * Runs that share a group, two or more of them, become one item placed where the group's newest run was (the
 * list is newest first); a group of one, and runs without a group, stay as they are.
 */
export function bucket(runs: DashRun[]): Item[] {
  const size = new Map<string, number>();
  for (const r of runs) if (r.group) size.set(r.group, (size.get(r.group) ?? 0) + 1);
  const items: Item[] = [];
  const at = new Map<string, Extract<Item, { kind: 'group' }>>();
  for (const run of runs) {
    if (!run.group || (size.get(run.group) ?? 0) < 2) {
      items.push({ kind: 'run', run });
      continue;
    }
    let g = at.get(run.group);
    if (!g) {
      g = { kind: 'group', name: run.group, runs: [] };
      at.set(run.group, g);
      items.push(g);
    }
    g.runs.push(run);
  }
  return items;
}

/** What a group card says about its runs. */
export function summarize(runs: DashRun[]) {
  const running = runs.filter(isActive).length;
  const problem = runs.filter((r) => !isActive(r) && isProblem(r)).length;
  const done = runs.filter((r) => r.state === 'done' && !r.verifyFailed).length;
  return {
    total: runs.length,
    running,
    problem,
    done,
    saved: runs.reduce((n, r) => n + (r.saved ?? 0), 0),
    tokens: runs.reduce((n, r) => n + (r.tokens ?? 0), 0),
    startedAt: runs.reduce((a, r) => (Date.parse(r.startedAt) < Date.parse(a) ? r.startedAt : a), runs[0]?.startedAt ?? ''),
  };
}
