// Run lifecycle, independent of the worker CLI:
// prepare → snapshot / isolated copy → attempt targets in order → finalize
// (changes, reference checks, verify, receipt). Everything CLI-specific goes
// through the Backend adapter.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getBackend } from '../backends/index.js';
import type { Backend, Failure, Mode, Target } from '../backends/types.js';
import { applyPatch, canonical, createIsolatedCopy, diffTrees, linkIntoWorktree, removeIsolatedCopy, repoRoot, snapshotTree } from '../vcs/git.js';
import { resolveChain } from './chain.js';
import { effective } from './config.js';
import { DeletionRefused, UserError } from './errors.js';
import { spawnWorker, type ProcessResult } from './process.js';
import { parseAudit, parseStatus, parseVerdict } from './answers.js';
import { activeCooldown, cooldownKey, recordCooldown, untilText } from './cooldown.js';
import { READ_IN, type ReadIn, backToProject, readSnapshot, wantSnapshot } from './snapshot.js';
import { auditTask, auditable, pickAuditor, sampled } from './audit.js';
import { notifyEnded } from './notify.js';
import { refreshInBackground } from './prices.js';
import { brief, loadPlan, planName, planTask } from './plan.js';
import { fill, loadTemplate } from './templates.js';
import { acquireWriteLock, releaseSlot, releaseWriteLock, tryAcquireSlot } from './slots.js';
import { buildPrompt } from './prompt.js';
import { costAt, estimateTokens, record, savedUsd, workerPrice } from './receipt.js';
import { extractRefs, verifyRefs } from './refs.js';
import { findSecretFiles, findSecretFilesInTree, secretWarning } from './secrets.js';
import { formatReport } from './report.js';
import { type RunMeta, freshMeta, isActive, isAlive, newRunId, readMeta, requestStop, runDir, runFile, worktreesDir, writeMeta } from './store.js';
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
  /** Reasoning-effort level for the worker (low, medium, high, xhigh, …), applied as `model#level`. */
  effort?: string;
  /** `--plan PLAN --step N`: implement one task of an implementation plan. */
  plan?: { file: string; step: number };
  timeoutSec: number;
  verify?: string;
  continueFrom?: string;
  allowNonGit: boolean;
  web: boolean;
  noFallback: boolean;
  group?: string;
  /** `--in-place`: a read run reads the directory itself, never a clean snapshot (see snapshot.ts). */
  inPlace?: boolean;
  /** Set when Pitroom audits a run's answer (see audit.ts). */
  audit?: { of: string };
  /** This run's own audit chance, 0 to 1: --audit is 1, --no-audit is 0. */
  auditRate?: number;
  /** The answer cache's key, stored on the run so a later identical question finds it (see cache.ts). */
  cache?: { key: string; state: string };
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
    if (o.worker || o.tier || o.effort) throw new UserError('a follow-up runs on the same worker as its parent; drop --worker/--tier/--effort');
    if (!parent.sessionId) throw new UserError(`run ${parent.id} has no worker session to continue`, 3);
    if (parent.mode === 'isolate' && (!parent.worktree || !fs.existsSync(parent.worktree))) {
      throw new UserError(`the isolated copy of run ${parent.id} is gone (applied or discarded)`, 3);
    }
    // Sessions live inside one CLI: follow-ups (and their fallbacks) stay on the parent's backend.
    const ran = parent.ran ?? parent.worker;
    worker = o.model ? { ...ran, model: o.model } : ran;
    fallback = o.noFallback ? [] : parent.fallback.filter((t) => t.backend === ran.backend);
  } else {
    const chain = resolveChain({ worker: o.worker, model: o.model, tier: work.tier, effort: o.effort, noFallback: o.noFallback });
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
  const dir = canonical(path.resolve(parent?.dir ?? o.dir));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`not a directory: ${dir}`);
  const root = repoRoot(dir);
  if (mode === 'isolate' && !root) throw new UserError('--isolate needs a git repository', 3);
  if (mode === 'write' && !root && !o.allowNonGit) {
    throw new UserError('--write outside a git repo cannot be tracked or reverted; pass --allow-non-git to accept that', 3);
  }
  const files = o.files.map((f) => path.resolve(f));
  for (const f of files) if (!fs.existsSync(f)) throw new UserError(`file not found: ${f}`);

  // A read run in a directory with secret-looking files reads a clean snapshot instead (made when it starts).
  const readIn = (READ_IN as string[]).includes(effective().readIn.value) ? (effective().readIn.value as ReadIn) : 'auto';
  const snap = mode === 'read' && !o.review && !o.inPlace && !parent ? wantSnapshot(readIn, root, dir) : undefined;
  if (parent?.snapshot?.dir && !fs.existsSync(parent.snapshot.dir)) {
    throw new UserError(`the read snapshot of run ${parent.id} is gone (cleaned up); ask the question again as a new run`, 3);
  }
  // Said once per run, on the report and when it starts in the background.
  if (!parent && !snap && !process.env.PITROOM_NO_SECRET_WARNING) {
    const secrets = mode === 'isolate' && root ? findSecretFilesInTree(root, dir) : findSecretFiles(dir);
    const note = secretWarning(secrets, mode);
    if (note) warnings.push(note);
  }

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
    auditOf: o.audit?.of,
    auditRate: o.auditRate,
    inPlace: o.inPlace || undefined,
    cache: o.cache,
    snapshot: parent?.snapshot ?? (snap ? { dir: '', tree: '', left: snap.secrets } : undefined),
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
  // written before the process starts: it reads the record, and must see this
  meta.background = true;
  writeMeta(meta);
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
      // A model that said "rate limited" a moment ago is skipped while a fallback is left to run.
      const cooling = activeCooldown(cooldownKey(target, backend));
      if (cooling && chain.slice(i + 1).some((t) => !activeCooldown(cooldownKey(t, getBackend(t.backend))))) {
        (meta.attempts ??= []).push({ target: describeTarget(target), error: `cooling down ${untilText(cooling)}: ${cooling.reason}`, skipped: true });
        writeMeta(meta);
        continue;
      }
      meta.ran = target;
      writeMeta(meta);
      result = await attempt(meta, backend, target);
      if (result.timedOut || result.stopped || result.spawnError) break;
      const why = retryableFailure(meta, backend, result);
      if (!why) break;
      if (why.kind === 'rate-limited') recordCooldown(cooldownKey(target, backend), describeTarget(target), why.message);
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
  const done = finalize(meta, result);
  autoAudit(done);
  return done;
}

/** Starts the audit of a finished run when the sample takes it. An audit is a bonus: it never fails or delays the run. */
function autoAudit(meta: RunMeta): void {
  try {
    if (!auditable(meta, read(runFile(meta.id, 'summary.md'))) || !sampled(meta)) return;
    startAudit(meta);
  } catch {
    // not audited
  }
}

/**
 * Starts an audit of a finished read run in the background: another worker re-checks the answer. `worker` names it
 * (else `pickAuditor`); undefined when no other worker is configured to do it.
 */
export function startAudit(meta: RunMeta, worker?: string): RunMeta | undefined {
  const answer = read(runFile(meta.id, 'summary.md'));
  const auditor = worker ?? pickAuditor(meta);
  if (!auditor) return undefined;
  const a = prepareRun({
    mode: 'read',
    task: auditTask(meta, answer),
    dir: meta.dir,
    files: [],
    link: [],
    worker: auditor,
    timeoutSec: Math.min(meta.timeoutSec, 15 * 60),
    allowNonGit: true,
    web: false,
    // never fall back to the worker being audited
    noFallback: true,
    group: meta.group,
    audit: { of: meta.id },
  });
  meta.audit = { id: a.id, state: 'running' };
  writeMeta(meta);
  startInBackground(a);
  return a;
}

/** Puts an audit's outcome on the audited run, which the dashboard and `pitroom show` read it from. */
function settleAudit(a: RunMeta): void {
  try {
    const target = readMeta(a.auditOf!);
    target.audit = { id: a.id, state: a.state, verdict: a.state === 'done' ? a.auditVerdict : undefined, disputed: a.state === 'done' ? a.auditDisputed : undefined };
    writeMeta(target);
  } catch {
    // the audited run is gone
  }
}

function prepareTree(meta: RunMeta): void {
  const root = meta.repoRoot;
  if (root && meta.mode === 'read' && meta.snapshot && !meta.snapshot.dir) {
    const shown = meta.snapshot.left.slice(0, 3).join(', ') + (meta.snapshot.left.length > 3 ? `, +${meta.snapshot.left.length - 3} more` : '');
    try {
      const s = readSnapshot(root);
      meta.snapshot.dir = s.dir;
      meta.snapshot.tree = s.tree;
      meta.cwd = path.join(s.dir, path.relative(root, meta.dir));
      if (!fs.existsSync(meta.cwd)) meta.cwd = s.dir;
      if (shown) meta.warnings.push(`read in a clean snapshot of your project: the secret-looking files (${shown}) and git-ignored files are not in it; --in-place reads the directory itself`);
    } catch (e) {
      // not worth failing the run: read the directory, and say what is exposed
      meta.snapshot = undefined;
      meta.warnings.push(`could not make a clean snapshot (${(e as Error).message.slice(0, 120)}): the worker reads the directory itself${shown ? `, where secret-looking files sit (${shown})` : ''}`);
    }
  }
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
    prompt: buildPrompt(meta.mode, meta.task, !!meta.parent, !!meta.auditOf),
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
  // what the worker says about its files is about the project's, not the snapshot's, paths
  if (meta.snapshot?.dir && meta.repoRoot) run.finalText = backToProject(run.finalText, meta.snapshot.dir, meta.repoRoot);
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
    if (f) {
      meta.error = HINTS[f.kind] ? `${f.message} (${HINTS[f.kind]})` : f.message;
      meta.failureKind = f.kind;
    }
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
  if (meta.auditOf && meta.state === 'done') {
    const found = parseAudit(run.finalText);
    meta.auditVerdict = found.verdict;
    meta.auditDisputed = found.disputed;
  }
  if (meta.state === 'done' && !run.finalText) meta.warnings.push('worker finished without a written answer');
  if (meta.state === 'done' && meta.verify) meta.verifyResult = runVerify(meta);
  meta.endedAt = new Date().toISOString();

  // A CLI that reports no cost (Codex, Gemini): estimate it from the prices the user gave, so the savings are not
  // computed as if the worker had been free. Only when they gave one; otherwise it stays unknown ("n/a").
  if (meta.usage && meta.usage.cost === undefined) {
    const price = workerPrice(ran.backend, meta.resolvedModel ?? run.model, ran.model);
    if (price) {
      meta.usage.costEstimate = costAt(meta.usage, price);
      meta.usage.costSource = price.source ?? 'config';
    }
  }
  meta.returnedTokens = estimateTokens(formatReport(meta, run.finalText));
  // An audit is overhead, not a delegation that saved anything.
  meta.savedUsd = meta.auditOf ? 0 : savedUsd(meta.usage, meta.returnedTokens);
  writeMeta(meta);
  if (meta.mode === 'write' && meta.repoRoot) releaseWriteLock(meta.repoRoot, meta.id);
  record(meta);
  if (meta.auditOf) settleAudit(meta);
  notifyEnded(meta);
  refreshInBackground(); // the price catalog, when the feed is on and it is due: in a process of its own
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

/**
 * The PATH a verify command runs with: the one Pitroom got, then the directory of the Node running Pitroom (npm and
 * npx sit next to it) and the usual install places. An app that starts Pitroom (an MCP client, a GUI) often passes a
 * bare PATH, and `npm test` would then be "command not found". Added at the end, so the user's own choice still wins.
 */
function verifyPath(): string {
  const extra = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of process.platform === 'win32' ? [path.dirname(process.execPath)] : extra) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

function runVerify(meta: RunMeta): RunMeta['verifyResult'] {
  const r = spawnSync(meta.verify!, {
    cwd: meta.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: verifyPath(), PWD: meta.cwd, PITROOM_ACTIVE: '1' },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(runFile(meta.id, 'verify.log'), output);
  // cmd.exe has no exit 127: it exits 1 and says the command "is not recognized"
  const notFound = process.platform === 'win32' && r.status === 1 && /is not recognized as an internal or external command/.test(output);
  return { ok: r.status === 0, code: notFound ? 127 : r.status, tail: output.trimEnd().split('\n').slice(-25).join('\n') };
}

/**
 * Lands an isolated run's patch. A patch that deletes files is refused unless the user said yes
 * (`allowDelete`): a worker may decide a file should go, your tree loses files only when the primary agent (or you) allows it.
 */
export function applyRun(meta: RunMeta, allowDelete = false): string {
  if (meta.mode !== 'isolate') throw new UserError(`run ${meta.id} edited your tree directly (${meta.mode}); nothing to apply`);
  if (meta.applied) throw new UserError(`run ${meta.id} was already applied`);
  if (!meta.changes?.length) throw new UserError(`run ${meta.id} has no changes`);
  const deleted = meta.changes.filter((c) => c.status === 'D').map((c) => c.path);
  if (deleted.length && !allowDelete) {
    const list = deleted.slice(0, 10).map((f) => `  ${f}`).join('\n') + (deleted.length > 10 ? `\n  … ${deleted.length - 10} more` : '');
    throw new DeletionRefused(
      `run ${meta.id} deletes ${deleted.length} file${deleted.length === 1 ? '' : 's'}; nothing was applied:\n${list}\nCheck that the deletion is what the user asked for: if so apply with --allow-delete, otherwise ask the user or discard the run.`,
      deleted,
    );
  }
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

/** Asks an active run's process to stop. The run's record, or undefined when it is not active. */
export function stopRun(id: string): RunMeta | undefined {
  const meta = freshMeta(id);
  if (!isActive(meta.state) || !isAlive(meta.pid)) return undefined;
  // Said first: a process that is still starting up has no handler yet and dies on the signal, and then it is
  // "stopped", not "exited unexpectedly".
  requestStop(meta.id);
  meta.stopRequested = true;
  writeMeta(meta);
  process.kill(meta.pid!, 'SIGTERM');
  return meta;
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
