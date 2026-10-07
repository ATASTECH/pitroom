// Audits: a finished read run's answer is re-checked by another worker, in the background.
//
// Pitroom already checks every cited `path:line` on disk. That says a line exists, not that the claim made about
// it is true. An audit asks a second, cheap worker to verify the answer's key claims against the project and to
// say AGREE, PARTIAL or DISAGREE. It runs for a chosen share of read runs (config `audit`, env PITROOM_AUDIT,
// --audit / --no-audit per run), never for reviews or other audits, and never on the same worker and model that
// gave the answer: a model grading itself proves little. The result is kept on the run, shown in the dashboard and
// counted per worker in the stats, so a worker that keeps being disputed shows up.
import crypto from 'node:crypto';
import path from 'node:path';
import { DEFAULT_BACKEND } from '../backends/index.js';
import { effective } from './config.js';
import { type RunMeta } from './store.js';
import { parseTarget, sameTarget } from './target.js';

const ANSWER_MAX = 8000;

/** The chance this run is audited: its own setting, else the config's. */
export function auditRate(meta: Pick<RunMeta, 'auditRate'>): number {
  return meta.auditRate ?? effective().audit.value;
}

/** A stable number in [0, 1) for a run id, so the same run is always in or out of the sample. */
export function draw(id: string): number {
  return crypto.createHash('sha256').update(id).digest().readUInt32BE(0) / 0x1_0000_0000;
}

/** Which finished runs can be audited at all: a read run that gave an answer, and is not itself a review or an audit. */
export function auditable(meta: RunMeta, answer: string): boolean {
  return meta.mode === 'read' && meta.state === 'done' && !meta.reviewOf && !meta.auditOf && !meta.audit && !!answer.trim();
}

/** Whether the sample takes this run. A rate of 1 always takes it, 0 never. */
export function sampled(meta: RunMeta, rate = auditRate(meta)): boolean {
  return rate > 0 && (rate >= 1 || draw(meta.id) < rate);
}

/** A question that asks for all of something, a list or a count: where audits found most answers short. */
export const ASKS_FOR_LIST = /\b(all|every|each|list|lists|enumerate|how many|count|which)\b/i;

/**
 * The audit focus (config `auditFocus`): the sample leans to where audits find the most. The config's rate is
 * doubled for a question that asks for a list or a count, doubled again for a worker whose audited answers were
 * confirmed less than half the time (at least 3 audits), and halved for one whose last 5 or more were all confirmed.
 * A run's own --audit / --no-audit is never changed. `why` says what moved it.
 */
export function focusedRate(base: number, task: string, record?: { audited: number; agreed: number }): { rate: number; why: string[] } {
  if (base <= 0 || base >= 1) return { rate: base, why: [] };
  let rate = base;
  const why: string[] = [];
  if (ASKS_FOR_LIST.test(task)) {
    rate *= 2;
    why.push('asks for a list or a count');
  }
  if (record && record.audited >= 3 && record.agreed / record.audited < 0.5) {
    rate *= 2;
    why.push(`the worker's audited answers were confirmed ${record.agreed} of ${record.audited} times`);
  } else if (record && record.audited >= 5 && record.agreed === record.audited) {
    rate /= 2;
    why.push(`the worker's ${record.audited} audited answers were all confirmed`);
  }
  return { rate: Math.min(rate, 1), why };
}

/**
 * The worker for an audit: the `audit` tier, else the `cheap` tier, else the fallbacks and the default worker, taking
 * the first that is not the target that gave the answer. Undefined when there is none (one worker only).
 */
export function pickAuditor(meta: RunMeta): string | undefined {
  const eff = effective();
  const tiers = eff.tiers.value;
  const def = parseTarget(eff.worker.value, DEFAULT_BACKEND).backend;
  const ran = meta.ran ?? meta.worker;
  const candidates = [tiers.audit, tiers.cheap, ...eff.fallback.value, eff.worker.value].filter((s): s is string => !!s);
  return candidates.find((c) => !sameTarget(parseTarget(c, def), ran));
}

/**
 * The answer was written for the user, with the worker's snapshot paths turned back into the project's. The
 * auditor reads in a snapshot of its own (or in place), where the project's absolute path may not exist: given
 * `/Users/me/proj/src/a.ts:3` it said the file was not there. So the project's paths become relative to the
 * directory the auditor works in (the audited run's `dir`), which holds for a snapshot and for the project.
 */
export function relativeToAuditor(answer: string, meta: Pick<RunMeta, 'dir' | 'repoRoot'>): string {
  let out = answer;
  const roots = [...new Set([meta.dir, meta.repoRoot].filter((r): r is string => !!r))].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const rel = path.relative(meta.dir, root); // '' for the directory itself, '..' or '../..' for a parent of it
    const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
    // the bare root only where it is the whole path (not the start of `/a/proj-other`)
    out = out.split(`${root}${path.sep}`).join(prefix).replace(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), rel || '.');
  }
  return out;
}

/** What the auditor is asked: check the claims yourself, read only, answer in a fixed form. */
export function auditTask(meta: RunMeta, answer: string): string {
  const text = relativeToAuditor(answer, meta).trim();
  const shown = text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}\n… (cut: ${text.length - ANSWER_MAX} more characters)` : text;
  return [
    "You are auditing another worker's answer to a read-only question about this project. Do not take the answer on trust:",
    "check its key claims yourself against the files here (open the cited files and lines, search for what it says exists or is missing).",
    'Paths in the answer are relative to your working directory.',
    'Check the answer against the QUESTION, not only its own claims: every condition the question sets (a directory or scope,',
    'what to leave out, "all", "only", "exactly", a count) must hold. Valid references do not make an answer right:',
    'for a list, look for items that are missing and items that do not belong; for a count, count again yourself.',
    'Do not edit anything and do not run anything that changes files.',
    '',
    'QUESTION:',
    meta.task.trim(),
    '',
    'ANSWER TO AUDIT:',
    shown,
    '',
    'Reply in exactly this form and nothing else:',
    'AUDIT: AGREE | PARTIAL | DISAGREE',
    'CHECKED: <how many key claims you checked>',
    'DISPUTED:',
    '- <the claim> — <what is actually true, with path:line>',
    '',
    "AGREE: every key claim you checked holds and the answer meets every condition of the question (no extra or missing items, the right count). PARTIAL: some are wrong, unverified, or the answer goes beyond or falls short of the question's scope. DISAGREE: the main conclusion is wrong.",
    'Under DISPUTED list only claims you checked and found wrong or unsupported; write "- (none)" when there are none.',
  ].join('\n');
}

/**
 * Whether a settled audit should send the answer back to its worker (config `auditFix`): the audit disputed claims,
 * the worker can continue its session, and the answer is not itself a correction (one round, never a loop).
 */
export function wantsFix(target: RunMeta, resumable: boolean): boolean {
  const a = target.audit;
  return (
    effective().auditFix.value &&
    resumable &&
    !!target.sessionId &&
    !target.fixOf &&
    !a?.fix &&
    a?.state === 'done' &&
    (a.verdict === 'partial' || a.verdict === 'disagree') &&
    !!a.disputed?.length
  );
}

/** The follow-up a disputed answer's worker gets: the disputed claims, to check and correct. */
export function fixTask(disputed: string[]): string {
  return [
    'Another worker audited your answer above and disputed these claims:',
    ...disputed.map((d) => `- ${d}`),
    '',
    'Check each one yourself against the files (the auditor can be wrong too). Then give your whole answer again,',
    'corrected, in the same answer format: keep what holds, fix what does not, and add what was missing.',
    'Under OPEN ISSUES, say which disputed claims you accepted and which you kept, and why.',
  ].join('\n');
}

/** The lines a report shows for an audit, on the audited run (its audit's progress or verdict) and on the audit itself. */
export function auditLines(meta: RunMeta): string[] {
  const fixing = meta.fixOf ? [`── correction: the answer of ${meta.fixOf}, checked again against what its audit disputed`] : [];
  if (meta.auditOf) {
    return meta.state === 'done' ? [`── audit of ${meta.auditOf}: ${(meta.auditVerdict ?? 'unclear').toUpperCase()}${meta.auditDisputed?.length ? ` · ${meta.auditDisputed.length} disputed` : ''}`] : [];
  }
  const a = meta.audit;
  if (!a) return fixing;
  if (a.state === 'done') {
    const head = `── audit (run ${a.id}): ${(a.verdict ?? 'unclear').toUpperCase()}${a.verdict === 'agree' ? '' : a.verdict === 'unclear' ? ' (the auditor did not answer in the expected form)' : ''}`;
    const fix = a.fix ? [`── fix: the worker is correcting its answer as a follow-up (pitroom show ${a.fix})`] : [];
    return [...fixing, head, ...(a.disputed ?? []).map((d) => `   disputed: ${d}`), ...fix];
  }
  if (a.state === 'running' || a.state === 'queued') return [...fixing, `── audit: another worker is re-checking this answer in the background (pitroom show ${a.id})`];
  return [...fixing, `── audit (run ${a.id}) ${a.state}: no verdict`];
}

/** The audited run's pill: the verdict in capitals, PENDING while the audit runs, FAILED when it ended without one. */
export function auditBadge(meta: Pick<RunMeta, 'audit'>): string | undefined {
  const a = meta.audit;
  if (!a) return undefined;
  if (a.state === 'done') return (a.verdict ?? 'unclear').toUpperCase();
  return a.state === 'running' || a.state === 'queued' ? 'PENDING' : 'FAILED';
}
