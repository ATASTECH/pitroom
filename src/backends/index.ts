// Registry of worker adapters. Adding a worker = implement `Backend` in
// src/backends/<id>/ and register it here (see docs/backends.md).
import { UserError } from '../core/errors.js';
import { opencode } from './opencode/index.js';
import type { Backend } from './types.js';

const REGISTRY = new Map<string, Backend>([[opencode.id, opencode]]);

export const DEFAULT_BACKEND = opencode.id;

/** Recognised so users get a clear message instead of a confusing model-not-found. */
const PLANNED = ['codex', 'claude', 'gemini'];

export const backendIds = (): string[] => [...REGISTRY.keys()];
export const allBackends = (): Backend[] => [...REGISTRY.values()];
export const isBackendId = (id: string): boolean => REGISTRY.has(id) || PLANNED.includes(id);

export function getBackend(id: string): Backend {
  const backend = REGISTRY.get(id);
  if (backend) return backend;
  const available = backendIds().join(', ');
  throw new UserError(
    PLANNED.includes(id)
      ? `the "${id}" worker is not supported yet (available: ${available})`
      : `unknown worker "${id}" (available: ${available})`,
    3,
  );
}
