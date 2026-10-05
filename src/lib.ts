// Programmatic surface: adapter registry, target parsing, reference checks, and the safety-relevant
// helpers (git guard, slots and locks, secret detection, receipts) the tests call directly. Built to
// dist/lib.mjs; the adapter contract tests run against it.
export { allBackends, backendIds, DEFAULT_BACKEND, getBackend } from './backends/index.js';
export type * from './backends/types.js';
export { describeTarget, formatTarget, parseTarget } from './core/target.js';
export { extractRefs, verifyRefs } from './core/refs.js';
export { fill, loadTemplate } from './core/templates.js';
export { cooldownMs, retryAfterMs } from './core/cooldown.js';
export { parseAudit, parseStatus, parseVerdict } from './core/answers.js';
export { brief, loadPlan, parsePlan, planName, planTask } from './core/plan.js';
export { guardEnv, shimDir } from './vcs/guard.js';
export { acquireWriteLock, releaseSlot, releaseWriteLock, slotHolders, tryAcquireSlot } from './core/slots.js';
export { findSecretFiles, findSecretFilesInTree, looksSecret, secretWarning } from './core/secrets.js';
export { badgeUrl, card, compact, estimateTokens, primaryPrice, readLedger, savedUsd, totals, usd } from './core/receipt.js';
