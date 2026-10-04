// Audits: a finished read run's answer is re-checked by another worker, in the background.
//
// Pitroom already checks every cited `path:line` on disk. That says a line exists, not that the claim made about
// it is true. An audit asks a second, cheap worker to verify the answer's key claims against the project and to
// say AGREE, PARTIAL or DISAGREE. It runs for a chosen share of read runs (config `audit`, env PITROOM_AUDIT,
// --audit / --no-audit per run), never for reviews or other audits, and never on the same worker and model that
// gave the answer: a model grading itself proves little. The result is kept on the run, shown in the dashboard and
// counted per worker in the stats, so a worker that keeps being disputed shows up.
import crypto from 'node:crypto';
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
export function sampled(meta: RunMeta): boolean {
  const rate = auditRate(meta);
  return rate > 0 && (rate >= 1 || draw(meta.id) < rate);
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

/** What the auditor is asked: check the claims yourself, read only, answer in a fixed form. */
export function auditTask(meta: RunMeta, answer: string): string {
  const text = answer.trim();
  const shown = text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}\n… (cut: ${text.length - ANSWER_MAX} more characters)` : text;
  return [
    "You are auditing another worker's answer to a read-only question about this project. Do not take the answer on trust:",
    "check its key claims yourself against the files here (open the cited files and lines, search for what it says exists or is missing).",
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

/** The lines a report shows for an audit, on the audited run (its audit's progress or verdict) and on the audit itself. */
export function auditLines(meta: RunMeta): string[] {
  if (meta.auditOf) {
    return meta.state === 'done' ? [`── audit of ${meta.auditOf}: ${(meta.auditVerdict ?? 'unclear').toUpperCase()}${meta.auditDisputed?.length ? ` · ${meta.auditDisputed.length} disputed` : ''}`] : [];
  }
  const a = meta.audit;
  if (!a) return [];
  if (a.state === 'done') {
    const head = `── audit (run ${a.id}): ${(a.verdict ?? 'unclear').toUpperCase()}${a.verdict === 'agree' ? '' : a.verdict === 'unclear' ? ' (the auditor did not answer in the expected form)' : ''}`;
    return [head, ...(a.disputed ?? []).map((d) => `   disputed: ${d}`)];
  }
  if (a.state === 'running' || a.state === 'queued') return [`── audit: another worker is re-checking this answer in the background (pitroom show ${a.id})`];
  return [`── audit (run ${a.id}) ${a.state}: no verdict`];
}

/** The audited run's pill: the verdict in capitals, PENDING while the audit runs, FAILED when it ended without one. */
export function auditBadge(meta: Pick<RunMeta, 'audit'>): string | undefined {
  const a = meta.audit;
  if (!a) return undefined;
  if (a.state === 'done') return (a.verdict ?? 'unclear').toUpperCase();
  return a.state === 'running' || a.state === 'queued' ? 'PENDING' : 'FAILED';
}
