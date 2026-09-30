// Codex CLI adapter: `codex exec --json`, read-only / workspace-write enforced by
// Codex's own OS sandbox (Seatbelt on macOS, Landlock on Linux), approvals off.
//
// The user's ~/.codex/config.toml is ignored (--ignore-user-config; auth still
// works): its MCP servers would run outside the sandbox and could have side
// effects in a read-only run, and its profiles could loosen the sandbox. The
// model is the target's, or Codex's own default. Models accept `#effort`
// (e.g. "codex:gpt-5.6-sol#low") for the reasoning effort.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, Mode, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('codex', 'PITROOM_CODEX_BIN');
const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

function cx(args: string[], timeout = 60_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, missing: !!r.error };
}

const SANDBOX: Record<Mode, string> = { read: 'read-only', write: 'workspace-write', isolate: 'workspace-write' };
const toml = (s: string) => JSON.stringify(s); // TOML basic strings share JSON's escaping

/** "gpt-5.6-sol#low" → model and reasoning effort. */
export function splitModel(model: string | undefined): { model?: string; effort?: string } {
  if (!model) return {};
  const [m, effort] = model.split('#');
  return { model: m || undefined, effort: effort || undefined };
}

function invocation(req: WorkerRequest) {
  const { model, effort } = splitModel(req.model);
  const args = ['exec'];
  if (req.sessionId) args.push('resume', req.sessionId); // resume takes no -s/-C: sandbox goes through -c
  args.push(
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-c', `sandbox_mode=${toml(SANDBOX[req.mode])}`,
    '-c', 'approval_policy="never"',
  );
  if (req.web) args.push('-c', 'web_search="live"');
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${toml(effort)}`);
  args.push(req.prompt);
  const { command, prefix } = resolveCommand(binary());
  return { command, args: [...prefix, ...args], env: {} as Record<string, string> };
}

export function classify(message: string): FailureKind {
  if (/not supported|model[^.]*(not found|does not exist|unknown|unavailable)|unsupported model|no such model/i.test(message)) {
    return 'model-unavailable';
  }
  if (/rate.?limit|too many requests|\b429\b|usage limit|quota|overloaded|\b50[23]\b|capacity/i.test(message)) return 'rate-limited';
  if (/unauthori[sz]ed|\b40[13]\b|not logged in|log ?in|api.?key|credits?\b|billing|subscription/i.test(message)) return 'auth';
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  const detail = stderr.split('\n').find((l) => /^Error[: ]|ERROR/.test(l) && !/rmcp|models cache/.test(l));
  const message = run.error ?? (detail ? detail.trim() : `codex exited with code ${exitCode}`);
  return { kind: classify(message), message };
}

/** The model a session used, from Codex's rollout file (the JSON stream does not say). */
function resolveModel(sessionId: string): string | undefined {
  const root = path.join(codexHome(), 'sessions');
  const day = (d: Date) => path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const now = new Date();
  for (const dir of [day(now), day(new Date(now.getTime() - 86_400_000))]) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.includes(sessionId));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /"model":"([^"]+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m) return m[1];
    }
  }
  return undefined;
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = cx(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `codex not runnable (${binary()}). Install: npm i -g @openai/codex, or set PITROOM_CODEX_BIN` }];
  }
  const checks: DoctorCheck[] = [{ level: 'ok', message: `${version.out.trim()} at ${binary()}` }];
  const login = cx(['login', 'status']);
  checks.push(
    login.ok && /logged in/i.test(login.out)
      ? { level: 'ok', message: `Codex: ${login.out.trim().split('\n')[0]}` }
      : { level: 'fail', message: 'Codex is not logged in: run `codex login`' },
  );
  for (const m of models) {
    checks.push({
      level: 'ok',
      message: m
        ? `Codex model: ${m} (checked on first use; unsupported models fail over)`
        : "Codex model: Codex's built-in default (your ~/.codex/config.toml is ignored for workers; pick one with -W codex:<model>)",
    });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Codex runs' });
  return checks;
}

export const codex: Backend = {
  id: 'codex',
  name: 'Codex',
  capabilities: { readOnly: 'os-sandbox', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  resolveModel,
  doctor,
};
