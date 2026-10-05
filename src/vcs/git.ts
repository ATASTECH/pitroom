// Git plumbing for exact, non-destructive change tracking.
//
// snapshotTree() records the *whole* working tree (tracked + untracked, minus
// ignored files) as a tree object using a throwaway index. The user's index,
// refs, branches and stash are never touched; only content-addressed objects
// are added to .git/objects, which is harmless.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Change } from '../core/store.js';

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Neutralise user git config that would change output or run external programs.
const SAFE = [
  '-c', 'color.ui=false',
  '-c', 'core.quotepath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
];

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync('git', [...SAFE, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function must(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = git(cwd, args, env);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.code}`);
  return r.stdout;
}

export function gitAvailable(): boolean {
  return git(process.cwd(), ['--version']).code === 0;
}

/**
 * The directory as the file system names it. On Windows one folder has two spellings (`RUNNER~1` and
 * `runneradmin`, which git prints), and path.relative treats them as different places.
 */
export function canonical(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export function repoRoot(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? canonical(path.resolve(r.stdout.trim())) : undefined;
}

/** `exclude` keeps paths (e.g. symlinked node_modules) out of the snapshot; `drop` also removes them when they are tracked. */
export function snapshotTree(root: string, exclude: string[] = [], drop: string[] = []): string {
  const tmp = path.join(os.tmpdir(), `pitroom-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const real = path.resolve(root, must(root, ['rev-parse', '--git-path', 'index']).trim());
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    // Starting from a copy of the real index keeps stat info, so unchanged files aren't re-hashed.
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    else must(root, ['read-tree', '--empty'], env);
    must(root, ['add', '-A', '--', ':/', ...exclude.map((p) => `:(top,exclude)${p}`), ...drop.map((p) => `:(top,literal,exclude)${p}`)], env);
    if (drop.length) {
      const r = spawnSync('git', ['update-index', '--force-remove', '-z', '--stdin'], { cwd: root, env, input: `${drop.join('\0')}\0`, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git update-index failed: ${r.stderr.trim()}`);
    }
    return must(root, ['write-tree'], env).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}.lock`, { force: true });
  }
}

const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];

export function diffTrees(root: string, a: string, b: string) {
  const changes: Change[] = [];
  if (a === b) return { changes, stats: { files: 0, insertions: 0, deletions: 0 }, patch: '' };
  const parts = must(root, [...DIFF, '--name-status', '-z', a, b]).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i]!, path: parts[i + 1]! });
  let insertions = 0;
  let deletions = 0;
  for (const line of must(root, [...DIFF, '--numstat', a, b]).split('\n')) {
    const [ins, del] = line.split('\t');
    if (ins && ins !== '-') insertions += Number(ins);
    if (del && del !== '-') deletions += Number(del);
  }
  const patch = must(root, [...DIFF, '--binary', '--full-index', a, b]);
  return { changes, stats: { files: changes.length, insertions, deletions }, patch };
}

/**
 * Creates the private copy an --isolate worker edits: a separate repository at
 * `dest` whose files are exactly `tree` (the user's current state, uncommitted
 * and untracked files included). It reads the user's objects through
 * `objects/info/alternates` and writes nothing into the user's repository: no
 * commit, no ref, no worktree registration.
 *
 * Not a `git worktree`: OpenCode v2 maps a linked worktree back to the main
 * checkout, so a worker started inside one would edit the user's real files.
 */
export function createIsolatedCopy(root: string, tree: string, dest: string): void {
  const objects = path.join(path.resolve(root, must(root, ['rev-parse', '--git-common-dir']).trim()), 'objects');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  must(path.dirname(dest), ['init', '--quiet', dest]);
  fs.writeFileSync(path.join(dest, '.git', 'objects', 'info', 'alternates'), `${objects}\n`);
  must(dest, ['read-tree', tree]);
  must(dest, ['checkout-index', '--all', '--force']);
}

export function removeIsolatedCopy(dest: string, ownedBy: string): void {
  // Only ever remove copies Pitroom created under its own home directory.
  const rel = path.relative(ownedBy, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to remove ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });
}

/** Symlinks heavy ignored dirs (node_modules, .venv…) into an isolated copy so tests can run. */
export function linkIntoWorktree(root: string, worktree: string, rels: string[]): string[] {
  const linked: string[] = [];
  for (const rel of rels) {
    const src = path.join(root, rel);
    const dst = path.join(worktree, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : undefined);
    linked.push(rel);
  }
  return linked;
}

export function applyPatch(root: string, patchFile: string, reverse: boolean): { ok: boolean; message: string } {
  const flags = reverse ? ['-R'] : [];
  const check = git(root, ['apply', '--check', '--whitespace=nowarn', ...flags, patchFile]);
  if (check.code !== 0) return { ok: false, message: check.stderr.trim() };
  const r = git(root, ['apply', '--whitespace=nowarn', ...flags, patchFile]);
  return { ok: r.code === 0, message: r.stderr.trim() };
}

/** Stat plus a unified diff with 10 lines of context, for a reviewer. */
export function reviewDiff(root: string, a: string, b: string): string {
  return `${must(root, [...DIFF, '--stat', a, b]).trim()}\n\n${must(root, [...DIFF, '-U10', a, b])}`;
}

/** The commits in a..b, and the stat and wide-context diff of B since it left A (as a pull request shows them), for a reviewer. */
export function rangeDiff(root: string, a: string, b: string): string {
  const range = `${a}..${b}`;
  // since the merge base: when A moved on since, A..B would also show A's newer commits, undone. Without a merge
  // base (unrelated histories, a shallow clone) the two trees are compared as before.
  const since = git(root, ['merge-base', a, b]).code === 0 ? `${a}...${b}` : range;
  const log = must(root, ['log', '--oneline', '--no-decorate', range]).trim();
  return [
    `## COMMITS\n\n${log || '(none)'}`,
    `## FILES CHANGED\n\n${must(root, [...DIFF, '--stat', since]).trim() || '(none)'}`,
    `## DIFF\n\n${must(root, [...DIFF, '-U10', since])}`,
  ].join('\n\n');
}

/** The commit a ref names, or undefined. */
export function commitOf(root: string, ref: string): string | undefined {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export function gitDir(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--absolute-git-dir']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
