// A daily budget for the workers (config `budgetDaily`, USD): what they cost today, as their CLIs reported it or as
// estimated from your prices (`workerPrices`, the price catalog), audits and corrections included. Once it is spent,
// only workers that cost nothing still run; a run that has none in its chain is refused, and an audit or a correction
// does not start. A run that is still going counts with what it has used so far (its stream is read again), so a long
// run is counted while it runs; runs started together count from their first finished step, so a crew can still end a
// day a little over.
import fs from 'node:fs';
import { getBackend } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { effective } from './config.js';
import { UserError } from './errors.js';
import { recentCosts, spentSince } from './history.js';
import { costAt, usd, workerPrice } from './receipt.js';
import { freshMeta, isActive, listRunIds, runFile } from './store.js';
import { describeTarget } from './target.js';

/** Local midnight today. */
export const startOfDay = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

/** What the runs still going cost so far (USD): reported, else estimated from a price; one without either counts 0. */
export function activeSpend(sinceMs: number): number {
  let total = 0;
  for (const id of listRunIds()) {
    try {
      const m = freshMeta(id);
      if (!isActive(m.state) || Date.parse(m.startedAt) < sinceMs) continue;
      const target = m.ran ?? m.worker;
      const events = runFile(id, 'events.jsonl');
      if (!fs.existsSync(events)) continue;
      const run = getBackend(target.backend).parse(fs.readFileSync(events, 'utf8'));
      if (run.usage.cost !== undefined) total += run.usage.cost;
      else {
        const price = workerPrice(target.backend, run.model, target.model);
        if (price) total += costAt(run.usage, price);
      }
    } catch {
      // a record being written, or a worker that is gone
    }
  }
  return total;
}

/**
 * A worker that costs nothing: a price of 0 (yours or the catalog's), else its last runs all cost exactly 0 (a free
 * model whose CLI reports its cost). A worker with no known cost is not free: it might not be.
 */
export function isFree(t: Target): boolean {
  let model = t.model;
  try {
    model ??= getBackend(t.backend).defaultModel?.();
  } catch {
    // no default model known
  }
  const price = workerPrice(t.backend, model);
  if (price) return price.input === 0 && price.output === 0 && price.cachedInput === 0;
  const costs = recentCosts(t.backend, model);
  return costs.length > 0 && costs.every((c) => c === 0);
}

/**
 * The chain a run may use under the budget, and what to say about it. Throws when the budget is spent and no worker
 * of the chain is free.
 */
export function withinBudget(chain: Target[], now = new Date()): { chain: Target[]; warning?: string } {
  const budget = effective().budgetDaily.value;
  if (budget === undefined) return { chain };
  const finished = spentSince(startOfDay(now));
  if (finished === undefined) return { chain };
  const spent = finished + activeSpend(startOfDay(now));
  if (spent < budget) {
    return { chain, warning: spent >= 0.8 * budget ? `the workers cost ${usd(spent)} today, of your ${usd(budget)} daily budget ("budgetDaily")` : undefined };
  }
  const free = chain.filter(isFree);
  if (!free.length) {
    throw new UserError(
      `the workers cost ${usd(spent)} today, which reaches your daily budget of ${usd(budget)} ("budgetDaily"): only workers that cost nothing run now, and ${chain.map(describeTarget).join(', ')} ${chain.length === 1 ? 'is' : 'are'} not known to be free. Raise the budget, name a free worker (-W), or wait until tomorrow.`,
      3,
    );
  }
  const left = chain.length - free.length;
  return { chain: free, warning: `the daily budget (${usd(budget)}) is spent (${usd(spent)} today): only the free workers run${left ? `, ${left} paid one${left === 1 ? '' : 's'} left out` : ''}` };
}
