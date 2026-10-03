// Run records live outside the repo so delegation never pollutes the project
// (no .gitignore edits, nothing to accidentally commit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Mode, Target, Usage } from '../backends/types.js';
import { UserError } from './errors.js';
import type { RefCheck } from './refs.js';
import type { AuditVerdict, TaskStatus, Verdict } from './answers.js';

export type State = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'stopped';

export interface Change {
  status: string; // A, M, D, T
  path: string;
}

export interface RunMeta {
  id: string;
  version: string;
  mode: Mode;
  task: string;
  dir: string; // directory the user asked to work in
  cwd: string; // directory the worker actually runs in (worktree for isolate)
  repoRoot?: string;
  worker: Target; // preferred worker
  fallback: Target[]; // tried in order on model/provider failures
  ran?: Target; // the target of the final attempt
  resolvedModel?: string; // what the worker CLI actually used
  attempts?: { target: string; error: string }[];
  parent?: string;
  group?: string; // runs started together (`pitroom crew`, `--group`)
  sessionId?: string;
  files: string[];
  link: string[];
  timeoutSec: number;
  verify?: string;
  web?: boolean;
  state: State;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  warnings: string[];
  baseTree?: string;
  afterTree?: string;
  worktree?: string;
  changes?: Change[];
  stats?: { files: number; insertions: number; deletions: number };
  verifyResult?: { ok: boolean; code: number | null; tail: string };
  refs?: RefCheck;
  usage?: Usage;
  returnedTokens?: number;
  savedUsd?: number;
  applied?: boolean;
  reverted?: boolean;
  discarded?: boolean;
  /** For reviews: the reviewed run id, or the reviewed range "a..b". */
  reviewOf?: string;
  reviewKind?: 'task' | 'fix' | 'range';
  /** The package copy the reviewer reads; removed when the review ends. */
  packageFile?: string;
  verdict?: Verdict;
  /** For `--plan` runs and their follow-ups and reviews: the plan task. */
  plan?: { file: string; step: number; title: string };
  /** The implementer's STATUS line. */
  taskStatus?: TaskStatus;
  /** For an audit: the audited run's id. An audit re-checks a read run's answer with another worker. */
  auditOf?: string;
  auditVerdict?: AuditVerdict;
  auditDisputed?: string[];
  /** This run's own audit chance, 0 to 1 (--audit is 1, --no-audit 0); the config's `audit` applies when absent. */
  auditRate?: number;
  /** On an audited run: its audit, kept up to date when the audit ends. */
  audit?: { id: string; state: State; verdict?: AuditVerdict; disputed?: string[] };
}

export const TERMINAL: State[] = ['done', 'failed', 'timeout', 'stopped'];
export const isActive = (s: State) => !TERMINAL.includes(s);

export function home(): string {
  if (process.env.PITROOM_HOME) return path.resolve(process.env.PITROOM_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'pitroom');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'pitroom');
}

export const runsDir = () => path.join(home(), 'runs');
export const worktreesDir = () => path.join(home(), 'worktrees');
export const ledgerFile = () => path.join(home(), 'ledger.jsonl');
export const runDir = (id: string) => path.join(runsDir(), id);
export const runFile = (id: string, name: string) => path.join(runDir(id), name);

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Hooks the history module registers at start-up (store.ts must not import it: it imports this). */
let onFinished: ((m: RunMeta) => void) | undefined;
let archive: { meta(id: string): RunMeta | undefined; id(ref: string): string | undefined } | undefined;
export function useArchive(hooks: { onFinished: (m: RunMeta) => void; meta: (id: string) => RunMeta | undefined; id: (ref: string) => string | undefined }): void {
  onFinished = hooks.onFinished;
  archive = { meta: hooks.meta, id: hooks.id };
}

export function writeMeta(meta: RunMeta): void {
  fs.mkdirSync(runDir(meta.id), { recursive: true });
  const file = runFile(meta.id, 'meta.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, file);
  if (TERMINAL.includes(meta.state)) {
    try {
      onFinished?.(meta);
    } catch {
      // the history is a convenience; a run never fails because of it
    }
  }
}

export function readMeta(id: string): RunMeta {
  const file = runFile(id, 'meta.json');
  if (!fs.existsSync(file)) {
    // A run whose directory `pitroom clean` removed is still in the history.
    const kept = archive?.meta(id);
    if (kept) return upgrade(kept);
  }
  return upgrade(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Records written before workers were pluggable (≤0.2) had `model`/`fallbackModels` and no `worker`. */
function upgrade(raw: any): RunMeta {
  if (!raw.worker) raw.worker = raw.model ? { backend: 'opencode', model: raw.model } : { backend: 'opencode' };
  if (!Array.isArray(raw.fallback)) {
    raw.fallback = (raw.fallbackModels ?? []).map((m: string) => ({ backend: 'opencode', model: m }));
  }
  raw.warnings ??= [];
  raw.files ??= [];
  raw.link ??= [];
  return raw as RunMeta;
}

export function listRunIds(): string[] {
  if (!fs.existsSync(runsDir())) return [];
  return fs
    .readdirSync(runsDir())
    .filter((d) => fs.existsSync(runFile(d, 'meta.json')))
    .sort();
}

/** Resolves "latest"/"last", a full id, or a unique suffix/prefix of an id. */
export function resolveRun(ref: string | undefined): string {
  const ids = listRunIds();
  if (!ref || ref === 'latest' || ref === 'last') {
    if (!ids.length) throw new UserError('no runs yet');
    return ids[ids.length - 1]!;
  }
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((id) => id.startsWith(ref) || id.endsWith(ref));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) {
    // not on disk any more (`pitroom clean`): the history may still have it
    const kept = archive?.id(ref);
    if (kept) return kept;
  }
  throw new UserError(hits.length ? `ambiguous run "${ref}": ${hits.join(', ')}` : ids.length ? `unknown run "${ref}"` : 'no runs yet');
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A run marked running whose process is gone crashed; report it as failed. */
export function freshMeta(id: string): RunMeta {
  const meta = readMeta(id);
  if (!TERMINAL.includes(meta.state) && meta.pid && !isAlive(meta.pid)) {
    // The process may have just finished and written its own final record: read again so that record
    // (with its usage and savings) is never overwritten by this stale copy.
    const latest = readMeta(id);
    if (TERMINAL.includes(latest.state)) return latest;
    latest.state = 'failed';
    latest.error ??= 'worker process exited unexpectedly';
    latest.endedAt ??= new Date().toISOString();
    writeMeta(latest);
    return latest;
  }
  return meta;
}
