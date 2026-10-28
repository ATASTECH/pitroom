// Cursor CLI adapter: `cursor-agent -p … --output-format stream-json`, locked down with Cursor's own mechanisms
// (checked against Cursor CLI 2026.05.09 on macOS, docs/backends.md):
//   --mode ask   read runs: Q&A, read-only (writes, non-read-only commands and web fetches refused); they also read a
//                snapshot of their own (readOnly 'snapshot'), so the project is safe whatever the mode lets through
//   --sandbox enabled   shell commands in Cursor's sandbox: writes only in the workspace (and the temp folder); an
//                edit outside it is refused in a headless run, which cannot ask. It does not block the network (asked
//                for with networkAccess user_config_only, curl still answered in 2026.10.22)
//   permissions  cli-config.json in a home of the worker's own: the forbidden commands and secret files denied, every
//                other command allowed in a change, none in a read; web off unless --web
//   HOME         a home per workspace (CURSOR_CONFIG_DIR inside it): the user's MCP servers, hooks, plugins and rules
//                (~/.cursor, ~/.claude) are not loaded, and the worker's commands do not see their dotfiles
// Never --force/--yolo, --approve-mcps or --continue (the latest chat, unsafe beside parallel workers). The CLI updates
// itself unless told not to: --disable-auto-update.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from '../../core/store.js';
import { inCopy } from '../antigravity/index.js';
import { FORBIDDEN_COMMANDS } from '../deny.js';
import { findBinary, resolveCommand } from '../exec.js';
import { linkInto, writeIfChanged } from '../home.js';
import { splitModel } from '../text.js';
import type { Backend, DoctorCheck, Failure, FailureKind, Mode, ModelCatalog, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('cursor-agent', 'PITROOM_CURSOR_BIN', ['~/.local/bin/cursor-agent']);

function cursor(args: string[], timeout = 30_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

const HOMES_KEPT_DAYS = 14;
const SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/.netrc'];
/** The user's own folders of credentials: a read run's tools may read outside the project, never these. */
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config/gcloud', '.config/gh', '.config/cursor', '.gemini', '.cursor', '.claude', 'Library/Keychains'];
/** In the worker's own home: the sign-in linked in, and Cursor's own settings and chats. */
const WORKER_HOME_SECRETS = ['Library/Keychains', '.config/cursor', '.cursor'];

/**
 * The worker's cli-config.json: Cursor rewrites it as it runs, so it is written whole before every run. `dir` is the
 * worker's home, whose sign-in links its read tool must not follow.
 */
export function workerSettings(mode: Mode, web: boolean, dir: string) {
  const appData = process.platform === 'win32' ? [path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor')] : [];
  return {
    version: 1,
    permissions: {
      // a change may run its tests and builds, minus the forbidden commands; a read runs none (ask mode refuses them too)
      allow: mode === 'read' ? [] : ['Shell(*)'],
      deny: [
        ...FORBIDDEN_COMMANDS.map((c) => `Shell(${c})`),
        ...SECRETS.flatMap((p) => [`Read(${p})`, `Write(${p})`]),
        ...[...HOME_SECRETS.map((d) => path.join(os.homedir(), d)), ...appData].map((d) => `Read(${d}/**)`),
        ...WORKER_HOME_SECRETS.flatMap((d) => [`Read(${path.join(dir, d)}/**)`, `Write(${path.join(dir, d)}/**)`]),
        // Cursor runs a project's own hooks (.cursor/hooks.json, Claude Code's .claude/settings.json) and there is no
        // switch to turn them off: no worker may plant any, for its follow-ups or for your own Cursor
        'Write(**/.cursor/**)',
        'Write(**/.claude/**)',
        ...(web ? [] : ['WebFetch(*)']),
      ],
    },
    approvalMode: 'allowlist',
    sandbox: { mode: 'enabled', networkAccess: web ? 'allow_all' : 'user_config_only', networkAllowlist: [] },
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
  };
}

/** Where the user's sign-in is outside macOS (there it is in the login keychain): a file, which is linked in. */
function authFile(): string {
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json')
    : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'cursor', 'auth.json');
}

/**
 * The worker home for a workspace (follow-ups find their chat there): its settings written for this run, the
 * user's sign-in linked in. Homes not used for two weeks are removed, their chats with them.
 */
export function workerHome(workspace: string, mode: Mode, web: boolean): string {
  const root = path.join(home(), 'cursor-home');
  const id = crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  writeIfChanged(path.join(dir, '.cursor', 'cli-config.json'), `${JSON.stringify(workerSettings(mode, web, dir), null, 2)}\n`);
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.join(dir, 'Library'), { recursive: true });
    linkInto(path.join(dir, 'Library'), path.join(os.homedir(), 'Library', 'Keychains'));
  } else if (process.platform !== 'win32') {
    // on Windows APPDATA, where the sign-in is, is left as it is
    fs.mkdirSync(path.join(dir, '.config', 'cursor'), { recursive: true });
    linkInto(path.join(dir, '.config', 'cursor'), authFile());
  }
  const now = new Date();
  fs.utimesSync(dir, now, now);
  pruneHomes(root, dir);
  return dir;
}

function pruneHomes(root: string, keep: string): void {
  const cutoff = Date.now() - HOMES_KEPT_DAYS * 86_400_000;
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (dir !== keep && /^[0-9a-f]{16}$/.test(name) && fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

function invocation(req: WorkerRequest) {
  // a worker in a snapshot or an isolated copy is told the copy's paths (an edit outside its workspace is refused)
  const prompt = inCopy(req.prompt, req.project);
  // --disable-auto-update (hidden, in 2026.05 and 2026.10): the CLI replaced itself between two runs of the check
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--disable-auto-update', '--workspace', req.cwd];
  if (req.mode === 'read') args.push('--mode', 'ask');
  // Cursor names a model's effort in its id (claude-opus-5-5-high): "model#high" becomes that
  const { model, effort } = splitModel(req.model);
  if (model) args.push('--model', effort ? `${model}-${effort}` : model);
  if (req.sessionId) args.push('--resume', req.sessionId);
  // after "--", a prompt that starts with "-" is still the prompt
  args.push('--', prompt);
  const { command, prefix } = resolveCommand(binary());
  const dir = workerHome(req.cwd, req.mode, req.web);
  // The worker's commands see this home too: the user's own dotfiles stay out of their reach.
  const env: Record<string, string> = { HOME: dir, CURSOR_CONFIG_DIR: path.join(dir, '.cursor') };
  if (process.platform === 'win32') env.USERPROFILE = dir;
  return { command, args: [...prefix, ...args], env };
}

export function classify(message: string): FailureKind {
  if (/authentication required|agent login|not logged in|log ?in first|CURSOR_API_KEY|invalid api key|unauthori[sz]ed|\b401\b/i.test(message)) return 'auth';
  if (/usage limit|rate.?limit|too many requests|\b429\b|quota|out of (fast )?requests|spend limit|overloaded|capacity/i.test(message)) return 'rate-limited';
  if (/cannot use this model|model.{0,60}(not found|not available|does not exist|unknown|invalid)|unknown model|invalid model/i.test(message)) return 'model-unavailable';
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  // its unknown-model line goes on to list every model of the account
  const detail = stderr.trim().split('\n').filter(Boolean).pop()?.replace(/\.\s*Available models:.*$/s, '.');
  const message = run.error ?? detail ?? `cursor-agent exited with code ${exitCode}`;
  return { kind: classify(message), message: message.slice(0, 500) };
}

/** `cursor-agent models`: "id - Name" lines; an effort is part of the id. */
function listModels(): string[] {
  return cursor(['models']).out.split('\n').map((l) => /^([\w.-]+) - /.exec(l.trim())?.[1]).filter((m): m is string => !!m);
}

function catalog(): ModelCatalog {
  return { models: listModels().map((id) => ({ id })), source: '`cursor-agent models` (the effort is part of the id: -low, -high, -max)' };
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = cursor(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `cursor-agent not runnable (${binary()}). Install Cursor CLI (curl https://cursor.com/install -fsS | bash), or set PITROOM_CURSOR_BIN` }];
  }
  const checks: DoctorCheck[] = [{ level: 'ok', message: `Cursor CLI ${version.out.trim().split('\n')[0]} at ${binary()}` }];
  checks.push(
    process.platform === 'darwin'
      ? { level: 'ok', message: 'Cursor read runs: ask mode, in a snapshot of their own; changes: its sandbox and permission rules' }
      : { level: 'warn', message: `the Cursor worker is in beta on ${process.platform === 'win32' ? 'Windows' : 'Linux'} (checked on macOS only; node scripts/check-worker.mjs cursor tries it here)` },
  );
  // the status as a worker sees it: through the home of its own, with the sign-in linked in
  const status = spawnSync(resolveCommand(binary()).command, [...resolveCommand(binary()).prefix, 'status'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...invocation({ mode: 'read', prompt: '', cwd: os.tmpdir(), files: [], web: false, title: '' }).env },
  });
  const out = `${status.stdout ?? ''}${status.stderr ?? ''}`;
  checks.push(
    /logged in as/i.test(out) || process.env.CURSOR_API_KEY
      ? { level: 'ok', message: `Cursor CLI: ${/logged in as \S+/i.exec(out)?.[0] ?? 'CURSOR_API_KEY set'}` }
      : { level: 'fail', message: 'Cursor CLI is not signed in (as a worker sees it): run `cursor-agent login`' },
  );
  for (const m of models) checks.push({ level: 'ok', message: m ? `Cursor model: ${m}` : 'Cursor model: auto (Cursor picks; `cursor-agent models` lists yours)' });
  checks.push({ level: 'ok', message: "Cursor applies your account's own User Rules from cursor.com to workers too (they may change the answer's language)" });
  checks.push({
    level: 'warn',
    message: "Cursor runs a project's own hooks (.cursor/hooks.json, and Claude Code's in .claude/settings.json) in worker runs too, with no switch to turn them off: use the Cursor worker on code whose hooks you would run yourself (not on a stranger's pull request)",
  });
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Cursor runs (its usage limits are per plan)' });
  return checks;
}

export const cursorBackend: Backend = {
  id: 'cursor',
  name: 'Cursor CLI',
  capabilities: { readOnly: 'snapshot', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  catalog,
  invocation,
  parse: parseEvents,
  failure,
  listModels,
  doctor,
};
