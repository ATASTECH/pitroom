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

export function resolveChain(flags: { worker?: string; model?: string; tier?: string; effort?: string; noFallback?: boolean } = {}): Chain {
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
  // A target that names no model gets the worker's configured one. "#low" names only a reasoning
  // effort (Codex), so it keeps its effort and still gets the configured model: before, it counted
  // as a model and the vendor's own default (maybe a pricier one) ran instead.
  const withDefault = (t: Target): Target => {
    const pinned = models[t.backend];
    if (!pinned) return t;
    if (!t.model) return { ...t, model: pinned };
    return t.model.startsWith('#') ? { ...t, model: `${pinned}${t.model}` } : t;
  };

  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);
  if (flags.effort) {
    // "model#level": Codex and Claude Code read the level themselves, OpenCode takes it as a variant.
    const base = (worker.model ?? '').split('#')[0]!;
    if (worker.backend === 'opencode' && !base) {
      warnings.push('--effort needs a model for OpenCode (provider/model#variant): set one in the config or pass -m; ignored');
    } else {
      worker = { ...worker, model: `${base}#${flags.effort}` };
    }
  }

  // Codex and Claude Code run their own default model when none is pinned; it can change and cost more.
  if ((worker.backend === 'codex' || worker.backend === 'claude') && !(worker.model ?? '').replace(/#.*$/, '')) {
    warnings.push(
      `${worker.backend} has no pinned model, so it runs its own default (which can change and cost more): set "models": {"${worker.backend}": "<model>"} in the pitroom config, or pass -W ${worker.backend}:<model>`,
    );
  }

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
