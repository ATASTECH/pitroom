// Answer cache: the same read question on the same code gets the earlier answer back instead of a new worker run.
//
// The key is the question (whitespace-normalised), where in the project it was asked, the attached files' contents,
// where the worker reads (a clean snapshot or the directory itself, which may differ in secret-looking files),
// and the project's exact state: the commit (HEAD) and a tree of the working files, uncommitted and untracked ones
// included (git's ignore rules apply). Any change to a file makes it a new question. Only answers that held up are
// reused: a finished read run, every file:line reference verified, not disputed by an audit, and younger than
// `cacheDays` (default 7; 0 turns the cache off). Follow-ups, web runs, plan tasks, reviews and audits are never
// answered from the cache, and `--fresh` asks a worker anyway.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effective } from './config.js';
import type { RunOptions } from './run.js';
import { READ_IN, type ReadIn, wantSnapshot } from './snapshot.js';
import { type RunMeta, listRunIds, readMeta } from './store.js';
import { commitOf, repoRoot, snapshotTree } from '../vcs/git.js';

/** The newest runs looked at for an earlier answer. */
const SCAN = 500;

export interface CacheKey {
  /** The question and where it was asked. */
  key: string;
  /** The project's state: HEAD and the working tree. */
  state: string;
}

/** Whether this run may be answered from the cache, and its key; undefined when it may not (or the state is unknown). */
export function cacheKey(o: RunOptions & { fresh?: boolean }): CacheKey | undefined {
  if (o.fresh || o.mode !== 'read' || o.continueFrom || o.web || o.plan || o.review || o.audit || o.auditRate === 1) return undefined;
  if (!(effective().cacheDays.value > 0)) return undefined;
  const dir = path.resolve(o.dir);
  const root = repoRoot(dir);
  if (!root) return undefined;
  try {
    const tree = snapshotTree(root);
    const head = commitOf(root, 'HEAD') ?? '';
    const files = o.files.map((f) => {
      const abs = path.resolve(f);
      return [abs, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')];
    });
    const question = o.task.replace(/\s+/g, ' ').trim();
    const readIn = (READ_IN as string[]).includes(effective().readIn.value) ? (effective().readIn.value as ReadIn) : 'auto';
    const where = !o.inPlace && wantSnapshot(readIn, root, dir) ? 'snapshot' : 'project';
    const key = crypto.createHash('sha256').update(JSON.stringify([question, path.relative(root, dir), files, where])).digest('hex');
    return { key, state: `${head}:${tree}` };
  } catch {
    return undefined; // an unreadable attached file, a git failure: no cache, the run goes on as usual
  }
}

/** An answer that held up: done, all references verified, not disputed by an audit. */
const heldUp = (m: RunMeta): boolean =>
  m.state === 'done' && m.mode === 'read' && !m.reviewOf && !m.auditOf && (!m.refs || m.refs.invalid.length === 0) && m.audit?.verdict !== 'disagree' && m.audit?.verdict !== 'partial';

/** The newest earlier run that asked the same question on the same code, if its answer may be reused. */
export function findCached(k: CacheKey, now = Date.now()): RunMeta | undefined {
  const maxAge = effective().cacheDays.value * 86_400_000;
  for (const id of listRunIds().slice(-SCAN).reverse()) {
    let m: RunMeta;
    try {
      m = readMeta(id);
    } catch {
      continue;
    }
    if (m.cache?.key !== k.key || m.cache.state !== k.state) continue;
    if (now - Date.parse(m.endedAt ?? m.startedAt) > maxAge) return undefined; // the newest match is too old
    if (heldUp(m)) return m;
  }
  return undefined;
}

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const cachedNote = (m: RunMeta): string =>
  `pitroom ⟲ cached answer · the same question on the same code as run ${m.id} (${ago(m.endedAt ?? m.startedAt)}) · no worker ran · --fresh asks one again`;
