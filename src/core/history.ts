// Run history in SQLite (Node's built-in `node:sqlite`). The files of a run stay the hot path while it
// runs (an append-only event stream is the simplest thing that survives a crash). When a run ends its
// record goes here: scalar fields to query, the worker's steps, its answer, the patch, and the whole
// meta so the run can still be shown after `pitroom clean` removed its directory. Searchable with FTS5.
// Everything here is best effort: a missing or broken database must never fail a run.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import { getBackend } from '../backends/index.js';
import type { Step } from '../backends/types.js';
import { type LedgerEntry, readLedger, totals } from './receipt.js';
import { type RunMeta, TERMINAL, home, listRunIds, readMeta, runFile } from './store.js';
import { auditBadge } from './audit.js';
import { effective } from './config.js';
import { kind } from './ui.js';

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): any; all(...p: unknown[]): any[]; run(...p: unknown[]): unknown };
};

const SCHEMA_VERSION = 1;
const PATCH_MAX = 1_000_000;
const ANSWER_MAX = 200_000;

let cached: { file: string; db: Db | undefined } | undefined;

export const historyFile = () => path.join(home(), 'history.db');

/** The database, opened once per process; undefined when SQLite is not available. */
export function openDb(): Db | undefined {
  const file = historyFile();
  if (cached?.file === file) return cached.db;
  let db: Db | undefined;
  try {
    // Node still marks node:sqlite experimental and says so on stderr when it loads; that is not for the user.
    const emit = process.emitWarning;
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => (/SQLite/i.test(String((w as Error)?.message ?? w)) ? undefined : (emit as (...a: unknown[]) => void).call(process, w, ...rest))) as typeof process.emitWarning;
    let DatabaseSync: new (f: string) => Db;
    try {
      ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
    } finally {
      process.emitWarning = emit;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    migrate(db);
  } catch {
    db = undefined;
  }
  cached = { file, db };
  return db;
}

function migrate(db: Db): void {
  const v = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (v >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL, mode TEXT, kind TEXT,
      backend TEXT, model TEXT, task TEXT, grp TEXT, dir TEXT, review_of TEXT, verdict TEXT,
      seconds INTEGER, steps INTEGER, tool_calls INTEGER, tokens INTEGER, returned_tokens INTEGER,
      cost REAL, saved REAL, files_changed INTEGER, applied INTEGER, error TEXT,
      answer TEXT, patch TEXT, meta_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
    CREATE INDEX IF NOT EXISTS runs_model ON runs(backend, model);
    CREATE INDEX IF NOT EXISTS runs_grp ON runs(grp);
    CREATE TABLE IF NOT EXISTS steps (
      run_id TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT, name TEXT, text TEXT, ok INTEGER, at INTEGER,
      PRIMARY KEY (run_id, n)
    ) WITHOUT ROWID;
    CREATE VIRTUAL TABLE IF NOT EXISTS runs_fts USING fts5(id UNINDEXED, task, answer, steps);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

// ── reading a run's raw files, plain or compressed ──────────────────────────────────────────────

/** A run's file as text, whether it is still plain or was compressed after the run. */
export function readRunFile(id: string, name: string): string | undefined {
  const f = runFile(id, name);
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    if (fs.existsSync(`${f}.gz`)) return zlib.gunzipSync(fs.readFileSync(`${f}.gz`)).toString('utf8');
  } catch {
    // unreadable or half written
  }
  return undefined;
}

function gzipFile(f: string): void {
  if (!fs.existsSync(f)) return;
  fs.writeFileSync(`${f}.gz`, zlib.gzipSync(fs.readFileSync(f)));
  fs.rmSync(f);
}

/** The raw streams are only needed while a run runs: keep them compressed, and the logs of failures only. */
export function compactRun(meta: RunMeta): void {
  if (!TERMINAL.includes(meta.state)) return;
  const dir = path.dirname(runFile(meta.id, 'meta.json'));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (/^events(\.attempt-\d+)?\.jsonl$/.test(n)) gzipFile(path.join(dir, n));
    else if (/^stderr(\.attempt-\d+)?\.log$/.test(n)) {
      if (meta.state === 'done' && !/attempt/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
      else gzipFile(path.join(dir, n));
    }
  }
}

// ── writing ──────────────────────────────────────────────────────────────────────────────────────

const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) : s);

function timelineOf(meta: RunMeta): Step[] {
  const raw = readRunFile(meta.id, 'events.jsonl');
  if (!raw) return [];
  try {
    return getBackend((meta.ran ?? meta.worker).backend).parse(raw).timeline ?? [];
  } catch {
    return []; // a worker this version does not know
  }
}

/** Records (or updates) a finished run. Cheap when the run is already known: only its scalar fields change. */
export function recordRun(meta: RunMeta): void {
  if (!TERMINAL.includes(meta.state)) return;
  const db = openDb();
  if (!db) return;
  try {
    const u = meta.usage;
    const known = db.prepare('SELECT answer IS NOT NULL AS has FROM runs WHERE id = ?').get(meta.id);
    const answer = known?.has ? undefined : clip(readRunFile(meta.id, 'summary.md')?.trim(), ANSWER_MAX);
    const patch = known?.has ? undefined : clip(readRunFile(meta.id, 'changes.patch'), PATCH_MAX);
    const seconds = meta.endedAt ? Math.max(0, Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000)) : null;
    const t = meta.ran ?? meta.worker;
    const fields = {
      id: meta.id, started_at: meta.startedAt, ended_at: meta.endedAt ?? null, state: meta.state, mode: meta.mode, kind: kind(meta),
      backend: t.backend, model: meta.resolvedModel ?? t.model ?? null, task: clip(meta.task, 20_000) ?? '', grp: meta.group ?? null,
      dir: meta.dir, review_of: meta.reviewOf ?? meta.auditOf ?? null,
      verdict: meta.verdict ? `SPEC ${meta.verdict.spec.toUpperCase()} · QUALITY ${meta.verdict.quality.toUpperCase()}` : meta.auditVerdict ? `AUDIT ${meta.auditVerdict.toUpperCase()}` : null,
      seconds, steps: u?.steps ?? null, tool_calls: u?.toolCalls ?? null, tokens: u?.total ?? null, returned_tokens: meta.returnedTokens ?? null,
      cost: u?.cost ?? u?.costEstimate ?? null, saved: meta.savedUsd ?? null, files_changed: meta.changes?.length ?? 0, applied: meta.applied ? 1 : 0,
      error: clip(meta.error, 2000) ?? null, meta_json: JSON.stringify(meta),
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const cols = Object.keys(fields);
      db.prepare(`INSERT INTO runs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
        ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')}`).run(...Object.values(fields));
      if (!known?.has) {
        const steps = timelineOf(meta);
        db.prepare('UPDATE runs SET answer = ?, patch = ? WHERE id = ?').run(answer ?? '', patch ?? null, meta.id);
        db.prepare('DELETE FROM steps WHERE run_id = ?').run(meta.id);
        const ins = db.prepare('INSERT INTO steps (run_id, n, kind, name, text, ok, at) VALUES (?,?,?,?,?,?,?)');
        steps.forEach((s, n) => ins.run(meta.id, n, s.kind, s.name ?? null, s.text, s.ok === undefined ? null : s.ok ? 1 : 0, s.at ?? null));
        db.prepare('DELETE FROM runs_fts WHERE id = ?').run(meta.id);
        db.prepare('INSERT INTO runs_fts (id, task, answer, steps) VALUES (?,?,?,?)').run(meta.id, fields.task, answer ?? '', steps.map((s) => s.text).join('\n'));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    compactRun(meta);
  } catch {
    // history is a convenience
  }
}

/** Records every finished run whose directory is not in the database yet (older runs, or a deleted database). */
export function importRuns(): { imported: number; known: number } {
  const db = openDb();
  if (!db) return { imported: 0, known: 0 };
  const have = new Set<string>(db.prepare('SELECT id FROM runs').all().map((r: { id: string }) => r.id));
  let imported = 0;
  for (const id of listRunIds()) {
    if (have.has(id)) continue;
    try {
      const m = readMeta(id);
      if (!TERMINAL.includes(m.state)) continue;
      recordRun(m);
      imported++;
    } catch {
      // a record being written right now
    }
  }
  return { imported, known: have.size };
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────────

export interface ArchivedRun {
  meta: RunMeta;
  answer: string;
  patch?: string;
  patchTruncated?: boolean;
  steps: (Step & { t?: number })[];
}

/** A finished run from the database, e.g. after `pitroom clean` removed its directory. */
export function archivedRun(id: string): ArchivedRun | undefined {
  const db = openDb();
  if (!db) return undefined;
  try {
    const r = db.prepare('SELECT meta_json, answer, patch, started_at FROM runs WHERE id = ?').get(id);
    if (!r) return undefined;
    const start = Date.parse(r.started_at);
    const steps = db.prepare('SELECT kind, name, text, ok, at FROM steps WHERE run_id = ? ORDER BY n').all(id).map((s: any) => ({
      kind: s.kind, name: s.name ?? undefined, text: s.text, ok: s.ok === null ? undefined : !!s.ok, at: s.at ?? undefined,
      t: s.at && Number.isFinite(start) ? Math.max(0, Math.round((s.at - start) / 1000)) : undefined,
    }));
    return { meta: JSON.parse(r.meta_json), answer: r.answer ?? '', patch: r.patch ?? undefined, patchTruncated: r.patch?.length >= PATCH_MAX, steps };
  } catch {
    return undefined;
  }
}

/** A run id from a full id or a unique prefix/suffix, among the archived ones. */
export function archivedId(ref: string): string | undefined {
  const db = openDb();
  if (!db || !/^[\w-]{3,}$/.test(ref)) return undefined;
  try {
    const rows = db.prepare('SELECT id FROM runs WHERE id = ? OR id LIKE ? OR id LIKE ? ORDER BY id').all(ref, `${ref}%`, `%${ref}`);
    return rows.length === 1 ? rows[0].id : rows.find((r: { id: string }) => r.id === ref)?.id;
  } catch {
    return undefined;
  }
}

export interface HistoryRow {
  id: string;
  startedAt: string;
  state: string;
  kind: string;
  backend: string;
  model?: string;
  task: string;
  group?: string;
  verdict?: string;
  /** On an audited run: what its audit found (AGREE, PARTIAL, DISAGREE, UNCLEAR), PENDING while it runs. */
  audit?: string;
  /** Finished, but its --verify command failed. */
  verifyFailed?: boolean;
  seconds?: number;
  steps?: number;
  tokens?: number;
  saved?: number;
  files: number;
  applied: boolean;
  snippet?: string;
}

export interface HistoryQuery {
  text?: string;
  model?: string;
  backend?: string;
  state?: string;
  group?: string;
  sinceMs?: number;
  beforeId?: string;
  limit?: number;
}

/** SQL: the run finished, but its --verify command failed. */
const VERIFY_FAILED = "(r.state = 'done' AND json_extract(r.meta_json, '$.verifyResult.ok') = 0)";

/** FTS5 query from free text: every word a prefix match, so "login bu" finds "login bug". */
const ftsQuery = (text: string) => text.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');

export function listHistory(q: HistoryQuery = {}): { rows: HistoryRow[]; total: number } {
  const db = openDb();
  if (!db) return { rows: [], total: 0 };
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.text?.trim()) {
    where.push('r.id IN (SELECT id FROM runs_fts WHERE runs_fts MATCH ?)');
    args.push(ftsQuery(q.text));
  }
  if (q.model) { where.push('r.model = ?'); args.push(q.model); }
  if (q.backend) { where.push('r.backend = ?'); args.push(q.backend); }
  // "problem" is what needs attention: a run that did not finish, or one whose --verify failed
  if (q.state) { where.push(q.state === 'problem' ? `(r.state IN ('failed','timeout','stopped') OR ${VERIFY_FAILED})` : 'r.state = ?'); if (q.state !== 'problem') args.push(q.state); }
  if (q.group) { where.push('r.grp = ?'); args.push(q.group); }
  if (q.sinceMs) { where.push('r.started_at >= ?'); args.push(new Date(q.sinceMs).toISOString()); }
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM runs r ${base}`).get(...args).n as number;
    const page = q.beforeId ? `${base ? `${base} AND` : 'WHERE'} r.id < ?` : base;
    const rows = db.prepare(`SELECT r.*, json_extract(r.meta_json, '$.audit.state') AS audit_state, json_extract(r.meta_json, '$.audit.verdict') AS audit_verdict, ${VERIFY_FAILED} AS verify_failed FROM runs r ${page} ORDER BY r.id DESC LIMIT ?`).all(...args, ...(q.beforeId ? [q.beforeId] : []), Math.min(Math.max(q.limit ?? 30, 1), 200));
    return {
      total,
      rows: rows.map((r: any) => ({
        id: r.id, startedAt: r.started_at, state: r.state, kind: r.kind, backend: r.backend, model: r.model ?? undefined,
        task: r.review_of ? `of ${r.review_of.replace(/\b([0-9a-f]{9})[0-9a-f]{31}\b/g, '$1')}` : (r.task as string).split('\n').find((l: string) => l.trim()) ?? '',
        group: r.grp ?? undefined, verdict: r.verdict ?? undefined,
        audit: auditBadge({ audit: r.audit_state ? { id: '', state: r.audit_state, verdict: r.audit_verdict ?? undefined } : undefined }),
        verifyFailed: r.verify_failed ? true : undefined,
        seconds: r.seconds ?? undefined, steps: r.steps ?? undefined,
        tokens: r.tokens ?? undefined, saved: r.saved ?? undefined, files: r.files_changed ?? 0, applied: !!r.applied,
      })),
    };
  } catch {
    return { rows: [], total: 0 };
  }
}

/** Audits are runs of their own (about another run's answer): left out of the run counts, counted here. */
const NOT_AUDIT = "json_extract(meta_json, '$.auditOf') IS NULL";

/** What the audits since then found, in all and per worker and model of the audited answer. */
function auditStats(db: Db, since: string): { total: Stats['audits']; byWorker: Map<string, { audited: number; agreed: number }> } {
  const total: Stats['audits'] = { runs: 0, agree: 0, partial: 0, disagree: 0, unclear: 0, tokens: 0 };
  const byWorker = new Map<string, { audited: number; agreed: number }>();
  try {
    const t = db.prepare("SELECT COUNT(*) runs, COALESCE(SUM(tokens),0) tokens FROM runs WHERE started_at >= ? AND json_extract(meta_json, '$.auditOf') IS NOT NULL").get(since);
    total.runs = t.runs;
    total.tokens = t.tokens;
    const rows = db.prepare(`SELECT r.backend, r.model, json_extract(a.meta_json, '$.auditVerdict') v, COUNT(*) n
      FROM runs a JOIN runs r ON r.id = json_extract(a.meta_json, '$.auditOf')
      WHERE a.started_at >= ? AND a.state = 'done' AND json_extract(a.meta_json, '$.auditOf') IS NOT NULL
      GROUP BY r.backend, r.model, v`).all(since);
    for (const r of rows) {
      const v = (r.v ?? 'unclear') as keyof Stats['audits'];
      if (v in total && v !== 'runs' && v !== 'tokens') total[v] += r.n;
      const k = `${r.backend ?? ''}\0${r.model ?? ''}`;
      const w = byWorker.get(k) ?? { audited: 0, agreed: 0 };
      w.audited += r.n;
      if (r.v === 'agree') w.agreed += r.n;
      byWorker.set(k, w);
    }
  } catch {
    // no audits, or an SQLite without JSON functions
  }
  return { total, byWorker };
}

/** What one worker (and model) did lately: its runs (rate limits left out), how many ended well, and its audited answers. */
export interface WorkerRecord {
  runs: number;
  ok: number;
  audited: number;
  agreed: number;
}

/**
 * A worker's record since `sinceMs`, for the audit focus and the chain order. A target without a model matches all of
 * the backend's models; one with a model matches it with or without its provider (`mock/x` for `x`). Undefined
 * without a history.
 */
export function workerRecord(backend: string, model: string | undefined, sinceMs: number): WorkerRecord | undefined {
  const db = openDb();
  if (!db) return undefined;
  const since = new Date(sinceMs).toISOString();
  const fits = (m: string | null) => !model || m === model || !!m?.endsWith(`/${model}`) || model.endsWith(`/${m}`);
  const rec: WorkerRecord = { runs: 0, ok: 0, audited: 0, agreed: 0 };
  try {
    for (const r of db.prepare(`SELECT model, SUM(NOT ${LIMITED}) runs, SUM(state='done') ok FROM runs WHERE backend = ? AND started_at >= ? AND ${NOT_AUDIT} GROUP BY model`).all(backend, since)) {
      if (!fits(r.model)) continue;
      rec.runs += r.runs ?? 0;
      rec.ok += r.ok ?? 0;
    }
    const audits = db.prepare(`SELECT r.model, json_extract(a.meta_json, '$.auditVerdict') v, COUNT(*) n
      FROM runs a JOIN runs r ON r.id = json_extract(a.meta_json, '$.auditOf')
      WHERE r.backend = ? AND a.started_at >= ? AND a.state = 'done' AND json_extract(a.meta_json, '$.auditOf') IS NOT NULL
      GROUP BY r.model, v`).all(backend, since);
    for (const r of audits) {
      if (!fits(r.model)) continue;
      rec.audited += r.n;
      if (r.v === 'agree') rec.agreed += r.n;
    }
  } catch {
    return undefined;
  }
  return rec;
}

/** What the workers cost since then (USD, reported or estimated), audits and corrections included; undefined without a history. */
export function spentSince(sinceMs: number): number | undefined {
  const db = openDb();
  if (!db) return undefined;
  try {
    return db.prepare('SELECT COALESCE(SUM(cost),0) spent FROM runs WHERE started_at >= ?').get(new Date(sinceMs).toISOString()).spent as number;
  } catch {
    return undefined;
  }
}

/** The last known costs of a worker's runs, newest first (a model matches with or without its provider). */
export function recentCosts(backend: string, model: string | undefined, n = 5): number[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT model, cost FROM runs WHERE backend = ? AND cost IS NOT NULL AND steps > 0 ORDER BY started_at DESC LIMIT 200').all(backend);
    return rows.filter((r) => !model || r.model === model || r.model?.endsWith(`/${model}`) || model.endsWith(`/${r.model}`)).slice(0, n).map((r) => r.cost as number);
  } catch {
    return [];
  }
}

export interface Stats {
  /**
   * `limited`: runs that failed on a rate limit or quota, which says nothing about the work. Unless the config's
   * `countRateLimits` is on (`rateLimits: 'counted'`), they are left out of `runs`, `failed`, the times and tokens.
   */
  totals: { runs: number; ok: number; failed: number; limited: number; seconds: number; tokens: number; saved: number };
  rateLimits: 'excluded' | 'counted';
  /** Audits are not counted as runs above: they are overhead. `audited` and `agreed` per worker count audits of its answers. */
  audits: { runs: number; agree: number; partial: number; disagree: number; unclear: number; tokens: number };
  byWorker: { backend: string; model?: string; runs: number; ok: number; limited: number; avgSeconds: number | null; avgTokens: number | null; saved: number; audited: number; agreed: number }[];
  byDay: { day: string; runs: number; ok: number; limited: number; saved: number }[];
}

/**
 * One row per worker and model. Counts and times come from the history; the saved figure from the ledger, which
 * also names a worker the history files under another model (a run that stopped before its model was known),
 * so the rows always add up to the total.
 */
function workerRows(rows: any[], ledger: LedgerEntry[], audited: Map<string, { audited: number; agreed: number }>): Stats['byWorker'] {
  const out = rows.map((r) => ({ backend: r.backend as string, model: (r.model ?? undefined) as string | undefined, runs: r.runs as number, ok: (r.ok ?? 0) as number, limited: (r.limited ?? 0) as number, avgSeconds: r.avg_s as number | null, avgTokens: r.avg_t as number | null, saved: 0, audited: 0, agreed: 0 }));
  const key = (backend?: string, model?: string) => `${backend ?? ''}\0${model ?? ''}`;
  const index = new Map(out.map((r) => [key(r.backend, r.model), r]));
  for (const e of ledger) {
    // Records from before pluggable workers have no backend (it was OpenCode) and a model without its provider.
    const backend = e.backend ?? 'opencode';
    let row = index.get(key(backend, e.model)) ?? (e.model ? out.find((r) => r.backend === backend && r.model?.endsWith(`/${e.model}`)) : undefined);
    if (!row) {
      row = { backend, model: e.model, runs: 0, ok: 0, limited: 0, avgSeconds: null, avgTokens: null, saved: 0, audited: 0, agreed: 0 };
      index.set(key(backend, e.model), row);
      out.push(row);
    }
    row.saved += e.saved;
  }
  for (const r of out) {
    const a = audited.get(key(r.backend, r.model));
    if (a) Object.assign(r, a);
  }
  return out;
}

/**
 * A run that failed on a rate limit or quota. Newer records say so (`failureKind`); older ones carry the hint
 * Pitroom adds to such an error.
 */
const LIMITED = `(state='failed' AND (json_extract(meta_json,'$.failureKind')='rate-limited' OR error LIKE '%the model is rate-limited or overloaded%'))`;

export function historyStats(sinceMs?: number): Stats {
  const counted = effective().countRateLimits.value === true;
  // the runs that count: all of them, or all but the rate-limited ones
  const K = counted ? '1' : `NOT ${LIMITED}`;
  const empty: Stats = { rateLimits: counted ? 'counted' : 'excluded', totals: { runs: 0, ok: 0, failed: 0, limited: 0, seconds: 0, tokens: 0, saved: 0 }, audits: { runs: 0, agree: 0, partial: 0, disagree: 0, unclear: 0, tokens: 0 }, byWorker: [], byDay: [] };
  const db = openDb();
  if (!db) return empty;
  const since = sinceMs ? new Date(sinceMs).toISOString() : '';
  try {
    const t = db.prepare(`SELECT COALESCE(SUM(${K}),0) runs, COALESCE(SUM(state='done'),0) ok, COALESCE(SUM(${LIMITED}),0) limited, COALESCE(SUM(CASE WHEN ${K} THEN seconds END),0) seconds, COALESCE(SUM(CASE WHEN ${K} THEN tokens END),0) tokens, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT}`).get(since);
    const w = db.prepare(`SELECT backend, model, SUM(${K}) runs, SUM(state='done') ok, SUM(${LIMITED}) limited, AVG(CASE WHEN ${K} THEN seconds END) avg_s, AVG(CASE WHEN ${K} THEN tokens END) avg_t, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT} GROUP BY backend, model ORDER BY runs DESC LIMIT 40`).all(since);
    const d = db.prepare(`SELECT substr(started_at,1,10) day, SUM(${K}) runs, SUM(state='done') ok, SUM(${LIMITED}) limited, COALESCE(SUM(saved),0) saved FROM runs WHERE started_at >= ? AND ${NOT_AUDIT} GROUP BY day ORDER BY day DESC LIMIT 60`).all(since);
    const audits = auditStats(db, since);
    // Savings come from the ledger, the same figures the Live page, `pitroom savings` and the status line add up,
    // so one number is never calculated two ways. The database only supplies counts and times.
    const ledger = readLedger(sinceMs);
    const byDay = new Map<string, number>();
    for (const e of ledger) byDay.set(e.at.slice(0, 10), (byDay.get(e.at.slice(0, 10)) ?? 0) + e.saved);
    return {
      rateLimits: counted ? 'counted' : 'excluded',
      totals: { runs: t.runs, ok: t.ok, failed: t.runs - t.ok, limited: t.limited, seconds: t.seconds, tokens: t.tokens, saved: totals(ledger).saved },
      audits: audits.total,
      byWorker: workerRows(w, ledger, audits.byWorker),
      byDay: d.reverse().map((r: any) => ({ day: r.day, runs: r.runs, ok: r.ok ?? 0, limited: r.limited ?? 0, saved: byDay.get(r.day) ?? 0 })),
    };
  } catch {
    return empty;
  }
}
