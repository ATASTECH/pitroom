// Claude Code adapter: `claude -p --output-format stream-json`, locked down with
// Claude Code's own mechanisms:
//   --safe-mode           no CLAUDE.md, skills, plugins, hooks or MCP from the user
//   --restricted          no command-running tools unless listed; user/project
//                         settings ignored; file tools confined to the working
//                         directory; bypassPermissions refused; writes to git and
//                         settings files need a person's approval (none here)
//   --strict-mcp-config   no MCP servers at all
//   --permission-mode dontAsk + --tools/--allowedTools   an explicit allowlist, and
//                         anything else is denied instead of prompting
// Not --bare: it disables OAuth, which would break Claude subscriptions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ModelCatalog, Mode, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('claude', 'PITROOM_CLAUDE_BIN', ['~/.local/bin/claude', '~/.claude/local/claude']);

function cl(args: string[], timeout = 60_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

// Same intent as the OpenCode write profile; the git guard env layer backs it up.
const DENY_BASH = [
  'git commit', 'git push', 'git pull', 'git reset', 'git checkout', 'git restore', 'git clean', 'git stash',
  'git rebase', 'git merge', 'git switch', 'git branch', 'git tag', 'git rm', 'git worktree', 'git update-ref',
  'git config', 'git remote', 'git cherry-pick', 'git revert', 'git am', 'git add',
  'rm -rf', 'rm -fr', 'sudo', 'chown', 'kill', 'pkill', 'killall', 'gh', 'npm publish',
  'pitroom', 'opencode', 'claude', 'codex', 'gemini',
].map((c) => `Bash(${c}:*)`);

const SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa*', '**/id_ed25519*'].map((p) => `Read(${p})`);

export function toolsFor(mode: Mode, web: boolean): string[] {
  return [...(mode === 'read' ? READ_TOOLS : WRITE_TOOLS), ...(web ? WEB_TOOLS : [])];
}

function invocation(req: WorkerRequest) {
  const tools = toolsFor(req.mode, req.web).join(',');
  const args = [
    '-p',
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    '--tools', tools,
    '--allowedTools', tools,
  ];
  if (req.mode !== 'read') args.push('--disallowedTools', ...DENY_BASH);
  args.push(
    '--settings', JSON.stringify({ permissions: { deny: SECRETS } }),
    // Non-variadic options last, so no list above can swallow what follows.
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--verbose',
  );
  // "sonnet#high": the model alias and, after "#", the effort level (Claude Code's --effort).
  const [model, effort] = (req.model ?? '').split('#');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (req.sessionId) args.push('--resume', req.sessionId);
  args.push('--', req.prompt);
  const { command, prefix } = resolveCommand(binary());
  return { command, args: [...prefix, ...args], env: { DISABLE_AUTOUPDATER: '1' } };
}

export function classify(message: string): FailureKind {
  if (/authentication_failed|failed to authenticate|oauth|not logged in|\/login|invalid api key|\b40[13]\b|unauthori[sz]ed/i.test(message)) {
    return 'auth';
  }
  if (/rate.?limit|too many requests|\b429\b|\b529\b|overloaded|usage limit|limit reached|quota|capacity/i.test(message)) return 'rate-limited';
  if (/model[^.]*(not found|does not exist|invalid|not available)|invalid model|not_found_error/i.test(message)) return 'model-unavailable';
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  const detail = stderr.trim().split('\n').filter(Boolean).pop();
  const message = run.error ?? detail ?? `claude exited with code ${exitCode}`;
  return { kind: classify(message), message };
}

function defaultModel(): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    return typeof settings.model === 'string' ? settings.model : undefined;
  } catch {
    return undefined;
  }
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = cl(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `claude not runnable (${binary()}). Install Claude Code, or set PITROOM_CLAUDE_BIN` }];
  }
  const checks: DoctorCheck[] = [{ level: 'ok', message: `Claude Code ${version.out.trim()} at ${binary()}` }];
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(cl(['auth', 'status']).out).loggedIn === true;
  } catch {
    /* older CLI */
  }
  checks.push(
    loggedIn || process.env.ANTHROPIC_API_KEY
      ? { level: 'ok', message: `Claude Code: ${loggedIn ? 'logged in' : 'ANTHROPIC_API_KEY set'}` }
      : { level: 'fail', message: 'Claude Code is not logged in (or the session expired): run `claude auth login`' },
  );
  for (const m of models) {
    const model = m ?? defaultModel();
    const pricey = model && /opus|fable/i.test(model);
    checks.push({
      level: pricey ? 'warn' : 'ok',
      message: pricey
        ? `Claude Code model: ${model} is the most expensive tier for a worker; consider -W claude:haiku or claude:sonnet`
        : model
        ? `Claude Code model: ${model}`
        : "Claude Code model: Claude Code's default (often the largest model; a cheaper worker is -W claude:haiku)",
    });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Claude Code runs' });
  return checks;
}

/** Claude Code names models by alias (the latest of each size) or by full id; --effort takes these levels. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function catalog(): ModelCatalog {
  const def = defaultModel();
  const models = ['haiku', 'sonnet', 'opus'].map((id) => ({ id, efforts: CLAUDE_EFFORTS }));
  if (def && !models.some((m) => m.id === def)) models.push({ id: def, efforts: CLAUDE_EFFORTS });
  return { models, source: 'Claude Code aliases (latest of each size) and --effort levels from `claude --help`' };
}

export const claude: Backend = {
  id: 'claude',
  name: 'Claude Code',
  capabilities: { readOnly: 'tool-allowlist', resume: 'by-id', reportsCost: true, attachFiles: false },
  binary,
  catalog,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  doctor,
};
