// Antigravity CLI adapter: `agy -p … --output-format stream-json`, locked down with agy's own mechanisms where they
// hold, and with Pitroom's where they do not:
//   read-only                   agy has no read-only mode for -p runs (google-antigravity/antigravity-cli#45), and
//                               --mode plan still writes in them (#1181). So `readOnly: 'snapshot'`: the core gives
//                               every read run a read-only snapshot of its own, never the project or a shared one.
//                               --mode plan is passed anyway; write and isolate use accept-edits.
//   --sandbox                   shell commands run in agy's terminal sandbox (the project writable, no network)
//   ANTIGRAVITY_APP_DATA_DIR    a private data folder for workers (<pitroom home>/antigravity-home) whose
//                               settings.json holds Pitroom's deny rules (secret files, history-changing git and
//                               the like, other agents, MCP, the web) and keeps file tools inside the workspace.
//                               The user's sign-in file is linked into it (macOS and secret-service keep it in the
//                               keychain instead). Conversations of workers stay there too.
// Never --dangerously-skip-permissions. A refused tool call ends agy's whole turn with status SUCCESS and exit 0
// (#1062), so a run without an answer is a failure here. Everything comes from agy's documentation and the reports of
// projects that run it headless; it has not been checked against a real agy yet (docs/backends.md): experimental.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from '../../core/store.js';
import { FORBIDDEN_COMMANDS } from '../deny.js';
import { findBinary, resolveCommand } from '../exec.js';
import { linkInto, writeIfChanged } from '../home.js';
import { escapeRegex, splitModel } from '../text.js';
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

/** A forbidden command as a regex: any spacing, and git's global options (`--no-pager`, `-P`) before its subcommand. */
const words = (c: string) => {
  const spaced = (t: string) => escapeRegex(t).replace(/ /g, '\\s+');
  return c.startsWith('git ') ? `git(\\s+-[^\\s;&|]+)*\\s+${spaced(c.slice(4))}` : spaced(c);
};

/**
 * Where a command starts in a command line: at its beginning, after a separator (`;`, `&&`, `||`, `|`, `&`, a
 * subshell or command substitution) or after find's `-exec`/`-execdir`/`-ok`, behind any `VAR=value` assignments
 * (quoted values too) and wrappers that run the rest (`env`, `command`, `exec`, `nohup`, `time`, `timeout`, `nice`,
 * `xargs`, `stdbuf`, `setsid`) with their options, option values and numbers (`env -i`, `env -u FOO`, `nice -n 5`,
 * `timeout 60`, `xargs -I {}`). agy matches a rule against the whole command line with a regex, so the rule itself
 * has to find every command in it. It stays a pattern: the git guard is what holds for git whatever the spelling.
 */
const ASSIGN = `\\w+=("[^"]*"|'[^']*'|\\S*)`;
const OPTION = `(-\\S+(\\s+[^-\\s;&|]\\S*)?|\\d\\S*|${ASSIGN})`;
const WRAPPER = `(env|command|exec|nohup|time|timeout|nice|xargs|stdbuf|setsid)(\\s+${OPTION})*`;
const START = `(^|[;&|(\`\\n]|\\$\\(|\\s-(exec|execdir|ok|okdir)\\s)\\s*((${ASSIGN}|${WRAPPER})\\s+)*`;
const END = '(\\s|$|[;&|)`])';

/** The command deny rules: Pitroom's forbidden commands, git by path or with options that point it elsewhere, and shells that would hide a command in a string. */
export function denyCommandRules(): string[] {
  return [
    `command(regex:${START}(${FORBIDDEN_COMMANDS.map(words).join('|')})${END})`,
    // git by path would bypass the git guard's PATH shim; -C, -c, --git-dir and --work-tree point it elsewhere
    `command(regex:${START}(\\S*[\\\\/])?git(\\s+-[^\\s;&|]+)*\\s+(-C|-c|--git-dir|--work-tree)\\b)`,
    `command(regex:${START}\\S*[\\\\/]git${END})`,
    // a recursive delete however its options are spelled or placed (rm -r -f, rm -Rf, rm --recursive, rm dir -rf)
    `command(regex:${START}rm(\\s+[^\\s;&|]+)*\\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)${END})`,
    // a command inside a string is not matched above
    `command(regex:${START}((ba|z|da|k)?sh|eval)\\s+(-\\w*c\\b|['"])|${START}eval${END})`,
  ];
}

/**
 * Pitroom's settings for agy workers. One file for every mode, since a follow-up continues its conversation in the
 * same folder: what differs by mode is agy's own --mode. Deny beats allow in agy's rules.
 */
export function workerSettings() {
  return {
    // Shell commands run in agy's terminal sandbox without asking: a headless run cannot answer, and a command
    // without a grant is refused (#1054), which ends the turn. Narrow command(…) grants are reported not to work in
    // -p runs (#548), command(*) is; the deny rules below still win. Edits are approved by --mode accept-edits.
    toolPermission: 'proceed-in-sandbox',
    artifactReviewPolicy: 'always-proceed',
    allowNonWorkspaceAccess: false,
    permissions: {
      allow: ['command(*)'],
      deny: [
        // A denied read also denies the write of the same path.
        'read_file(regex:(^|[\\\\/])\\.env($|\\.)|[^\\\\/]\\.env$|\\.(pem|p12|pfx|key)$|(^|[\\\\/])id_(rsa|ed25519|ecdsa|dsa)|(^|[\\\\/])\\.netrc$)',
        ...denyCommandRules(),
        'mcp(regex:.*)',
        // No web for agy workers: the rule is in the shared settings file, so --web cannot switch it on per run.
        'read_url(regex:.*)',
      ],
    },
  };
}

/** The private data folder of workers: its settings rewritten when they change, the user's sign-in linked in. */
function workerDir(): string {
  const dir = path.join(home(), 'antigravity-home');
  writeIfChanged(path.join(dir, 'settings.json'), `${JSON.stringify(workerSettings(), null, 2)}\n`);
  linkInto(dir, path.join(userDir(), TOKEN));
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
  const { model, effort } = splitModel(req.model);
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
  if (exitCode === 0 && !run.error) {
    if (run.finalText) return undefined;
    // agy ends with exit 0 and no answer for a used-up quota, its own timeout, a refused tool call (which discards
    // the whole turn) and, in some versions, a pipe it writes nothing to: none of them is an empty answer.
    if (detail) return { kind: classify(detail), message: detail };
    if (lines.some((l) => TIMED_OUT.test(l))) return { kind: 'other', message: 'agy stopped at its own --print-timeout before answering' };
    if (run.usage.denied) return { kind: 'other', message: 'agy ended its turn without an answer when a tool call was refused' };
    if (!run.sessionId && !stderr.trim()) return { kind: 'other', message: 'agy printed nothing (some agy versions write no output to a pipe); update agy' };
    return { kind: 'other', message: 'agy ended without an answer (a refused tool call ends its turn with no other sign)' };
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
      message: 'the Antigravity worker is experimental: not yet checked against a real agy. agy has no read-only mode for headless runs, so its read runs always read a snapshot of the project; prefer -i for changes',
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
  capabilities: { readOnly: 'snapshot', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  doctor,
};
