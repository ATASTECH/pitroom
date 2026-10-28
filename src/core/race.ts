// `pitroom run -i --race N`: the same change by N workers side by side, each in an isolated copy of its own. When all
// have ended, the best one wins: it ended well, its check passed, it changed something, its references held, its diff
// is the smallest and it cost the least, in that order. The others' copies are discarded; their patches stay, so
// `pitroom show RUN --patch` (and `pitroom apply RUN`) still work. Nothing reaches your tree until you apply.
import type { Target } from '../backends/types.js';
import { resolveChain } from './chain.js';
import { UserError } from './errors.js';
import { usd } from './receipt.js';
import { type RunOptions, discardRun, prepareRun, startInBackground } from './run.js';
import { type RunMeta, freshMeta, isActive, writeMeta } from './store.js';
import { formatTarget, sameTarget } from './target.js';
import { ranTarget, workerName } from './ui.js';

export const MAX_RACE = 5;

/** The workers of a race: the one you named (-W, -m) every time, else the worker and its fallbacks in turn. */
export function racers(o: RunOptions, size: number): { worker: string; model?: string }[] {
  if (o.worker) return Array.from({ length: size }, () => ({ worker: o.worker!, model: o.model }));
  const chain = resolveChain({ model: o.model, tier: o.tier, effort: o.effort });
  const distinct: Target[] = [];
  for (const t of [chain.worker, ...chain.fallback]) if (!distinct.some((d) => sameTarget(d, t))) distinct.push(t);
  return Array.from({ length: size }, (_, i) => ({ worker: formatTarget(distinct[i % distinct.length]!) }));
}

/** Prepares and starts the racers in the background, as one group. */
export function startRace(o: RunOptions, size: number): RunMeta[] {
  if (o.mode !== 'isolate') throw new UserError('--race runs one change side by side in isolated copies: add -i');
  if (o.continueFrom || o.plan) throw new UserError('--race starts new runs: drop --continue and --plan');
  const group = o.group ?? `race-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
  return racers(o, size).map((r) => startInBackground(prepareRun({ ...o, ...r, tier: undefined, effort: o.worker ? o.effort : undefined, group, race: size })));
}

export interface Placing {
  meta: RunMeta;
  place: number;
  why: string;
}

const verifyScore = (m: RunMeta) => (!m.verifyResult ? 1 : m.verifyResult.ok ? 0 : 2);
const diffSize = (m: RunMeta) => (m.stats ? m.stats.insertions + m.stats.deletions : 0);
const costOf = (m: RunMeta) => m.usage?.cost ?? m.usage?.costEstimate;

/** Lower is better, criterion by criterion. */
function score(m: RunMeta): number[] {
  return [
    m.state === 'done' ? 0 : 1,
    verifyScore(m),
    m.changes?.length ? 0 : 1,
    m.refs?.invalid.length ?? 0,
    diffSize(m),
    costOf(m) ?? Number.MAX_VALUE,
    Date.parse(m.endedAt ?? '') || Number.MAX_VALUE,
  ];
}

function compare(a: RunMeta, b: RunMeta): number {
  const x = score(a);
  const y = score(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Why a racer stands where it does, in a few words. */
function why(m: RunMeta): string {
  if (m.state !== 'done') return `${m.state}${m.error ? `: ${m.error.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
  const parts: string[] = [];
  if (m.verifyResult) parts.push(m.verifyResult.ok ? 'verify passed' : `verify failed (exit ${m.verifyResult.code})`);
  parts.push(m.changes?.length ? `+${m.stats?.insertions ?? 0} −${m.stats?.deletions ?? 0}` : 'no changes');
  if (m.refs?.total) parts.push(`${m.refs.valid}/${m.refs.total} refs`);
  const cost = costOf(m);
  if (cost !== undefined) parts.push(cost === 0 ? 'free' : `${m.usage?.cost === undefined ? '~' : ''}${usd(cost)}`);
  return parts.join(' · ');
}

/**
 * Ranks a finished race and discards the losers' copies, once: a race already settled keeps its places. Undefined
 * while a racer is still going. Nothing is discarded when no racer ended well (there is no winner to keep instead).
 */
export function settleRace(ids: string[]): Placing[] | undefined {
  const metas = ids.map((id) => freshMeta(id));
  if (metas.some((m) => isActive(m.state))) return undefined;
  if (metas.every((m) => m.racePlace)) {
    return metas.sort((a, b) => a.racePlace! - b.racePlace!).map((m) => ({ meta: m, place: m.racePlace!, why: why(m) }));
  }
  const ranked = [...metas].sort(compare);
  const winner = ranked[0]!.state === 'done' && ranked[0]!.changes?.length ? ranked[0] : undefined;
  return ranked.map((m, i) => {
    m.racePlace = i + 1;
    writeMeta(m);
    if (winner && m !== winner && m.mode === 'isolate' && !m.applied && !m.discarded && m.worktree) {
      try {
        discardRun(m);
      } catch {
        // its copy is already gone
      }
    }
    return { meta: m, place: i + 1, why: why(m) };
  });
}

/** The race in a few lines: the places, why, and what to do with the winner. */
export function formatRace(placings: Placing[]): string {
  const first = placings[0]!.meta;
  const won = first.state === 'done' && !!first.changes?.length;
  const head = `pitroom race "${first.group ?? ''}": ${placings.length} workers, ${won ? `winner ${first.id} (${workerName(ranTarget(first))})` : 'no winner: no worker ended with a change'}`;
  const rows = placings.map(({ meta: m, place, why: w }) => {
    const gone = m.changes?.length ? '  (copy discarded; the patch stays)' : '  (copy discarded)';
    const note = won && place === 1 ? '  ← winner' : m.discarded && !m.applied ? gone : '';
    return `   ${place}. ${m.id}  ${workerName(ranTarget(m))} · ${w}${note}`;
  });
  const next = won
    ? [`   apply:   pitroom apply ${first.id}`, `   diff:    pitroom show ${first.id} --patch   (another racer's: pitroom show RUN --patch)`]
    : [];
  return [head, ...rows, ...next].join('\n');
}
