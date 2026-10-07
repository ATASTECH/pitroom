// Qwen Code adapter: `qwen <prompt> --output-format stream-json …`, locked down with Qwen Code's own mechanisms
// (checked against Qwen Code 0.25.0, see docs/backends.md):
//   --safe-mode                no QWEN.md, hooks, extensions, skills or MCP servers from the user, and no background
//                              memory extraction (which otherwise writes what a run saw into ~/.qwen/memories)
//   --approval-mode plan       read mode: edits and shell are declined, and so are reads outside the working directory
//   --approval-mode default    write and isolate: what --allowed-tools names runs, everything else is declined (a headless
//                              run cannot ask). Named: edits inside the working directory (Edit(./**), write_file(./**)),
//                              and the shell minus history-changing git and the like. Not auto-edit: it approves an edit
//                              anywhere on disk (seen: an isolated run edited the user's real checkout).
//   --exclude-tools            tools a worker never needs and that act outside the task: subagents, memory, cron,
//                              worktrees (plan mode alone lets `enter_worktree` make a branch), messages; web unless asked
//   QWEN_CODE_SYSTEM_DEFAULTS_PATH   policies/qwen/worker-defaults.json: no auto-update, no 10 × 60 s rate-limit
//                              retries (a quota error then surfaces in about a minute, and the fallback chain moves on)
// Never --yolo / --approval-mode yolo / auto. The user's sign-in and model settings (~/.qwen/settings.json) are used.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('qwen', 'PITROOM_QWEN_BIN', ['~/.local/bin/qwen', '~/.npm-global/bin/qwen']);

/** Pitroom's own files ship in the package: policies/ sits next to dist/ (package.json "files"). */
const policyDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'policies', 'qwen');

/** Tools no worker gets, in any mode: they act outside the task (or outside the project) or hand the work on. */
export const EXCLUDED = [
  'agent', 'send_message', 'skill', 'manage_memory', 'search_memory', 'enter_worktree', 'exit_worktree', 'record_artifact',
  'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup', 'task_stop', 'update_goal', 'get_goal', 'list_agents',
  'report_findings', 'tool_call', 'tool_search', 'read_mcp_resource',
];
const WEB = ['web_fetch', 'web_search'];
/** Edits approved in write and isolate runs: inside the working directory only ("./" is the CLI's cwd). */
export const EDITS_HERE = ['Edit(./**)', 'write_file(./**)', 'notebook_edit(./**)'];

// Same intent as the Claude Code and OpenCode write profiles; the git guard env layer backs it up.
export const DENY_SHELL = [
  'git commit', 'git push', 'git pull', 'git reset', 'git checkout', 'git restore', 'git clean', 'git stash',
  'git rebase', 'git merge', 'git switch', 'git branch', 'git tag', 'git rm', 'git worktree', 'git update-ref',
  'git config', 'git remote', 'git cherry-pick', 'git revert', 'git am', 'git add',
  'rm -rf', 'rm -fr', 'sudo', 'chown', 'kill', 'pkill', 'killall', 'gh', 'npm publish',
  'pitroom', 'opencode', 'claude', 'codex', 'gemini', 'qwen',
].map((c) => `run_shell_command(${c})`);

function invocation(req: WorkerRequest) {
  const read = req.mode === 'read';
  const exclude = [...EXCLUDED, ...(req.web ? [] : WEB), ...(read ? [] : DENY_SHELL)];
  const args = [
    // The prompt is the first word: the list options below take every word that follows them, and Qwen Code reads
    // no prompt after "--". One that starts with "-" would be read as an option: a leading space keeps it the prompt.
    req.prompt.startsWith('-') ? ` ${req.prompt}` : req.prompt,
    '--safe-mode',
    '--output-format', 'stream-json',
    '--approval-mode', read ? 'plan' : 'default',
    '--exclude-tools', ...exclude,
  ];
  if (!read) args.push('--allowed-tools', ...EDITS_HERE, 'run_shell_command');
  // A model's "#level" has no Qwen Code equivalent: it is dropped.
  const model = (req.model ?? '').split('#')[0];
  if (model) args.push('--model', model);
  if (req.sessionId) args.push('--resume', req.sessionId);
  const { command, prefix } = resolveCommand(binary());
  return {
    command,
    args: [...prefix, ...args],
    env: {
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(policyDir(), 'worker-defaults.json'),
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_DISABLE_AUTO_TITLE: '1',
    },
  };
}

export function classify(message: string): FailureKind {
  if (/\b40[13]\b|incorrect api key|invalid api key|unauthori[sz]ed|authenticat|not logged in|no auth/i.test(message)) return 'auth';
  if (/\b429\b|rate.?limit|too many requests|quota|capacity|overloaded|\b529\b/i.test(message)) return 'rate-limited';
  if (/model[^.]*(not found|does not exist|not available|not supported)|invalid model|model_not_found|\b404\b/i.test(message)) return 'model-unavailable';
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  const detail = stderr.trim().split('\n').filter((l) => l.trim() && !/SAFE MODE/.test(l)).pop();
  const message = run.error ?? detail ?? `qwen exited with code ${exitCode}`;
  return { kind: classify(message), message };
}

function userSettings(): { model?: { name?: string }; security?: { auth?: { selectedType?: string } } } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.QWEN_HOME ?? path.join(os.homedir(), '.qwen'), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function defaultModel(): string | undefined {
  const name = userSettings().model?.name;
  return typeof name === 'string' && name ? name : undefined;
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return [{ level: 'fail', message: `qwen not runnable (${binary()}). Install Qwen Code (npm i -g @qwen-code/qwen-code), or set PITROOM_QWEN_BIN` }];
  const checks: DoctorCheck[] = [{ level: 'ok', message: `Qwen Code ${r.stdout.trim()} at ${binary()} (beta worker: checked against Qwen Code 0.25)` }];
  const auth = userSettings().security?.auth?.selectedType;
  const key = process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
  checks.push(
    auth || key
      ? { level: 'ok', message: `Qwen Code: sign-in ${auth ?? 'from an API key in the environment'}` }
      : { level: 'warn', message: 'Qwen Code has no sign-in method set: run `qwen` once to choose one, or set OPENAI_API_KEY (and OPENAI_BASE_URL) for an OpenAI-compatible provider' },
  );
  for (const m of models) {
    const model = m ?? defaultModel();
    checks.push({ level: model ? 'ok' : 'warn', message: model ? `Qwen Code model: ${model}` : 'Qwen Code model: none pinned (pass -W qwen:<model> or set model.name in ~/.qwen/settings.json)' });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Qwen Code runs' });
  return checks;
}

export const qwen: Backend = {
  id: 'qwen',
  name: 'Qwen Code',
  capabilities: { readOnly: 'approval-mode', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  doctor,
};
