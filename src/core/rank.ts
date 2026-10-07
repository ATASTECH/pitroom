// The chain in the order the workers' records suggest (config `rankWorkers`): a worker that ended its recent runs well,
// and whose audited answers held up, goes before one that did not. Only workers with a record move (5 runs or more in
// the last 30 days, rate limits left out: they say nothing about the work), among the places such workers hold;
// the others stay where the config put them. Scores are compared in steps of 10%, so noise does not reorder the chain.
import type { Target } from '../backends/types.js';
import type { WorkerRecord } from './history.js';
import { describeTarget } from './target.js';

export const MIN_RUNS = 5;
export const MIN_AUDITS = 3;

/** A worker's score from 0 to 1: its share of runs that ended well, times its share of confirmed audits (with 3 or more). */
export function scoreOf(r: WorkerRecord | undefined): number | undefined {
  if (!r || r.runs < MIN_RUNS) return undefined;
  const ok = Math.min(r.ok, r.runs) / r.runs;
  return r.audited >= MIN_AUDITS ? ok * (r.agreed / r.audited) : ok;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The chain reordered by record, and a note when the first worker changed. */
export function rankChain(chain: Target[], recordOf: (t: Target) => WorkerRecord | undefined): { chain: Target[]; note?: string } {
  const scored = chain.map((t, i) => ({ t, i, score: scoreOf(recordOf(t)) }));
  const slots = scored.filter((s) => s.score !== undefined);
  if (slots.length < 2) return { chain };
  const ranked = [...slots].sort((a, b) => Math.round(b.score! * 10) - Math.round(a.score! * 10) || a.i - b.i);
  const out = [...chain];
  slots.forEach((slot, k) => (out[slot.i] = ranked[k]!.t));
  if (out[0] === chain[0]) return { chain: out };
  const by = (t: Target) => scored.find((s) => s.t === t)!.score!;
  return {
    chain: out,
    note: `ranked by record ("rankWorkers"): ${describeTarget(out[0]!)} (${pct(by(out[0]!))}) goes before ${describeTarget(chain[0]!)} (${pct(by(chain[0]!))})`,
  };
}
