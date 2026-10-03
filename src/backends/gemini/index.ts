// Gemini CLI adapter: `gemini --prompt=… --output-format stream-json`, locked down with Gemini CLI's own mechanisms:
//   --approval-mode plan       read mode: the CLI's policy engine allows only read tools (no shell, no edits, writes
//                              only to its own plans folder); write and isolate use auto_edit (edits are approved)
//   --policy <files>           Pitroom's rules (policies/gemini): secret files unreadable, no MCP, no web unless asked,
//                              and in write modes shell commands allowed minus history-changing git and the like
//   -e none                    no extensions
//   GEMINI_CLI_SYSTEM_SETTINGS_PATH   policies/gemini/system-settings.json, which outranks the user's own settings:
//                              hooks off (they would run on every worker and print into the stream), no MCP servers,
//                              no skills, no user GEMINI.md, no auto-update, YOLO mode disabled
// Never --yolo / --approval-mode yolo. The user's sign-in (~/.gemini or an API key) is used as it is.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ModelCatalog, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('gemini', 'PITROOM_GEMINI_BIN', ['~/.local/bin/gemini']);

function gem(args: string[], timeout = 60_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

/** Pitroom's own rule files ship in the package: policies/ sits next to dist/ (package.json "files"). */
const policyDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'policies', 'gemini');

function invocation(req: WorkerRequest) {
  const dir = policyDir();
  const policies = ['base.toml', ...(req.web ? [] : ['no-web.toml']), ...(req.mode === 'read' ? [] : ['shell.toml'])];
  const args = [
    // A prompt that starts with "-" would be read as an option: a leading space keeps it a value.
    '--prompt', req.prompt.startsWith('-') ? ` ${req.prompt}` : req.prompt,
    '--output-format', 'stream-json',
    '--approval-mode', req.mode === 'read' ? 'plan' : 'auto_edit',
    '-e', 'none',
  ];
  for (const p of policies) args.push('--policy', path.join(dir, p));
  // Gemini has no reasoning-effort option; a "#level" suffix is dropped.
  const [model] = (req.model ?? '').split('#');
  if (model) args.push('--model', model);
  const { command, prefix } = resolveCommand(binary());
  return { command, args: [...prefix, ...args], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(dir, 'system-settings.json') } };
}

export function classify(message: string): FailureKind {
  if (/IneligibleTier|no longer supported for Gemini|error authenticating|not logged in|please (log ?in|sign in)|credentials|api key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return 'auth';
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|exhausted your capacity|capacity/i.test(message)) return 'rate-limited';
  if (/model[^.]*(not found|not available|does not exist|unsupported|invalid)|\b404\b|NOT_FOUND|invalid model|is not supported/i.test(message)) return 'model-unavailable';
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  // Gemini prints a stack trace on stderr: the first line that says what went wrong is the message.
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const message = run.error ?? detail ?? `gemini exited with code ${exitCode}`;
  return { kind: classify(message), message };
}

const geminiHome = () => path.join(process.env.GEMINI_CLI_HOME ?? os.homedir(), '.gemini');

function settings(): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(geminiHome(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function defaultModel(): string | undefined {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const m = settings().model;
  const name = typeof m === 'string' ? m : m?.name;
  return typeof name === 'string' ? name : undefined;
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = gem(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `gemini not runnable (${binary()}). Install Gemini CLI (npm i -g @google/gemini-cli), or set PITROOM_GEMINI_BIN` }];
  }
  const checks: DoctorCheck[] = [{ level: 'ok', message: `Gemini CLI ${version.out.trim()} at ${binary()}` }];
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const vertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || process.env.GOOGLE_GENAI_USE_VERTEXAI === '1';
  const signedIn = fs.existsSync(path.join(geminiHome(), 'oauth_creds.json'));
  const type = settings().security?.auth?.selectedType;
  if (key || vertex) {
    checks.push({ level: 'ok', message: `Gemini CLI: ${key ? 'an API key is set' : 'Vertex AI is set up'}` });
  } else if (signedIn && type === 'oauth-personal') {
    checks.push({
      level: 'warn',
      message: 'Gemini CLI is signed in with a Google account (oauth-personal). If a run fails with IneligibleTierError, Google no longer serves that sign-in to this CLI: set GEMINI_API_KEY (Google AI Studio) instead',
    });
  } else if (signedIn) {
    checks.push({ level: 'ok', message: 'Gemini CLI: signed in' });
  } else {
    checks.push({ level: 'fail', message: 'Gemini CLI is not signed in: run `gemini` once to sign in, or set GEMINI_API_KEY (Google AI Studio)' });
  }
  for (const m of models) {
    const model = m ?? defaultModel();
    const pricey = model && /pro/i.test(model);
    checks.push({
      level: pricey ? 'warn' : 'ok',
      message: pricey
        ? `Gemini model: ${model} is the largest tier for a worker; consider -W gemini:gemini-2.5-flash`
        : model
        ? `Gemini model: ${model}`
        : "Gemini model: Gemini CLI's own choice (it may pick a Pro model; a cheaper worker is -W gemini:gemini-2.5-flash)",
    });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Gemini runs' });
  return checks;
}

/** Gemini CLI has no command that lists models: these are the names it knows (config/models in Gemini CLI 0.35). */
function catalog(): ModelCatalog {
  const def = defaultModel();
  const models = ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].map((id) => ({ id }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def });
  return { models, source: "Gemini CLI's built-in model names (it cannot list models); the effort suffix is not used" };
}

export const gemini: Backend = {
  id: 'gemini',
  name: 'Gemini CLI',
  capabilities: { readOnly: 'approval-mode', resume: 'none', reportsCost: false, attachFiles: false },
  binary,
  catalog,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  doctor,
};
