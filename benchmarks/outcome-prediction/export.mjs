#!/usr/bin/env node
// Exports Pitroom's own run history as a dataset for outcome prediction: one line per run, with what is known
// when the run starts (worker, mode, kind, task length, whether that worker failed just before) and how it
// ended (failed or not, why, whether its references and its audit held up).
//
// The data stays on this machine: it is written to ./data/ (git-ignored). The task text is left out unless
// --with-text is given (for trying a text classifier later); paths are reduced to where the run came from.
//
//   node export.mjs [--home ~/.local/state/pitroom] [--with-text]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean));
const stateHome = () =>
  process.env.PITROOM_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'pitroom')
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'pitroom'));
const home = path.resolve((args.home ?? stateHome()).replace(/^~/, os.homedir()));
const withText = args['with-text'] === 'true';

/** Where a run came from, by its directory: the benchmarks, Pitroom's own test sandboxes, or real use. */
const origin = (dir = '') => (/bench-repos|bench-work/.test(dir) ? 'benchmark' : /pitroom-test-|[\\/]T[\\/]|[\\/]tmp[\\/]/.test(dir) ? 'test' : 'real');

/** Why a run did not finish, from its error text. Rate limits and quotas are about the provider, not the task. */
const cause = (state, error) => {
  if (state === 'done') return 'none';
  if (state === 'timeout') return 'timeout';
  if (state === 'stopped') return 'stopped';
  const e = error ?? '';
  if (/rate.?limit|quota|429|cooling|too many|usage limit|Endpoint is unavailable|overloaded/i.test(e)) return 'rate-limit';
  if (/auth|log ?in|sign.?in|credential|\b401\b|\b403\b/i.test(e)) return 'auth';
  if (/not supported|invalid.?request|HTTP 404/i.test(e)) return 'model-unavailable';
  if (/exited unexpectedly|signal|killed/i.test(e)) return 'crash';
  return 'other';
};

// The reference checker learned bare file names on 2026-10-02 (0.6.10): earlier "file not found" results are not about the answer.
const REFS_RELIABLE_FROM = '2026-10-02T18:00:00Z';
const RECENT_MS = 30 * 60_000;

const db = new DatabaseSync(path.join(home, 'history.db'), { readOnly: true });
const rows = db.prepare('SELECT id, started_at, ended_at, state, mode, backend, model, task, dir, review_of, error, meta_json FROM runs ORDER BY started_at').all();
const metas = new Map(rows.map((r) => [r.id, JSON.parse(r.meta_json)]));

// An audit's verdict belongs to the run it checked.
const auditOf = new Map();
for (const [, m] of metas) if (m.auditOf && m.auditVerdict) auditOf.set(m.auditOf, m.auditVerdict);

const out = [];
const ended = []; // { worker, endedAt, failed } of every earlier run, for the "failed just before" feature
for (const r of rows) {
  const m = metas.get(r.id);
  const worker = `${r.backend ?? '?'}:${r.model ?? 'default'}`;
  const start = Date.parse(r.started_at);
  // Only what had ended before this run started: the feature must be known at that moment.
  const recent = ended.filter((e) => e.worker === worker && e.endedAt <= start && start - e.endedAt <= RECENT_MS);
  const refsReliable = r.started_at >= REFS_RELIABLE_FROM && m.refs?.total > 0;
  const row = {
    id: r.id,
    startedAt: r.started_at,
    origin: origin(r.dir),
    worker,
    backend: r.backend ?? '?',
    mode: r.mode ?? '?',
    kind: m.auditOf ? 'audit' : r.review_of ? 'review' : 'run',
    taskChars: (r.task ?? '').length,
    inGroup: !!m.group,
    recentRuns: recent.length,
    recentFailures: recent.filter((e) => e.failed).length,
    state: r.state,
    cause: cause(r.state, r.error),
    failed: r.state === 'failed' || r.state === 'timeout',
    refsTotal: refsReliable ? m.refs.total : null,
    refsInvalid: refsReliable ? m.refs.invalid.length : null,
    audit: auditOf.get(r.id) ?? null,
    ...(withText ? { task: r.task ?? '' } : {}),
  };
  out.push(row);
  if (r.ended_at) ended.push({ worker, endedAt: Date.parse(r.ended_at), failed: row.failed });
}

const dir = path.join(here, 'data');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'runs.jsonl');
fs.writeFileSync(file, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
const count = (f) => out.filter(f).length;
console.log(`${out.length} runs → ${path.relative(process.cwd(), file)}${withText ? ' (with task text)' : ''}`);
console.log(`  origin: ${['real', 'benchmark', 'test'].map((o) => `${o} ${count((x) => x.origin === o)}`).join(', ')}`);
console.log(`  failed: ${count((x) => x.failed)} (rate-limit ${count((x) => x.cause === 'rate-limit')}), stopped: ${count((x) => x.state === 'stopped')}`);
console.log(`  with reliable references: ${count((x) => x.refsTotal !== null)} (any invalid ${count((x) => x.refsInvalid > 0)}), audited: ${count((x) => x.audit)}`);
