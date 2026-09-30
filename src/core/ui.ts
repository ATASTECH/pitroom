// What the user sees of Pitroom inside their agent's UI, whether or not the agent
// mentions it: a status line (running workers, savings this week) and a card after
// each `pitroom` command the agent runs (started, finished, applied). Both are read
// from the run records and the ledger; neither ever fails the host.
import fs from 'node:fs';
import { readLedger, totals, usd } from './receipt.js';
import { type RunMeta, isActive, isAlive, listRunIds, readMeta, runFile, runsDir } from './store.js';
import { describeTarget } from './target.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;
/** How many recent runs the status line looks at for active ones. */
const RECENT = 40;

function activeRuns(): RunMeta[] {
  const out: RunMeta[] = [];
  for (const id of listRunIds().slice(-RECENT)) {
    try {
      const m = readMeta(id);
      // A crashed worker leaves "running" behind; only a live process counts.
      if (isActive(m.state) && (m.state === 'queued' || isAlive(m.pid))) out.push(m);
    } catch {
      // a record being written right now
    }
  }
  return out;
}

/** One line for the host's status bar, or "" when there is nothing to say. */
export function statusLine(): string {
  const running = activeRuns();
  const saved = totals(readLedger(Date.now() - WEEK_MS)).saved;
  if (!running.length && !saved) return '';
  const parts = ['🏁 pitroom'];
  if (running.length) {
    const who = [...new Set(running.map((m) => (m.ran ?? m.worker).backend))].join(', ');
    parts.push(`${running.length} running (${who})`);
  }
  if (saved) parts.push(`~${usd(saved)} saved this week`);
  return parts.join(' · ');
}

const RUN_ID = /\b\d{8}-\d{6}-[0-9a-f]{4}\b/g;
/** A shell command that runs the pitroom CLI (not just mentions it in a path or a string). */
const PITROOM_CALL = /(^|[\s;&|(`])(\S*\/)?pitroom(\.mjs)?(\s|$)/;
const ICON: Record<string, string> = { done: '✔', failed: '✘', timeout: '⏱', stopped: '■' };

function kind(m: RunMeta): string {
  if (m.reviewOf) return m.reviewKind === 'range' ? 'branch review' : m.reviewKind === 'fix' ? 're-review' : 'review';
  return m.mode === 'read' ? 'research' : m.mode === 'isolate' ? 'change (isolated copy)' : 'change';
}

const SUBJECT_MAX = 48;

/** A card-sized subject: no backticks or markdown heading marks, cut at a word boundary. */
function short(text: string): string {
  const s = text.replace(/`/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, '')}…`;
}

function what(m: RunMeta): string {
  if (m.plan) return short(`Task ${m.plan.step}: ${m.plan.title}`);
  if (m.reviewOf) return `of ${m.reviewOf}`;
  const line = m.task.split('\n').find((l) => l.trim()) ?? '';
  // A hand-written plan brief opens with this boilerplate; the task and the plan are what count.
  const brief = /^You are implementing Task (\d+)\b.*?\bplan\s+(\S+)/i.exec(line);
  if (brief) return short(`Task ${brief[1]} · ${brief[2]!.split('/').pop()!.replace(/\.md\W*$/, '')}`);
  return short(line);
}

function duration(m: RunMeta): string {
  const s = Math.round((Date.parse(m.endedAt ?? '') - Date.parse(m.startedAt)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** The cards this run has not shown yet, in order; each phase is shown once. */
function cardsFor(m: RunMeta): string[] {
  const phases: [string, () => string][] = [
    ['started', () => `🏁 Pitroom ▶ ${kind(m)} on ${describeTarget(m.worker)} · ${what(m)}  (${m.id})`],
  ];
  if (!isActive(m.state)) {
    phases.push([
      'ended',
      () => {
        const v = m.verdict;
        const bits = [
          `🏁 Pitroom ${ICON[m.state] ?? '•'} ${kind(m)} ${m.state} on ${describeTarget(m.ran ?? m.worker)}`,
          what(m),
          duration(m),
          v && `SPEC ${v.spec.toUpperCase()} · QUALITY ${v.quality.toUpperCase()}`,
          m.changes?.length ? `${m.changes.length} file${m.changes.length === 1 ? '' : 's'} changed` : '',
          m.savedUsd ? `~${usd(m.savedUsd)} saved` : '',
        ];
        return `${bits.filter(Boolean).join(' · ')}  (${m.id})`;
      },
    ]);
  }
  if (m.applied) {
    phases.push(['applied', () => `🏁 Pitroom ⤵ applied ${m.changes?.length ?? 0} file(s) from ${m.id} to your tree`]);
  }
  const out: string[] = [];
  for (const [phase, text] of phases) {
    const marker = runFile(m.id, `card-${phase}`);
    if (fs.existsSync(marker)) continue;
    // A run first seen already finished gets its result card only, not "started" as well.
    if (!(phase === 'started' && !isActive(m.state))) out.push(text());
    fs.writeFileSync(marker, '');
  }
  return out;
}

/**
 * For a PostToolUse hook: given the hook's JSON input, the cards for the runs a Bash
 * `pitroom` command started, finished or applied, or "" when it was not such a command.
 */
export function hookCards(input: string): string {
  const event = JSON.parse(input) as { tool_name?: string; tool_input?: { command?: string }; tool_response?: unknown };
  const command = event.tool_input?.command ?? '';
  if (event.tool_name !== 'Bash' || !PITROOM_CALL.test(command)) return '';
  const response = event.tool_response;
  const output =
    typeof response === 'string'
      ? response
      : [(response as { stdout?: string })?.stdout, (response as { stderr?: string })?.stderr].filter(Boolean).join('\n');
  const ids = [...new Set(`${command}\n${output}`.match(RUN_ID) ?? [])].filter((id) => fs.existsSync(`${runsDir()}/${id}`));
  const cards: string[] = [];
  for (const id of ids) {
    try {
      cards.push(...cardsFor(readMeta(id)));
    } catch {
      // not a readable run record
    }
  }
  return cards.join('\n');
}
