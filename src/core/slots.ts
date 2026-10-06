// Concurrency control across independent pitroom processes, using files that
// are created atomically (O_EXCL) and hold the owning run id:
//   slots/slot-N         at most `maxParallel` workers talk to models at once;
//   locks/<repo hash>    at most one --write run per repository (parallel writers
//                        would claim each other's edits in snapshots and reverts).
// A holder whose run is no longer active (crashed, finished) is stale and replaced.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { freshMeta, home, isActive, isAlive } from './store.js';

const slotsDir = () => path.join(home(), 'slots');
const locksDir = () => path.join(home(), 'locks');

/** Grace period for a run that has been prepared but whose process has not reported a pid yet. */
const STARTUP_GRACE_MS = 30_000;

/**
 * Whether the run that holds a claim is still alive. A holder that is not alive (finished, crashed, its process gone) is
 * stale, and so is one whose record cannot be read at all (its folder was removed: `clean`, or a hand-deleted run): the claim
 * is taken over rather than waited on forever. Asking also settles a dead process's record (`freshMeta` marks it failed).
 */
function holderActive(runId: string, self: string): boolean {
  if (!runId || runId === self) return false;
  try {
    const m = freshMeta(runId);
    if (!isActive(m.state)) return false;
    if (m.pid) return isAlive(m.pid);
    return Date.now() - Date.parse(m.startedAt) < STARTUP_GRACE_MS;
  } catch {
    return false;
  }
}

function tryClaim(file: string, runId: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, runId, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let owner = '';
  try {
    owner = fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* released meanwhile */
  }
  if (owner === runId) return true;
  if (holderActive(owner, runId)) return false;
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, runId, { flag: 'wx' });
    return true;
  } catch {
    return false; // another process took it first
  }
}

function releaseIfOwner(file: string | undefined, runId: string): void {
  if (!file) return;
  try {
    if (fs.readFileSync(file, 'utf8').trim() === runId) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

export function tryAcquireSlot(runId: string, maxParallel: number): string | undefined {
  for (let n = 0; n < Math.max(1, maxParallel); n++) {
    const file = path.join(slotsDir(), `slot-${n}`);
    if (tryClaim(file, runId)) return file;
  }
  return undefined;
}

export const releaseSlot = (file: string | undefined, runId: string) => releaseIfOwner(file, runId);

/** Run ids currently holding a slot (for status displays). */
export function slotHolders(): string[] {
  if (!fs.existsSync(slotsDir())) return [];
  return fs
    .readdirSync(slotsDir())
    .map((f) => {
      try {
        return fs.readFileSync(path.join(slotsDir(), f), 'utf8').trim();
      } catch {
        return '';
      }
    })
    .filter((id) => holderActive(id, ''));
}

const lockFile = (repoRoot: string) =>
  path.join(locksDir(), `write-${crypto.createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 16)}`);

export function acquireWriteLock(repoRoot: string, runId: string): void {
  const file = lockFile(repoRoot);
  if (tryClaim(file, runId)) return;
  let owner = '';
  try {
    owner = fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* ignore */
  }
  throw new UserError(`another --write run (${owner}) is active in this repo; use --isolate for parallel changes`, 3);
}

export const releaseWriteLock = (repoRoot: string, runId: string) => releaseIfOwner(lockFile(repoRoot), runId);
