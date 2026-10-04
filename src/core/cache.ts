// Answer cache: the same read question on the same code gets the earlier answer back instead of a new worker run.
//
// The key is the question (whitespace-normalised), where in the project it was asked, the attached files' contents,
// where the worker reads (a clean snapshot or the directory itself, which may differ in secret-looking files),
// and the project's exact state: the commit (HEAD) and a tree of the working files, uncommitted and untracked ones
// included (git's ignore rules apply). Any change to a file makes it a new question. Only answers that held up are
// reused: a finished read run with an answer, every file:line reference verified, nothing written, no audit still
// running or disputing it, and younger than `cacheDays` (default 7; 0 turns the cache off). Follow-ups, web runs,
// plan tasks, reviews, audits, `--verify` runs and parallel work are never answered from the cache; `--fresh` asks a
// worker anyway, and its answer is the one reused from then on. Not in the key: git-ignored files (build output,
// dependencies), which a worker reading in place could see, and the worker or model (a cheap model's answer is reused
// for a later ask naming a capable one): `--fresh` for those.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effective } from './config.js';
import type { RunOptions } from './run.js';
import { READ_IN, type ReadIn, wantSnapshot } from './snapshot.js';
import { readSummary } from './report.js';
import { type RunMeta, isActive, listRunIds, readMeta } from './store.js';
import { commitOf, repoRoot, snapshotTree } from '../vcs/git.js';

/** The newest runs looked at for an earlier answer (older ones are not found, even within cacheDays). */
const SCAN = 500;

export interface CacheKey {
  /** The question and where it was asked. */
  key: string;
  /** The project's state: HEAD and the working tree. */
  state: string;
}

/** This run's cache key: stored on it so a later identical question finds it; undefined when it is never cached. */
export function cacheKey(o: RunOptions): CacheKey | undefined {
  if (o.verify || o.mode !== 'read' || o.continueFrom || o.web || o.plan || o.review || o.audit || o.auditRate === 1) return undefined;
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
function heldUp(m: RunMeta): boolean {
  if (m.state !== 'done' || m.mode !== 'read' || m.reviewOf || m.auditOf) return false;
  if (m.refs && m.refs.invalid.length) return false;
  if (m.warnings.some((w) => w.startsWith('READ-ONLY VIOLATION'))) return false;
  // an audit still running may yet disagree; one that did, or found it partly wrong, rules the answer out
  if (m.audit && (isActive(m.audit.state) || m.audit.verdict === 'disagree' || m.audit.verdict === 'partial')) return false;
  try {
    return readSummary(m).trim() !== '';
  } catch {
    return false;
  }
}

/** The latest earlier run (by when it ended) that asked the same question on the same code, if its answer may be reused. */
export function findCached(k: CacheKey, now = Date.now()): RunMeta | undefined {
  const maxAge = effective().cacheDays.value * 86_400_000;
  let best: { m: RunMeta; at: number } | undefined;
  for (const id of listRunIds().slice(-SCAN)) {
    let m: RunMeta;
    try {
      m = readMeta(id);
    } catch {
      continue;
    }
    if (m.cache?.key !== k.key || m.cache.state !== k.state) continue;
    // ids only order runs to the second, so the time a run ended decides which answer is the latest
    const at = Date.parse(m.endedAt ?? m.startedAt);
    if (now - at > maxAge || (best && at <= best.at) || !heldUp(m)) continue;
    best = { m, at };
  }
  return best?.m;
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
