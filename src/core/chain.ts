// The worker chain for a run: the preferred worker, then the fallbacks.
// A target without a model gets the per-worker default from the config's
// `models` map (e.g. {"codex": "gpt-5.6-sol", "claude": "claude-sonnet-5-5"}),
// else the worker CLI's own default. Shared by `run` and `doctor`.
import { DEFAULT_BACKEND, getBackend } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { effective } from './config.js';
import { parseTarget } from './target.js';

export interface Chain {
  worker: Target;
  fallback: Target[];
  warnings: string[];
}

export function resolveChain(flags: { worker?: string; model?: string; noFallback?: boolean } = {}): Chain {
  const eff = effective({ worker: flags.worker, model: flags.model });
  const models = eff.models.value;
  const withDefault = (t: Target): Target => (t.model || !models[t.backend] ? t : { ...t, model: models[t.backend] });

  let worker = parseTarget(eff.worker.value, DEFAULT_BACKEND);
  if (eff.model.value) worker = { ...worker, model: eff.model.value };
  worker = withDefault(worker);

  const fallback: Target[] = [];
  const warnings: string[] = [];
  if (!flags.noFallback) {
    for (const spec of eff.fallback.value) {
      const t = withDefault(parseTarget(spec, worker.backend));
      try {
        getBackend(t.backend);
        fallback.push(t);
      } catch (e) {
        warnings.push(`fallback ${spec} skipped: ${(e as Error).message}`);
      }
    }
  }
  return { worker, fallback, warnings };
}
