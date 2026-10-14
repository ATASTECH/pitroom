// Antigravity CLI adapter: `agy -p … --output-format stream-json`, locked down with agy's own mechanisms:
//   --mode plan                 read mode: agy's plan mode, which blocks edits and other changes; write and isolate
//                               use accept-edits (file edits are approved, nothing else is widened)
//   --sandbox                   shell commands run in agy's terminal sandbox (the project writable, no network)
//   ANTIGRAVITY_APP_DATA_DIR    a private data folder for workers (<pitroom home>/antigravity-home) whose
//                               settings.json holds Pitroom's deny rules (secret files, history-changing git and
//                               the like, other agents, MCP, the web) and keeps file tools inside the workspace.
//                               The user's sign-in file is linked into it (macOS and secret-service keep it in the
//                               keychain instead). Conversations of workers stay there too.
// Never --dangerously-skip-permissions. Everything here comes from agy's documentation and the reports of projects
// that run it headless; it has not been checked against a real agy yet (docs/backends.md), so it is experimental.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from '../../core/store.js';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('agy', 'PITROOM_ANTIGRAVITY_BIN', ['~/.local/bin/agy', '~/.antigravity/bin/agy']);

function agy(args: string[], timeout = 30_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

/** The user's own agy folder (settings, the sign-in file where there is no keychain). */
const userDir = () => process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');

const TOKEN = 'antigravity-oauth-token';

// Same intent as the other workers' deny lists; the git guard env layer backs it up.
export const DENY_COMMANDS = [
  'git commit', 'git push', 'git pull', 'git reset', 'git checkout', 'git restore', 'git clean', 'git stash',
  'git rebase', 'git merge', 'git switch', 'git branch', 'git tag', 'git rm', 'git worktree', 'git update-ref',
  'git config', 'git remote', 'git cherry-pick', 'git revert', 'git am', 'git add',
  'rm -rf', 'rm -fr', 'sudo', 'chown', 'kill', 'pkill', 'killall', 'gh', 'npm publish',
  'pitroom', 'opencode', 'claude', 'codex', 'gemini', 'qwen', 'kilo', 'kilocode', 'agy',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pitroom's settings for agy workers. One file for every mode, since a follow-up continues its conversation in the
 * same folder: what differs by mode is agy's own --mode. Deny beats allow in agy's rules.
 */
export function workerSettings() {
  return {
    // Shell commands run in agy's terminal sandbox without asking (a headless run cannot answer); edits are
    // approved by --mode accept-edits in write runs and blocked by --mode plan in read runs.
    toolPermission: 'proceed-in-sandbox',
    artifactReviewPolicy: 'always-proceed',
    allowNonWorkspaceAccess: false,
    permissions: {
      allow: [],
      deny: [
        // A denied read also denies the write of the same path.
        'read_file(regex:(^|[\\\\/])\\.env($|\\.)|[^\\\\/]\\.env$|\\.(pem|p12|pfx|key)$|(^|[\\\\/])id_(rsa|ed25519|ecdsa|dsa)|(^|[\\\\/])\\.netrc$)',
        `command(regex:^\\s*(${DENY_COMMANDS.map(escape).join('|')})(\\s|$))`,
        // git by path would bypass the git guard's PATH shim
        'command(regex:^\\s*\\S*[\\\\/]git(\\s|$))',
        'mcp(regex:.*)',
        // No web for agy workers: the rule is in the shared settings file, so --web cannot switch it on per run.
        'read_url(regex:.*)',
      ],
    },
  };
}

/** The private data folder of workers, written only when it changed, so invoking stays cheap and repeatable. */
function workerDir(): string {
  const dir = path.join(home(), 'antigravity-home');
  const file = path.join(dir, 'settings.json');
  const body = `${JSON.stringify(workerSettings(), null, 2)}\n`;
  let same = false;
  try {
    same = fs.readFileSync(file, 'utf8') === body;
  } catch {
    // not written yet
  }
  if (!same) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
  }
  const from = path.join(userDir(), TOKEN);
  const to = path.join(dir, TOKEN);
  try {
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to);
  } catch {
    // no link: the worker then asks to sign in, which fails with an auth error that doctor explains
  }
  return dir;
}

function invocation(req: WorkerRequest) {
  const args = [
    // -p takes the prompt as its value; one that starts with "-" would be read as an option: a leading space keeps it a value.
    '-p', req.prompt.startsWith('-') ? ` ${req.prompt}` : req.prompt,
    '--output-format', 'stream-json',
    '--mode', req.mode === 'read' ? 'plan' : 'accept-edits',
    '--sandbox',
    // agy's own limit (5m by default) would end a long run with partial output and exit 0; Pitroom's timeout governs.
    '--print-timeout', '24h',
  ];
  // The conversation id of the stream: never --continue (the latest conversation), which is unsafe beside parallel workers.
  if (req.sessionId) args.push('--conversation', req.sessionId);
  const [model, effort] = (req.model ?? '').split('#');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  const { command, prefix } = resolveCommand(binary());
  return { command, args: [...prefix, ...args], env: { ANTIGRAVITY_APP_DATA_DIR: workerDir() } };
}

export function classify(message: string): FailureKind {
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|capacity/i.test(message)) return 'rate-limited';
  if (/not (signed|logged) in|\bsign.?in\b|\blog ?in\b|unauthenticated|UNAUTHENTICATED|PERMISSION_DENIED|oauth|credential|keyring|keychain|\b401\b|unauthori[sz]ed/i.test(message)) {
    return 'auth';
  }
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unknown|unsupported|invalid)|unknown model|invalid model|NOT_FOUND|\b404\b/i.test(message)) {
    return 'model-unavailable';
  }
  return 'other';
}

const TIMED_OUT = /print timeout after/i;

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  // agy 1.2.6+ prints a structured "AGY_ERROR {…}" line; otherwise the first line that says what went wrong.
  const envelope = lines.find((l) => l.startsWith('AGY_ERROR'));
  const detail = (envelope && fromEnvelope(envelope)) ?? lines.find((l) => /RESOURCE_EXHAUSTED|error|failed|quota|exhausted|denied|not found|\bsign.?in\b/i.test(l) && !TIMED_OUT.test(l));
  const quiet = !run.finalText && !run.sessionId && run.usage.steps === 0;
  if (exitCode === 0 && !run.error) {
    // A used-up quota can end with exit 0 and no answer; so can agy's own timeout, with partial output.
    if (!run.finalText && detail) return { kind: classify(detail), message: detail };
    if (lines.some((l) => TIMED_OUT.test(l)) && !run.finalText) return { kind: 'other', message: 'agy stopped at its own --print-timeout before answering' };
    if (quiet && !stderr.trim()) return { kind: 'other', message: 'agy printed nothing (some agy versions write no output to a pipe); update agy' };
    return undefined;
  }
  const message = run.error ?? detail ?? lines.at(-1) ?? `agy exited with code ${exitCode}`;
  return { kind: classify(`${message} ${detail ?? ''}`), message };
}

function fromEnvelope(line: string): string | undefined {
  try {
    const e = JSON.parse(line.slice(line.indexOf('{')));
    const text = [e.code, e.message ?? e.error].filter(Boolean).join(': ');
    return text || undefined;
  } catch {
    return line.replace(/^AGY_ERROR:?\s*/, '') || undefined;
  }
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = agy(['--version']);
  if (version.missing || !version.ok) {
    return [{
      level: 'fail',
      message: `agy not runnable (${binary()}). Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash), or set PITROOM_ANTIGRAVITY_BIN`,
    }];
  }
  const checks: DoctorCheck[] = [
    { level: 'ok', message: `Antigravity CLI ${version.out.trim().split('\n')[0]} at ${binary()}` },
    {
      level: 'warn',
      message: 'the Antigravity worker is experimental: its read-only mode (--mode plan), sandbox and deny rules have not been checked against a real agy yet; try it with -i first and look for READ-ONLY VIOLATION in read runs',
    },
  ];
  if (process.platform === 'win32') {
    checks.push({ level: 'warn', message: "agy's permission rules and terminal sandbox are for macOS and Linux; on Windows run the Antigravity worker only with -i (an isolated copy)" });
  }
  // On Linux without secret-service the sign-in is a file; macOS and secret-service keep it in the keychain.
  if (process.platform === 'linux' && !fs.existsSync(path.join(userDir(), TOKEN))) {
    checks.push({ level: 'warn', message: 'no Antigravity sign-in file found: if a run fails to sign in, run `agy` once and sign in with your Google account' });
  }
  for (const m of models) checks.push({ level: 'ok', message: m ? `Antigravity model: ${m}` : "Antigravity model: agy's own choice (`agy models` lists yours)" });
  checks.push({ level: 'ok', message: 'Antigravity workers have no web access (--web does not apply to them)' });
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Antigravity runs (its quota is per account and can run out for hours)' });
  return checks;
}

export const antigravity: Backend = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  capabilities: { readOnly: 'approval-mode', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  doctor,
};
