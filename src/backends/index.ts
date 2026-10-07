// Registry of worker adapters. Adding a worker = implement `Backend` in
// src/backends/<id>/ and register it here (see docs/backends.md).
import { UserError } from '../core/errors.js';
import { claude } from './claude/index.js';
import { codex } from './codex/index.js';
import { gemini } from './gemini/index.js';
import { kiloBackend } from './kilo/index.js';
import { opencode } from './opencode/index.js';
import { qwen } from './qwen/index.js';
import type { Backend } from './types.js';

const REGISTRY = new Map<string, Backend>([opencode, codex, claude, gemini, qwen, kiloBackend].map((b) => [b.id, b]));

export const DEFAULT_BACKEND = opencode.id;

/** Recognised so users get a clear message instead of a confusing model-not-found. */
// Hermes Agent: no read-only mode, file tools not confined to the project, auto-approved shell (docs/backends.md).
const PLANNED: string[] = ['hermes'];

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
