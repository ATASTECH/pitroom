// Gemini CLI adapter: `gemini --prompt … --output-format stream-json`, locked down with Gemini CLI's own mechanisms:
//   --approval-mode plan       read mode: the CLI's policy engine allows only read tools (no shell, no edits, writes
//                              only to its own plans folder); write and isolate use auto_edit (edits are approved)
//   --policy <files>           Pitroom's rules (policies/gemini): shell commands allowed in write modes minus
//                              history-changing git and the like (verified live), no MCP, no web unless asked, and
//                              deny rules for secret files, which Gemini CLI 0.62 loads but does not apply to read_file
//   -e none                    no extensions
//   GEMINI_CLI_HOME            a private home for workers (<pitroom home>/gemini-home) whose settings come from
//                              policies/gemini/worker-settings.json: the user's hooks, MCP servers, skills and
//                              GEMINI.md are not loaded (hooks would run on every worker), no auto-update, no YOLO.
//                              Gemini CLI 0.62 ignores a system settings file that root does not own, so the user
//                              settings of a private home are the way to do this without sudo.
// Never --yolo / --approval-mode yolo. The user's sign-in (an API key in the keychain, or oauth files) is carried over.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from '../../core/store.js';
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

/**
 * The private GEMINI_CLI_HOME of workers: Pitroom's isolating settings plus the user's chosen sign-in method, and
 * links to their sign-in files. Written only when it changed, so invoking stays cheap and repeatable.
 */
function workerHome(): string {
  const root = path.join(home(), 'gemini-home');
  const dir = path.join(root, '.gemini');
  const base = JSON.parse(fs.readFileSync(path.join(policyDir(), 'worker-settings.json'), 'utf8'));
  const auth = settings().security?.auth;
  const body = `${JSON.stringify(auth ? { ...base, security: { ...base.security, auth } } : base, null, 2)}\n`;
  const file = path.join(dir, 'settings.json');
  try {
    if (fs.readFileSync(file, 'utf8') === body) return root;
  } catch {
    // not written yet
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  for (const name of ['oauth_creds.json', 'google_accounts.json']) {
    const from = path.join(geminiHome(), name);
    const to = path.join(dir, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to);
    } catch {
      // no link: the worker then asks to sign in, which fails with an auth error that doctor explains
    }
  }
  return root;
}

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
  // A headless run in a folder Gemini CLI does not trust fails; trusting makes it load that project's own Gemini
  // settings (hooks, MCP), so this is opt-in. Folders the user already trusted in Gemini stay trusted.
  if (process.env.PITROOM_GEMINI_TRUST === '1') args.push('--skip-trust');
  // Gemini has no reasoning-effort option; a "#level" suffix is dropped.
  const [model] = (req.model ?? '').split('#');
  if (model) args.push('--model', model);
  const { command, prefix } = resolveCommand(binary());
  const env: Record<string, string> = { GEMINI_CLI_HOME: workerHome() };
  const trusted = path.join(geminiHome(), 'trustedFolders.json');
  if (fs.existsSync(trusted)) env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = trusted;
  return { command, args: [...prefix, ...args], env };
}

export function classify(message: string): FailureKind {
  if (/IneligibleTier|no longer supported for Gemini|error authenticating|not logged in|please (log ?in|sign in)|credentials|api key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return 'auth';
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|exhausted your capacity|capacity/i.test(message)) return 'rate-limited';
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unsupported|invalid)|\b404\b|NOT_FOUND|invalid model|is not supported/i.test(message)) return 'model-unavailable';
  return 'other';
}

const UNTRUSTED = 'Gemini CLI does not trust this folder: open `gemini` in it once and trust it, or set PITROOM_GEMINI_TRUST=1 (the folder\'s own Gemini settings, hooks included, then load)';

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  // Gemini prints a stack trace on stderr: the first line that says what went wrong is the message.
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /error|failed|exceeded|quota|exhausted|unsupported/i.test(l) && !/^at /.test(l)) ?? lines.at(-1);
  const raw = run.error ?? detail ?? `gemini exited with code ${exitCode}`;
  const message = /not running in a trusted directory/i.test(`${stderr} ${raw}`) ? UNTRUSTED : raw;
  return { kind: classify(message), message };
}

function geminiHome(): string {
  return path.join(process.env.GEMINI_CLI_HOME ?? os.homedir(), '.gemini');
}

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
  } else if (type === 'gemini-api-key' || type === 'vertex-ai') {
    // the key itself is kept by Gemini CLI (its keychain entry), not in a file or the environment
    checks.push({ level: 'ok', message: `Gemini CLI: ${type === 'vertex-ai' ? 'Vertex AI' : 'an API key'} is selected (kept by Gemini CLI)` });
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
        ? `Gemini model: ${model} is the largest tier for a worker; consider -W gemini:gemini-3.8-flash`
        : model
        ? `Gemini model: ${model}`
        : "Gemini model: Gemini CLI's own choice (it may pick a Pro model; a cheaper worker is -W gemini:gemini-3.8-flash)",
    });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Gemini runs' });
  return checks;
}

/** Gemini CLI has no command that lists models: these are the names it knows (config/models in Gemini CLI 0.35). */
function catalog(): ModelCatalog {
  const def = defaultModel();
  const models = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'].map((id) => ({ id }));
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
