// Run lifecycle, independent of the worker CLI:
// prepare → snapshot / isolated copy → attempt targets in order → finalize
// (changes, reference checks, verify, receipt). Everything CLI-specific goes
// through the Backend adapter.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getBackend } from '../backends/index.js';
import type { Backend, Failure, Mode, Target } from '../backends/types.js';
import { applyPatch, createIsolatedCopy, diffTrees, linkIntoWorktree, removeIsolatedCopy, repoRoot, snapshotTree } from '../vcs/git.js';
import { resolveChain } from './chain.js';
import { effective } from './config.js';
import { UserError } from './errors.js';
import { spawnWorker, type ProcessResult } from './process.js';
import { parseStatus, parseVerdict } from './answers.js';
import { brief, loadPlan, planName, planTask } from './plan.js';
import { fill, loadTemplate } from './templates.js';
import { acquireWriteLock, releaseSlot, releaseWriteLock, tryAcquireSlot } from './slots.js';
import { buildPrompt } from './prompt.js';
import { estimateTokens, record, savedUsd } from './receipt.js';
import { extractRefs, verifyRefs } from './refs.js';
import { formatReport } from './report.js';
import { type RunMeta, newRunId, readMeta, runDir, runFile, worktreesDir, writeMeta } from './store.js';
import { describeTarget, sameTarget } from './target.js';

declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export interface RunOptions {
  mode: Mode;
  task: string;
  dir: string;
  files: string[];
  link: string[];
  worker?: string;
  model?: string;
  /** A worker from the config's "tiers"; -W wins. */
  tier?: string;
  /** `--plan PLAN --step N`: implement one task of an implementation plan. */
  plan?: { file: string; step: number };
  timeoutSec: number;
  verify?: string;
  continueFrom?: string;
  allowNonGit: boolean;
  web: boolean;
  noFallback: boolean;
  group?: string;
  /** Set by `pitroom review`. */
  review?: { of: string; kind: 'task' | 'fix' | 'range'; packageFile: string; plan?: RunMeta['plan'] };
}

/** The worker's task. For --plan: the implementer template around one plan task. */
function planWork(o: RunOptions): { task: string; tier?: string; plan?: RunMeta['plan']; brief?: string } {
  if (!o.plan) return { task: o.task.trim(), tier: o.tier };
  if (o.continueFrom) throw new UserError("a follow-up continues its parent's task; drop --plan/--step");
  if (o.mode === 'read') throw new UserError('--plan runs implement a task: add -i (an isolated copy, recommended) or -w');
  const plan = loadPlan(o.plan.file);
  const t = planTask(plan, o.plan.step);
  const text = brief(plan, t);
  const task = fill(loadTemplate('implementer'), {
    PLAN_FILE: plan.file,
    STEP: String(t.step),
    TITLE: t.title,
    BRIEF: text.trim(),
    NOTES: o.task.trim() || '(none)',
  });
  // The task's **Worker:** tier applies when the primary names no worker or tier.
  const tier = o.tier ?? (o.worker ? undefined : t.tier);
  return { task, tier, plan: { file: plan.file, step: t.step, title: t.title }, brief: text };
}

/** Validates options and writes the initial run record. Does not start the worker. */
export function prepareRun(o: RunOptions): RunMeta {
  if (process.env.PITROOM_ACTIVE === '1') {
    throw new UserError('refusing to delegate from inside a Pitroom worker (no recursive delegation)', 3);
  }
  const work = planWork(o);
  if (!work.task) throw new UserError('empty task');
  const warnings: string[] = [];
  let parent: RunMeta | undefined;
  let worker: Target;
  let fallback: Target[];

  if (o.continueFrom) {
    parent = readMeta(o.continueFrom);
    if (o.worker || o.tier) throw new UserError('a follow-up runs on the same worker as its parent; drop --worker/--tier');
    if (!parent.sessionId) throw new UserError(`run ${parent.id} has no worker session to continue`, 3);
    if (parent.mode === 'isolate' && (!parent.worktree || !fs.existsSync(parent.worktree))) {
      throw new UserError(`the isolated copy of run ${parent.id} is gone (applied or discarded)`, 3);
    }
    // Sessions live inside one CLI: follow-ups (and their fallbacks) stay on the parent's backend.
    const ran = parent.ran ?? parent.worker;
    worker = o.model ? { ...ran, model: o.model } : ran;
    fallback = o.noFallback ? [] : parent.fallback.filter((t) => t.backend === ran.backend);
  } else {
    const chain = resolveChain({ worker: o.worker, model: o.model, tier: work.tier, noFallback: o.noFallback });
    ({ worker, fallback } = chain);
    warnings.push(...chain.warnings);
  }
  const backend = getBackend(worker.backend);
  if (parent && backend.capabilities.resume === 'none') {
    throw new UserError(`the ${backend.name} worker cannot continue sessions`, 3);
  }
  if (o.files.length && !backend.capabilities.attachFiles) {
    throw new UserError(`the ${backend.name} worker cannot attach files; put the content in the task`);
  }

  const mode = parent?.mode ?? o.mode;
  const dir = path.resolve(parent?.dir ?? o.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`not a directory: ${dir}`);
  const root = repoRoot(dir);
  if (mode === 'isolate' && !root) throw new UserError('--isolate needs a git repository', 3);
  if (mode === 'write' && !root && !o.allowNonGit) {
    throw new UserError('--write outside a git repo cannot be tracked or reverted; pass --allow-non-git to accept that', 3);
  }
  const files = o.files.map((f) => path.resolve(f));
  for (const f of files) if (!fs.existsSync(f)) throw new UserError(`file not found: ${f}`);

  const meta: RunMeta = {
    id: newRunId(),
    version: VERSION,
    mode,
    task: work.task,
    dir,
    cwd: parent?.cwd ?? dir,
    repoRoot: root,
    worker,
    fallback,
    parent: parent?.id,
    group: o.group ?? parent?.group ?? (work.plan ? planName(work.plan.file) : undefined),
    sessionId: parent?.sessionId,
    files,
    link: parent?.link ?? o.link,
    timeoutSec: o.timeoutSec,
    verify: o.verify,
    web: o.web || !!parent?.web,
    state: 'queued',
    startedAt: new Date().toISOString(),
    warnings,
    // Follow-ups in an isolated copy accumulate into one patch against the original snapshot.
    baseTree: parent?.mode === 'isolate' ? parent.baseTree : undefined,
    worktree: parent?.mode === 'isolate' ? parent.worktree : undefined,
    reviewOf: o.review?.of,
    plan: work.plan ?? o.review?.plan ?? parent?.plan,
    reviewKind: o.review?.kind,
    packageFile: o.review?.packageFile,
  };
  writeMeta(meta);
  if (mode === 'write' && root) {
    // Parallel writers would claim each other's edits: one --write run per repository.
    try {
      acquireWriteLock(root, meta.id);
    } catch (e) {
      fs.rmSync(runDir(meta.id), { recursive: true, force: true });
      throw e;
    }
  }
  fs.writeFileSync(runFile(meta.id, 'task.md'), `${meta.task}\n`);
  if (work.brief) fs.writeFileSync(runFile(meta.id, 'brief.md'), work.brief);
  return meta;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a model slot (see slots.ts). Resolves undefined if stopped while queued. */
async function waitForSlot(meta: RunMeta): Promise<string | undefined> {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const max = effective().maxParallel.value;
    for (;;) {
      const slot = tryAcquireSlot(meta.id, max);
      if (slot) return slot;
      if (stopped) return undefined;
      await sleep(1000);
      if (stopped) return undefined;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export function startInBackground(meta: RunMeta): RunMeta {
  const script = process.argv[1];
  if (!script) throw new Error('cannot locate the pitroom executable');
  const child = spawn(process.execPath, [script, '__exec', meta.id], {
    detached: true,
    stdio: 'ignore',
    cwd: meta.dir,
    env: process.env,
  });
  child.unref();
  meta.pid = child.pid;
  writeMeta(meta);
  return meta;
}

/** Runs the worker to completion (foreground, or inside the detached `__exec` process). */
export async function execute(meta: RunMeta): Promise<RunMeta> {
  meta.pid = process.pid;
  meta.state = 'queued';
  writeMeta(meta);
  let result: ProcessResult = { code: null, timedOut: false, stopped: false };
  const slot = await waitForSlot(meta);
  if (!slot) return finalize(meta, { code: null, timedOut: false, stopped: true });
  meta.state = 'running';
  meta.startedAt = new Date().toISOString(); // time in queue is not worker time
  writeMeta(meta);
  try {
    prepareTree(meta);
    writeMeta(meta);

    const chain: Target[] = [];
    for (const t of [meta.worker, ...meta.fallback]) if (!chain.some((c) => sameTarget(c, t))) chain.push(t);
    for (let i = 0; i < chain.length; i++) {
      const target = chain[i]!;
      const backend = getBackend(target.backend);
      meta.ran = target;
      writeMeta(meta);
      result = await attempt(meta, backend, target);
      if (result.timedOut || result.stopped || result.spawnError) break;
      const why = retryableFailure(meta, backend, result);
      if (!why) break;
      if (!target.model && backend.defaultModel) {
        // The CLI's default just failed: don't retry the same model under its explicit name.
        const failed = backend.defaultModel();
        for (let j = chain.length - 1; j > i; j--) {
          if (chain[j]!.backend === target.backend && chain[j]!.model === failed) chain.splice(j, 1);
        }
      }
      if (i === chain.length - 1) break;
      (meta.attempts ??= []).push({ target: describeTarget(target), error: why.message });
      for (const f of ['events.jsonl', 'stderr.log']) {
        const from = runFile(meta.id, f);
        if (fs.existsSync(from)) fs.renameSync(from, runFile(meta.id, f.replace('.', `.attempt-${i + 1}.`)));
      }
      writeMeta(meta);
    }
    if (result.spawnError) {
      const b = getBackend((meta.ran ?? meta.worker).backend);
      meta.error = `${result.spawnError} (install ${b.name} or set PITROOM_${b.id.toUpperCase()}_BIN)`;
    }
  } catch (e) {
    meta.error ??= (e as Error).message;
  } finally {
    releaseSlot(slot, meta.id);
  }
  return finalize(meta, result);
}

function prepareTree(meta: RunMeta): void {
  const root = meta.repoRoot;
  if (root && meta.mode === 'write') meta.baseTree = snapshotTree(root);
  if (root && meta.mode === 'isolate' && !meta.worktree) {
    meta.baseTree = snapshotTree(root);
    meta.worktree = path.join(worktreesDir(), meta.id);
    createIsolatedCopy(root, meta.baseTree, meta.worktree);
    meta.cwd = path.join(meta.worktree, path.relative(root, meta.dir));
    const linked = linkIntoWorktree(root, meta.worktree, meta.link);
    if (linked.length) meta.warnings.push(`linked into the isolated copy (shared with your tree): ${linked.join(', ')}`);
  }
}

function attempt(meta: RunMeta, backend: Backend, target: Target): Promise<ProcessResult> {
  const inv = backend.invocation({
    mode: meta.mode,
    prompt: buildPrompt(meta.mode, meta.task, !!meta.parent),
    cwd: meta.cwd,
    model: target.model,
    sessionId: meta.sessionId,
    files: meta.files,
    web: !!meta.web,
    title: `pitroom ${meta.mode}: ${meta.task.replace(/\s+/g, ' ').slice(0, 60)}`,
  });
  return spawnWorker(inv, {
    cwd: meta.cwd,
    stdoutFile: runFile(meta.id, 'events.jsonl'),
    stderrFile: runFile(meta.id, 'stderr.log'),
    timeoutSec: meta.timeoutSec,
  });
}

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

/** Worth retrying on the next target: the worker did no work and the cause is the model/provider. */
function retryableFailure(meta: RunMeta, backend: Backend, res: ProcessResult): Failure | undefined {
  const run = backend.parse(read(runFile(meta.id, 'events.jsonl')));
  if (run.usage.steps > 0) return undefined;
  const f = backend.failure(run, read(runFile(meta.id, 'stderr.log')), res.code);
  return f && f.kind !== 'other' ? f : undefined;
}

const HINTS: Record<Failure['kind'], string> = {
  'model-unavailable':
    'the model is not available; fix the worker config, pass --worker/--model, or configure fallback workers (see `pitroom doctor`)',
  'rate-limited': 'the model is rate-limited or overloaded; configure fallback workers to fail over automatically',
  auth: "authentication or billing problem with the worker's provider",
  other: '',
};

function finalize(meta: RunMeta, res: ProcessResult): RunMeta {
  const ran = meta.ran ?? meta.worker;
  const backend = getBackend(ran.backend);
  const run = backend.parse(read(runFile(meta.id, 'events.jsonl')));
  meta.sessionId = run.sessionId ?? meta.sessionId;
  meta.usage = run.usage;
  fs.writeFileSync(runFile(meta.id, 'summary.md'), `${run.finalText}\n`);
  if (meta.plan && !meta.reviewOf) meta.taskStatus = parseStatus(run.finalText);
  if (meta.reviewOf) {
    meta.verdict = parseVerdict(run.finalText);
    if (meta.packageFile) fs.rmSync(meta.packageFile, { force: true });
  }
  if (!res.timedOut && !res.stopped && !meta.error) {
    const f = backend.failure(run, read(runFile(meta.id, 'stderr.log')), res.code);
    if (f) meta.error = HINTS[f.kind] ? `${f.message} (${HINTS[f.kind]})` : f.message;
  }

  try {
    captureChanges(meta);
  } catch (e) {
    meta.warnings.push(`could not compute changes: ${(e as Error).message}`);
  }
  if (meta.mode === 'read' && run.edits.length) {
    meta.warnings.push(`READ-ONLY VIOLATION: worker modified ${[...new Set(run.edits)].join(', ')}`);
  }
  if (meta.sessionId && backend.resolveModel) meta.resolvedModel = backend.resolveModel(meta.sessionId);
  meta.resolvedModel ??= run.model ?? ran.model;
  const refs = extractRefs(run.finalText);
  if (refs.length) {
    meta.refs = verifyRefs(refs, [meta.cwd, meta.repoRoot ?? '', meta.dir]);
    if (meta.refs.invalid.length) {
      meta.warnings.push(`${meta.refs.invalid.length} of ${meta.refs.total} file references in the answer did not check out`);
    }
  }

  meta.state = res.timedOut ? 'timeout' : res.stopped ? 'stopped' : meta.error ? 'failed' : 'done';
  if (meta.state === 'done' && !run.finalText) meta.warnings.push('worker finished without a written answer');
  if (meta.state === 'done' && meta.verify) meta.verifyResult = runVerify(meta);
  meta.endedAt = new Date().toISOString();

  meta.returnedTokens = estimateTokens(formatReport(meta, run.finalText));
  meta.savedUsd = savedUsd(meta.usage, meta.returnedTokens);
  writeMeta(meta);
  if (meta.mode === 'write' && meta.repoRoot) releaseWriteLock(meta.repoRoot, meta.id);
  record(meta);
  return meta;
}

function captureChanges(meta: RunMeta): void {
  const root = meta.repoRoot;
  if (!root || !meta.baseTree || meta.mode === 'read') return;
  const target = meta.mode === 'isolate' ? meta.worktree! : root;
  meta.afterTree = snapshotTree(target, meta.mode === 'isolate' ? meta.link : []);
  // An isolated copy holds the new objects itself (and sees the user's through alternates).
  const d = diffTrees(target, meta.baseTree, meta.afterTree);
  meta.changes = d.changes;
  meta.stats = d.stats;
  fs.writeFileSync(runFile(meta.id, 'changes.patch'), d.patch);
}

function runVerify(meta: RunMeta): RunMeta['verifyResult'] {
  const r = spawnSync(meta.verify!, {
    cwd: meta.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PWD: meta.cwd, PITROOM_ACTIVE: '1' },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(runFile(meta.id, 'verify.log'), output);
  return { ok: r.status === 0, code: r.status, tail: output.trimEnd().split('\n').slice(-25).join('\n') };
}

export function applyRun(meta: RunMeta): string {
  if (meta.mode !== 'isolate') throw new UserError(`run ${meta.id} edited your tree directly (${meta.mode}); nothing to apply`);
  if (meta.applied) throw new UserError(`run ${meta.id} was already applied`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
  const res = applyPatch(meta.repoRoot!, runFile(meta.id, 'changes.patch'), false);
  if (!res.ok) throw new UserError(`patch does not apply cleanly (your tree changed since the snapshot):\n${res.message}`, 1);
  meta.applied = true;
  cleanupWorktree(meta);
  writeMeta(meta);
  return `applied ${meta.changes.length} file(s) from ${meta.id} to ${meta.repoRoot}`;
}

export function revertRun(meta: RunMeta): string {
  if (meta.mode !== 'write') throw new UserError(`only --write runs can be reverted (this is ${meta.mode})`);
  if (meta.reverted) throw new UserError(`run ${meta.id} was already reverted`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
  const res = applyPatch(meta.repoRoot!, runFile(meta.id, 'changes.patch'), true);
  if (!res.ok) throw new UserError(`cannot revert cleanly (files changed after the run):\n${res.message}`, 1);
  meta.reverted = true;
  writeMeta(meta);
  return `reverted ${meta.changes.length} file(s) changed by ${meta.id}`;
}

export function discardRun(meta: RunMeta): string {
  if (meta.mode !== 'isolate') throw new UserError('only --isolate runs have an isolated copy to discard');
  cleanupWorktree(meta);
  meta.discarded = true;
  writeMeta(meta);
  return `discarded the isolated copy of ${meta.id}; the patch stays in ${runFile(meta.id, 'changes.patch')}`;
}

function cleanupWorktree(meta: RunMeta): void {
  if (meta.worktree && fs.existsSync(meta.worktree)) removeIsolatedCopy(meta.worktree, worktreesDir());
}
