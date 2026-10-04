// Read snapshots: a read run that would otherwise run in a directory holding secret-looking files (.env, keys) reads a
// clean snapshot of the project instead. Nothing stops a worker from opening a `.env` in the directory it runs in
// (the worker CLIs differ in what they refuse), so the file is simply not there: the snapshot holds the project's
// current state (uncommitted and untracked files included) minus ignored files and minus anything that looks secret.
//
// It is made from git objects (a checkout, like an isolated copy), kept per tree hash and shared: twenty read workers
// on the same state use one snapshot, and nothing is ever copied back, since a read run has no changes to land.
// Old ones are pruned. Files are made read-only, so a worker that does write cannot change what the others read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createIsolatedCopy, removeIsolatedCopy, snapshotTree } from '../vcs/git.js';
import { findSecretFiles, findSecretFilesInTree } from './secrets.js';
import { type RunMeta, home, isActive, listRunIds, readMeta } from './store.js';

export type ReadIn = 'auto' | 'snapshot' | 'project';
export const READ_IN: ReadIn[] = ['auto', 'snapshot', 'project'];

const KEEP_MS = 24 * 3_600_000;
const PRUNE_AGE_MS = 3 * 24 * 3_600_000;
const KEEP_NEWEST = 6;
const JUST_USED_MS = 10 * 60_000;

export const snapshotsDir = () => path.join(home(), 'snapshots');

/** Secret-looking files that decide whether a read run reads a snapshot; undefined = it runs in place. */
export function wantSnapshot(readIn: ReadIn, root: string | undefined, dir: string): { secrets: string[] } | undefined {
  if (!root || readIn === 'project') return undefined;
  const secrets = findSecretFiles(dir);
  return readIn === 'snapshot' || secrets.length ? { secrets } : undefined;
}

/** The snapshot of the project's current state without secret-looking files; made once per state, then reused. */
export function readSnapshot(root: string): { dir: string; tree: string; created: boolean } {
  const drop = findSecretFilesInTree(root, root);
  const tree = snapshotTree(root, [], drop);
  const dest = path.join(snapshotsDir(), tree);
  if (fs.existsSync(path.join(dest, '.git'))) {
    touch(dest);
    return { dir: dest, tree, created: false };
  }
  const tmp = path.join(snapshotsDir(), `.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    createIsolatedCopy(root, tree, tmp);
    readOnly(tmp);
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      // another run made the same snapshot a moment ago: use that one
      if (!fs.existsSync(path.join(dest, '.git'))) throw e;
      removeIsolatedCopy(tmp, snapshotsDir());
    }
  } catch (e) {
    try {
      removeIsolatedCopy(tmp, snapshotsDir());
    } catch {
      // nothing to remove
    }
    throw e;
  }
  prune();
  return { dir: dest, tree, created: true };
}

function touch(dir: string): void {
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch {
    // best effort
  }
}

/** Files read-only (not the directories): a stray write cannot change what other workers read. */
function readOnly(dir: string): void {
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) fs.chmodSync(p, fs.statSync(p).mode & ~0o222);
    }
  };
  try {
    walk(dir);
  } catch {
    // best effort: the snapshot is still usable
  }
}

/**
 * Removes snapshots that no active run reads: those nobody used for three days, and any beyond the newest few (every
 * edit of the project makes a new state, and a snapshot of a big repository is big). The number removed.
 */
export function prune(now = Date.now(), maxAgeMs = PRUNE_AGE_MS, keepNewest = KEEP_NEWEST): number {
  let names: string[];
  try {
    names = fs.readdirSync(snapshotsDir());
  } catch {
    return 0;
  }
  const inUse = new Set<string>();
  for (const id of listRunIds()) {
    try {
      const m: RunMeta = readMeta(id);
      if (m.snapshot?.dir && isActive(m.state)) inUse.add(path.resolve(m.snapshot.dir));
    } catch {
      // a record being written right now
    }
  }
  const entries = names
    .map((n) => {
      const dir = path.join(snapshotsDir(), n);
      try {
        return { n, dir, age: now - fs.statSync(dir).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((e): e is { n: string; dir: string; age: number } => !!e)
    .sort((x, y) => x.age - y.age); // newest first
  let removed = 0;
  let rank = 0;
  for (const e of entries) {
    if (inUse.has(path.resolve(e.dir))) continue;
    const half = e.n.startsWith('.tmp-');
    // a half-made snapshot is left alone for a day, in case a run is still making it
    const old = e.age >= (half ? KEEP_MS : maxAgeMs);
    const surplus = !half && ++rank > keepNewest && e.age >= JUST_USED_MS;
    if (!old && !surplus) continue;
    try {
      makeWritable(e.dir);
      removeIsolatedCopy(e.dir, snapshotsDir());
      removed++;
    } catch {
      // leave it for next time
    }
  }
  return removed;
}

function makeWritable(dir: string): void {
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) fs.chmodSync(p, fs.statSync(p).mode | 0o200);
    }
  };
  try {
    walk(dir);
  } catch {
    // removal will say if it matters
  }
}

/** The worker saw the snapshot's paths (as its CLI prints its working directory: often the resolved one): in what it says, they are the project's. */
export function backToProject(text: string, snapshotDir: string, root: string): string {
  let real = snapshotDir;
  try {
    real = fs.realpathSync(snapshotDir);
  } catch {
    // gone: only the given spelling
  }
  let out = text;
  for (const dir of new Set([real, snapshotDir])) out = out.split(`${dir}${path.sep}`).join(`${root}${path.sep}`).split(dir).join(root);
  return out;
}
