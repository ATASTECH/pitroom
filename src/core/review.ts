// `pitroom review`: a read-only worker judges one run's change (task review), one
// fix round (scoped re-review) or a range of commits (whole-branch review). It
// reads a single package file (requirements, report, diff) that Pitroom writes
// into the git dir of the reviewer's workspace: every worker CLI can open it
// there, and it never passes through the primary agent's context. By default the
// reviewer runs on another backend than the implementer: a second model, not the
// same one grading itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BACKEND } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { commitOf, gitDir, rangeDiff, repoRoot, reviewDiff } from '../vcs/git.js';
import { effective } from './config.js';
import { UserError } from './errors.js';
import { loadPlan, planName } from './plan.js';
import { readNotes } from './plan-status.js';
import { readSummary } from './report.js';
import { type RunMeta, freshMeta, isActive, listRunIds, readMeta, runFile } from './store.js';
import { parseTarget } from './target.js';
import type { TemplateName } from './templates.js';

export type ReviewKind = 'task' | 'fix' | 'range';

export interface ReviewJob {
  kind: ReviewKind;
  /** The reviewed run id, or the range "a..b". */
  of: string;
  /** Where the reviewer works. */
  dir: string;
  package: string;
  implementer?: Target;
  group?: string;
  plan?: RunMeta['plan'];
}

export const TEMPLATE: Record<ReviewKind, TemplateName> = { task: 'task-reviewer', fix: 're-review', range: 'code-reviewer' };

const section = (title: string, body: string) => `## ${title}\n\n${body.trim() || '(empty)'}\n`;

/** Parent, grandparent, … of a follow-up run. */
function ancestors(m: RunMeta): RunMeta[] {
  const out: RunMeta[] = [];
  for (let id = m.parent; id; ) {
    const a = readMeta(id);
    out.push(a);
    id = a.parent;
  }
  return out;
}

/** What was asked: the brief of the chain's first run (a plan task), else its task. */
function briefOf(m: RunMeta): string {
  const root = [m, ...ancestors(m)].at(-1)!;
  const f = runFile(root.id, 'brief.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : root.task;
}

/** The latest finished review of any of these runs. */
function latestReview(ids: string[]): RunMeta | undefined {
  for (const id of listRunIds().reverse()) {
    try {
      const m = readMeta(id);
      if (m.reviewOf && ids.includes(m.reviewOf) && m.state === 'done') return m;
    } catch {
      // a record being written right now
    }
  }
  return undefined;
}

/** The run's change from `from` (default: its snapshot) to its end state. */
function diffOf(m: RunMeta, from = m.baseTree): string {
  const where = m.mode === 'isolate' ? m.worktree : m.repoRoot;
  if (where && fs.existsSync(where) && from && m.afterTree) return reviewDiff(where, from, m.afterTree);
  if (from !== m.baseTree) {
    throw new UserError(`the isolated copy of ${m.id} is gone, so its fix round cannot be shown on its own; review a run that is not applied yet`, 3);
  }
  return fs.readFileSync(runFile(m.id, 'changes.patch'), 'utf8');
}

export function runReview(id: string): ReviewJob {
  const m = freshMeta(id);
  if (isActive(m.state)) throw new UserError(`run ${m.id} is still ${m.state}; pitroom wait ${m.id} first`, 3);
  if (m.reviewOf) throw new UserError(`run ${m.id} is itself a review`);
  if (m.mode === 'read') throw new UserError(`run ${m.id} was read-only; there is no change to review`);
  if (!m.changes?.length) throw new UserError(`run ${m.id} made no changes; nothing to review`);
  const chain = ancestors(m);
  const previous = latestReview(chain.map((a) => a.id));
  // The implementer's isolated copy while it exists (the code after the change), else the project.
  const dir = m.mode === 'isolate' && m.worktree && fs.existsSync(m.worktree) ? m.cwd : m.dir;
  const job = { of: m.id, dir, implementer: m.ran ?? m.worker, group: m.group, plan: m.plan };
  const title = m.plan ? `Task ${m.plan.step}: ${m.plan.title}` : `run ${m.id}`;
  if (!previous) {
    return {
      ...job,
      kind: 'task',
      package: [`# Review package · ${title}\n`, section('BRIEF', briefOf(m)), section('REPORT', readSummary(m)), section('DIFF', diffOf(m))].join('\n'),
    };
  }
  // A follow-up: every round since the reviewed one, judged against the previous
  // findings (a skipped round in between still counts: its fixes matter too).
  const reviewed = chain.find((a) => a.id === previous.reviewOf)!;
  const from = m.mode === 'isolate' ? reviewed.afterTree : m.baseTree;
  return {
    ...job,
    kind: 'fix',
    package: [
      `# Re-review package · ${title} · fix round after review ${previous.id}\n`,
      section('BRIEF', briefOf(m)),
      section('PREVIOUS FINDINGS', readSummary(previous)),
      section('FIX REPORT', readSummary(m)),
      section('FIX DIFF', diffOf(m, from)),
    ].join('\n'),
  };
}

export function rangeReview(range: string, dir: string, planFile?: string): ReviewJob {
  const root = repoRoot(dir);
  if (!root) throw new UserError('--range needs a git repository');
  const i = range.indexOf('..');
  const a = i > 0 ? range.slice(0, i) : '';
  const b = i > 0 ? range.slice(i + 2) || 'HEAD' : '';
  if (!a || b.startsWith('.')) throw new UserError(`--range takes A..B (e.g. main..HEAD), not "${range}"`);
  for (const ref of [a, b]) if (!commitOf(root, ref)) throw new UserError(`not a commit: ${ref}`);
  const plan = planFile ? loadPlan(planFile) : undefined;
  const notes = plan ? readNotes(plan) : [];
  const requirements = plan
    ? [
        `Plan: ${plan.file}`,
        '### Global Constraints',
        plan.constraints || '(none stated in the plan)',
        '### Tasks',
        plan.tasks.map((t) => `- Task ${t.step}: ${t.title}`).join('\n'),
      ].join('\n\n')
    : '(none given; judge the change on its own terms)';
  return {
    kind: 'range',
    of: `${a}..${b}`,
    dir: root,
    group: plan ? planName(plan.file) : undefined,
    package: [
      `# Review package · ${a}..${b}\n`,
      section('WHAT WAS IMPLEMENTED', plan ? `${plan.title}\n\n${plan.header}` : 'The commits below.'),
      section('REQUIREMENTS', requirements),
      ...(notes.length ? [section('NOTES FROM EXECUTION', notes.map((n) => `- ${n.text}`).join('\n'))] : []),
      rangeDiff(root, a, b),
    ].join('\n'),
  };
}

/**
 * The reviewer when none is named: for a run, the first of the standard tier, the
 * capable tier, the fallbacks and the default worker whose backend differs from
 * the implementer's; for a range, the capable tier. Undefined = the default worker.
 */
export function pickReviewer(job: ReviewJob): string | undefined {
  const eff = effective();
  const tiers = eff.tiers.value;
  if (job.kind === 'range') return tiers.capable;
  const implementer = job.implementer;
  if (!implementer) return undefined;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const candidates = [tiers.standard, tiers.capable, ...eff.fallback.value, eff.worker.value].filter((s): s is string => !!s);
  return candidates.find((c) => parseTarget(c, def).backend !== implementer.backend);
}

/** Writes the package where the reviewer can read it: <git dir of its workspace>/pitroom/. */
export function writePackage(job: ReviewJob): string {
  const g = gitDir(job.dir);
  if (!g) throw new UserError(`not a git repository: ${job.dir}`);
  const file = path.join(g, 'pitroom', `review-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, job.package);
  return file;
}
