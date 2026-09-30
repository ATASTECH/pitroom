// The worker chain for a run: the preferred worker, then the fallbacks.
// The preferred worker is -W, else the config's tier named by --tier (config
// `tiers`, e.g. {"cheap": "opencode", "capable": "claude"}), else the config's
// `worker`. A target without a model gets the per-worker default from the
// config's `models` map (e.g. {"codex": "gpt-5.6-sol"}), else the worker CLI's
// own default. Shared by `run` (and so `review`) and `doctor`.
import { DEFAULT_BACKEND, getBackend } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { effective } from './config.js';
import { parseTarget } from './target.js';

export interface Chain {
  worker: Target;
  fallback: Target[];
  warnings: string[];
}

export function resolveChain(flags: { worker?: string; model?: string; tier?: string; noFallback?: boolean } = {}): Chain {
  const warnings: string[] = [];
  let spec = flags.worker;
  if (!spec && flags.tier) {
    // A plain index reads inherited members (constructor, toString): only own properties name a tier.
    const tiers = effective().tiers.value;
    spec = Object.hasOwn(tiers, flags.tier) ? tiers[flags.tier] : undefined;
    if (!spec) warnings.push(`tier "${flags.tier}" is not configured (config "tiers"); using the default worker`);
  }
  const eff = effective({ worker: spec, model: flags.model });
  const models = eff.models.value;
  const withDefault = (t: Target): Target => (t.model || !models[t.backend] ? t : { ...t, model: models[t.backend] });

  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);

  const fallback: Target[] = [];
  if (!flags.noFallback) {
    for (const s of eff.fallback.value) {
      const t = withDefault(parseTarget(s, worker.backend));
      try {
        getBackend(t.backend);
        fallback.push(t);
      } catch (e) {
        warnings.push(`fallback ${s} skipped: ${(e as Error).message}`);
      }
    }
  }
  return { worker, fallback, warnings };
}
