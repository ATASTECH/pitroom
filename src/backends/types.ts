// The contract every worker CLI adapter implements (OpenCode today; Codex, Claude
// Code, Gemini CLI). Adapters only translate: build the command line for a
// request and normalise the CLI's output. Everything that must hold for every
// worker — closed stdin, the git guard, timeouts, snapshots, reference checks,
// receipts — lives in the core, so an adapter cannot forget it.

export type Mode = 'read' | 'write' | 'isolate';

/** A worker to run: an adapter id plus an optional model (undefined = the CLI's own default). */
export interface Target {
  backend: string;
  model?: string;
}

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** USD as reported by the CLI; undefined when the CLI does not report cost. */
  cost?: number;
  steps: number;
  toolCalls: number;
  /** Tool calls the permission layer refused. */
  denied: number;
}

export interface WorkerRequest {
  mode: Mode;
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  files: string[];
  web: boolean;
  title: string;
}

/** How to start the worker. The core adds its own env (git guard, recursion guard) and closes stdin. */
export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One thing a worker did, in order: it said something, ran a command, edited a file or used a tool. */
export interface Step {
  kind: 'say' | 'shell' | 'edit' | 'tool';
  /** The tool's name, when it is one. */
  name?: string;
  text: string;
  /** Whether the tool call worked; unknown while it is still running. */
  ok?: boolean;
  /** Epoch milliseconds, for the CLIs whose stream has timestamps. */
  at?: number;
}

/** Steps are kept in order up to this many; the rest of a very long run is dropped. */
export const MAX_STEPS = 400;

/** A worker run, normalised from the CLI's event stream. */
export interface ParsedRun {
  sessionId?: string;
  /** The model, when the CLI's own output says which one it used. */
  model?: string;
  /** The worker's final answer only (earlier narration dropped). */
  finalText: string;
  usage: Usage;
  tools: Record<string, number>;
  /** Files changed by completed edit tools (used to police read-only runs). */
  edits: string[];
  lastActivity?: string;
  /** What the worker did, step by step (for the dashboard's expanded card). */
  timeline?: Step[];
  error?: string;
}

/**
 * Why a run failed. Everything except `other` is about the model or provider, so
 * the core may retry the task on the next target in the fallback chain.
 */
export type FailureKind = 'model-unavailable' | 'rate-limited' | 'auth' | 'other';

export interface Failure {
  kind: FailureKind;
  message: string;
}

export interface DoctorCheck {
  level: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface Capabilities {
  /** How read-only mode is enforced, shown by `pitroom doctor`. */
  readOnly: 'permission-rules' | 'os-sandbox' | 'tool-allowlist' | 'approval-mode';
  /** Whether `pitroom run --continue` can resume the worker's session. */
  resume: 'by-id' | 'none';
  reportsCost: boolean;
  attachFiles: boolean;
}

export interface ModelInfo {
  id: string;
  /** Reasoning-effort levels the model accepts (`model#level`), lowest first. */
  efforts?: string[];
  defaultEffort?: string;
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** Where the list comes from, for the reader to judge how current it is. */
  source: string;
}

export interface Backend {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Capabilities;
  /** Executable path: PITROOM_<ID>_BIN, then PATH, then known install locations. */
  binary(): string;
  /** Pure: the command line for a request. Must never enable anything beyond the request's mode. */
  invocation(req: WorkerRequest): Invocation;
  /** Pure: the CLI's stdout (event stream) as a normalised run. Must tolerate partial output. */
  parse(stdout: string): ParsedRun;
  /** Undefined when the run succeeded; otherwise the cause, classified for fallback. */
  failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined;
  /** The model the CLI uses when none is given. */
  defaultModel?(): string | undefined;
  /** The model a finished session actually used. */
  resolveModel?(sessionId: string): string | undefined;
  /** Models the CLI can use, for validating configuration. */
  listModels?(): string[];
  /** What the CLI knows about its models: ids, reasoning-effort levels and where that came from. */
  catalog?(): ModelCatalog;
  /** Backend-specific setup checks for the given models (undefined = default model). */
  doctor(ctx: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[];
}
