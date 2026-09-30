// Worker targets: "backend[:model]", e.g. "opencode", "opencode:opencode/space-bunny-free",
// later "codex:gpt-5-codex". A bare model ("opencode/space-bunny-free") belongs to the
// default backend. The prefix only counts as a backend when it is a known worker id,
// so models that contain ":" themselves (e.g. "ollama/qwen3:8b") stay intact.
import { isBackendId } from '../backends/index.js';
import type { Target } from '../backends/types.js';
import { UserError } from './errors.js';

export function parseTarget(spec: string, defaultBackend: string): Target {
  const s = spec.trim();
  if (!s) throw new UserError('empty worker target');
  const i = s.indexOf(':');
  if (i > 0 && isBackendId(s.slice(0, i))) {
    const model = s.slice(i + 1).trim();
    return model ? { backend: s.slice(0, i), model } : { backend: s.slice(0, i) };
  }
  if (isBackendId(s)) return { backend: s };
  return { backend: defaultBackend, model: s };
}

export const formatTarget = (t: Target): string => (t.model ? `${t.backend}:${t.model}` : t.backend);

/** Human form for reports: "opencode (default model)" or "opencode:provider/model". */
export const describeTarget = (t: Target): string => (t.model ? formatTarget(t) : `${t.backend} (default model)`);

export const sameTarget = (a: Target, b: Target): boolean => a.backend === b.backend && a.model === b.model;
