// Programmatic surface: adapter registry, target parsing, reference checks. Built to
// dist/lib.mjs; the adapter contract tests run against it.
export { allBackends, backendIds, DEFAULT_BACKEND, getBackend } from './backends/index.js';
export type * from './backends/types.js';
export { describeTarget, formatTarget, parseTarget } from './core/target.js';
export { extractRefs, verifyRefs } from './core/refs.js';
