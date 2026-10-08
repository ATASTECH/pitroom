// Types and fetchers for the dashboard's JSON API (see src/core/dash.ts). Reading is open to the page; stopping or discarding a run (or a whole crew) needs the secret the page was served with.
import type { FileDiffData } from '../../src/core/file-diff';
export type { FileDiffData, FileDiffLine } from '../../src/core/file-diff';
export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'stopped';

export interface DashRun {
  id: string;
  state: RunState;
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
  /** On an audited run: AGREE, PARTIAL, DISAGREE, UNCLEAR, PENDING or FAILED. */
  audit?: string;
  changes?: number;
  applied?: boolean;
  /** A finished isolate run whose copy can still be thrown away. */
  discardable?: boolean;
  /** Finished, but its --verify command failed. */
  verifyFailed?: boolean;
  note: string;
}

export interface DashState {
  price: string;
  running: number;
  saved: number;
  groups: string[];
  runs: DashRun[];
}

export interface Step {
  kind: 'say' | 'shell' | 'edit' | 'tool';
  name?: string;
  text: string;
  ok?: boolean;
  t?: number;
}

export interface RunDetail {
  id: string;
  state: RunState;
  card?: DashRun;
  task: string;
  steps: Step[];
  answer: string;
  changes: { status: string; path: string }[];
  patch?: string;
  fileDiffs?: FileDiffData[];
  info: Record<string, string | number | undefined>;
  attempts: { target: string; error: string; skipped?: boolean }[];
  warnings: string[];
  refs?: { valid: number; total: number; invalid: string[] };
  verify?: { command: string; ok: boolean; tail: string };
  error?: string;
  audit?: { id?: string; state: string; verdict?: string; disputed: string[] };
  report: string;
}

export interface HistoryRow {
  id: string;
  startedAt: string;
  state: RunState;
  kind: string;
  backend: string;
  model?: string;
  task: string;
  group?: string;
  verdict?: string;
  audit?: string;
  seconds?: number;
  steps?: number;
  tokens?: number;
  saved?: number;
  files: number;
  applied: boolean;
  /** Finished, but its --verify command failed. */
  verifyFailed?: boolean;
}

export interface Stats {
  price: string;
  /** `limited`: failed on a rate limit or quota; left out of runs, failed and the averages unless `rateLimits` is 'counted'. */
  totals: { runs: number; ok: number; failed: number; limited: number; seconds: number; tokens: number; saved: number };
  rateLimits: 'excluded' | 'counted';
  audits: { runs: number; agree: number; partial: number; disagree: number; unclear: number; tokens: number };
  byWorker: { backend: string; model?: string; runs: number; ok: number; limited: number; avgSeconds: number | null; avgTokens: number | null; saved: number; audited: number; agreed: number }[];
  byDay: { day: string; runs: number; ok: number; limited: number; saved: number }[];
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const r = await fetch(`${path}${q.size ? `?${q}` : ''}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post(path: string): Promise<string> {
  const token = document.querySelector<HTMLMetaElement>('meta[name="pitroom-token"]')?.content ?? '';
  const r = await fetch(path, { method: 'POST', headers: { 'x-pitroom-token': token } });
  const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new Error(body.error ?? `${path}: ${r.status}`);
  return body.message ?? 'done';
}

export const api = {
  stop: (id: string) => post(`/api/run/${id}/stop`),
  discard: (id: string) => post(`/api/run/${id}/discard`),
  stopGroup: (group: string) => post(`/api/group/${encodeURIComponent(group)}/stop`),
  discardGroup: (group: string) => post(`/api/group/${encodeURIComponent(group)}/discard`),
  /** The commands that would start a crew's failed runs again: the page never starts a run itself. */
  retryGroup: (group: string) => get<{ commands: string[]; shell?: 'sh' | 'powershell' }>(`/api/group/${encodeURIComponent(group)}/retry`),
  state: (limit: number, group?: string) => get<DashState>('/api/state', { limit, group }),
  run: (id: string) => get<RunDetail>(`/api/run/${id}`),
  history: (p: { q?: string; state?: string; model?: string; days?: number; before?: string; limit?: number }) =>
    get<{ total: number; rows: HistoryRow[] }>('/api/history', p),
  stats: (days: number) => get<Stats>('/api/stats', { days }),
};
