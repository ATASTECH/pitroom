// Types and fetchers for the dashboard's read-only JSON API (see src/core/dash.ts).
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
  changes?: number;
  applied?: boolean;
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
  attempts: { target: string; error: string }[];
  warnings: string[];
  refs?: { valid: number; total: number; invalid: string[] };
  verify?: { command: string; ok: boolean; tail: string };
  error?: string;
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
  seconds?: number;
  steps?: number;
  tokens?: number;
  saved?: number;
  files: number;
  applied: boolean;
}

export interface Stats {
  price: string;
  totals: { runs: number; ok: number; failed: number; seconds: number; tokens: number; saved: number };
  byWorker: { backend: string; model?: string; runs: number; ok: number; avgSeconds: number | null; avgTokens: number | null; saved: number }[];
  byDay: { day: string; runs: number; ok: number; saved: number }[];
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const r = await fetch(`${path}${q.size ? `?${q}` : ''}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  state: (limit: number, group?: string) => get<DashState>('/api/state', { limit, group }),
  run: (id: string) => get<RunDetail>(`/api/run/${id}`),
  history: (p: { q?: string; state?: string; model?: string; days?: number; before?: string; limit?: number }) =>
    get<{ total: number; rows: HistoryRow[] }>('/api/history', p),
  stats: (days: number) => get<Stats>('/api/stats', { days }),
};
