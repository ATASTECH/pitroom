// The text the primary agent reads. Everything here costs the primary tokens,
// so it is compact and ends with exact next commands.
import { auditLines } from './audit.js';
import { archivedRun } from './history.js';
import fs from 'node:fs';
import { planName } from './plan.js';
import { getBackend } from '../backends/index.js';
import { compact, primaryPrice, usd } from './receipt.js';
import { type RunMeta, isActive, runFile } from './store.js';
import { bold, dim, stateColour } from './style.js';

const ICON: Record<RunMeta['state'], string> = {
  queued: '⋯',
  running: '…',
  done: '✔',
  failed: '✘',
  timeout: '⏱',
  stopped: '■',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function duration(meta: RunMeta): string {
  const end = meta.endedAt ? Date.parse(meta.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(meta.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function readSummary(meta: RunMeta): string {
  const f = runFile(meta.id, 'summary.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : (archivedRun(meta.id)?.answer ?? '');
}

export function formatReport(meta: RunMeta, finalText = readSummary(meta), maxLines = 400): string {
  const out: string[] = [];
  // a finished run whose --verify failed is not "✔ done": the check the user asked for did not pass
  const verifyFailed = meta.state === 'done' && meta.verifyResult && !meta.verifyResult.ok;
  const head = verifyFailed ? stateColour('failed', '⚠ done · verify failed') : stateColour(meta.state, `${ICON[meta.state]} ${meta.state}`);
  out.push(`${bold('pitroom')} ${head} · ${meta.mode} · ${duration(meta)} · run ${dim(meta.id)}`);
  const ran = meta.ran ?? meta.worker;
  const ids = [`worker ${ran.backend}`, meta.resolvedModel && `model ${meta.resolvedModel}`, meta.sessionId && `session ${meta.sessionId}`];
  out.push(ids.filter(Boolean).join(' · '));
  if (meta.reviewOf) {
    const v = meta.verdict;
    const verdict = v
      ? ` · SPEC ${v.spec.toUpperCase()} · QUALITY ${v.quality.toUpperCase()} · critical ${v.critical} · important ${v.important} · minor ${v.minor}`
      : '';
    out.push(`review of ${meta.reviewOf} (${meta.reviewKind})${verdict}`);
  } else if (meta.plan) {
    const status = meta.taskStatus ? ` · STATUS ${meta.taskStatus}` : '';
    out.push(`plan: ${planName(meta.plan.file)} · Task ${meta.plan.step}: ${meta.plan.title}${status}`);
  }
  for (const a of meta.attempts ?? []) out.push(a.skipped ? `skipped: ${a.target} (${a.error.slice(0, 160)})` : `fallback: ${a.target} failed (${a.error.slice(0, 160)})`);
  if (meta.error) out.push(`error: ${meta.error}`);
  for (const w of meta.warnings) out.push(`warning: ${w}`);
  if (meta.state === 'timeout') {
    const limit = meta.timeoutSec >= 60 ? `${Math.round(meta.timeoutSec / 60)}m` : `${meta.timeoutSec}s`;
    out.push(
      `hint: the worker hit its time limit (${limit}). What it did is kept. Most runs finish in minutes, so first check it was not going in circles; for a genuinely long job raise the limit with -t 1h (or PITROOM_TIMEOUT, or "timeout" in the config)${meta.sessionId ? `, or carry on: pitroom run --continue ${meta.id} "…"` : ''}`,
    );
  }

  if (finalText) {
    const lines = finalText.split('\n');
    out.push('', ...lines.slice(0, maxLines));
    if (lines.length > maxLines) out.push(`… (${lines.length - maxLines} more lines: pitroom show ${meta.id} --full)`);
  }
  out.push('');

  out.push(...auditLines(meta));

  if (meta.refs) {
    const r = meta.refs;
    const bad = r.invalid.slice(0, 8).map((i) => `${i.ref} (${i.reason})`).join(', ');
    out.push(`── refs: ${r.valid}/${r.total} verified${bad ? ` · bad: ${bad}` : ''}${r.invalid.length > 8 ? ' …' : ''}`);
  }

  const u = meta.usage;
  if (u && u.steps) {
    const ratio = meta.returnedTokens ? `, ${Math.max(1, Math.round(u.total / meta.returnedTokens))}× compression` : '';
    out.push(
      `── receipt: worker processed ${compact(u.total)} tokens in ${plural(u.steps, 'step')} (${plural(u.toolCalls, 'tool call')}${u.denied ? `, ${u.denied} blocked` : ''})` +
        ` · worker cost ${u.cost !== undefined ? usd(u.cost) : u.costEstimate !== undefined ? `~${usd(u.costEstimate)} (estimated from your workerPrices)` : 'n/a'} · returned ~${compact(meta.returnedTokens ?? 0)} tokens${ratio}` +
        (meta.savedUsd !== undefined ? ` · est. saved ${usd(meta.savedUsd)} vs ${primaryPrice().name}` : ''),
    );
  }

  if (meta.changes) {
    const s = meta.stats!;
    const where = meta.mode === 'isolate' ? 'in the isolated copy, NOT applied yet' : 'in your working tree';
    const flag = meta.applied ? ' [applied]' : meta.reverted ? ' [reverted]' : meta.discarded ? ' [discarded]' : '';
    out.push(
      meta.changes.length
        ? `── changes (${where})${flag}: ${s.files} files, +${s.insertions} −${s.deletions}`
        : `── changes: none`,
    );
    for (const c of meta.changes.slice(0, 50)) out.push(`   ${c.status} ${c.path}`);
    if (meta.changes.length > 50) out.push(`   … ${meta.changes.length - 50} more`);
    const deleted = meta.changes.filter((c) => c.status === 'D').length;
    if (deleted && !meta.applied && !meta.reverted && !meta.discarded) {
      out.push(
        meta.mode === 'isolate'
          ? `   ⚠ deletes ${deleted} file${deleted === 1 ? '' : 's'}: check they are wanted before applying (apply refuses without --allow-delete)`
          : `   ⚠ deleted ${deleted} file${deleted === 1 ? '' : 's'} in your tree: check they are wanted (undo: pitroom revert ${meta.id})`,
      );
    }
    if (meta.changes.length) {
      out.push(`   diff:    pitroom show ${meta.id} --patch`);
      out.push(`   review:  pitroom review ${meta.id}`);
      if (meta.mode === 'isolate' && !meta.applied && !meta.discarded) {
        out.push(`   apply:   pitroom apply ${meta.id}`, `   discard: pitroom discard ${meta.id}`);
      }
      if (meta.mode === 'write' && !meta.reverted) out.push(`   undo:    pitroom revert ${meta.id}`);
    }
  }

  if (meta.verifyResult) {
    const v = meta.verifyResult;
    const notFound = !v.ok && v.code === 127 && /not found|no such file|is not recognized as an internal or external command/i.test(v.tail);
    out.push(`── verify: \`${meta.verify}\` ${v.ok ? '✔ passed' : notFound ? '✘ could not run (exit 127: command not found)' : `✘ failed (exit ${v.code})`}`);
    if (notFound) out.push('   the command is not on the PATH Pitroom runs with (an app such as an MCP client may start it without your shell\'s PATH): give its full path, or set PATH in the command');
    if (!v.ok && v.tail) out.push(...v.tail.split('\n').map((l) => `   ${l}`));
  }

  if (isActive(meta.state)) {
    out.push(`── still running: pitroom wait ${meta.id}   (stop: pitroom stop ${meta.id})`);
  } else if (meta.sessionId && !meta.applied && !meta.discarded && !meta.reviewOf) {
    out.push(`── follow up: pitroom run --continue ${meta.id} "…"`);
  }
  return out.join('\n');
}

/** One-line live progress for a running worker, read from the event stream so far. */
export interface Live {
  steps: number;
  toolCalls: number;
  last?: string;
}

/** What a worker has done so far, read from its event stream. */
export function live(meta: RunMeta): Live {
  const f = runFile(meta.id, 'events.jsonl');
  if (!fs.existsSync(f)) return { steps: 0, toolCalls: 0 };
  const p = getBackend((meta.ran ?? meta.worker).backend).parse(fs.readFileSync(f, 'utf8'));
  return { steps: p.usage.steps, toolCalls: p.usage.toolCalls, last: p.lastActivity };
}

/** One-line live progress for an active worker. */
export function progress(meta: RunMeta): string {
  if (meta.state === 'queued') return `pitroom ⋯ queued · ${meta.mode} · waiting for a free worker slot · run ${meta.id}`;
  const l = live(meta);
  const last = l.last ? ` · last: ${l.last}` : '';
  return `pitroom … running · ${meta.mode} · ${duration(meta)} · ${l.steps} steps, ${l.toolCalls} tool calls${last} · run ${meta.id}`;
}
