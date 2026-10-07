// Kilo Code adapter: `kilo run --format json` (the CLI of `@kilocode/cli`, checked against 7.8.8). Kilo's CLI is a fork
// of OpenCode with the same agents, permission rules and event stream, so this adapter reuses OpenCode's per-run
// permission profiles (injected through KILO_CONFIG_CONTENT; the user's config is never written) and its parser.
// Models are Kilo's `provider/model[#variant]` ids (`kilo models`).
//
// A private XDG_STATE_HOME is a safety requirement, like OpenCode's --standalone: when the user's `kilo daemon` is
// up, `kilo run` attaches to it (found through <state>/kilo/daemon.json), and the daemon, started with its own
// environment, ignores KILO_CONFIG_CONTENT, the git guard on PATH and PITROOM_ACTIVE (seen: "Agent not found:
// pitroom-read"; --port and --pure do not prevent it). With a state folder of its own the worker finds no daemon and
// starts a private server. Sign-in, config and sessions live in the data and config folders, which stay the user's.
// Never --auto ("auto-approve permissions that are not explicitly denied").
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { home } from '../../core/store.js';
import { findBinary, resolveCommand } from '../exec.js';
import { classify } from '../opencode/index.js';
import { parseEvents } from '../opencode/events.js';
import { AGENT, agentFor, configContent } from '../opencode/profiles.js';
import type { Backend, DoctorCheck, Failure, ModelCatalog, ParsedRun, WorkerRequest } from '../types.js';

const binary = () => findBinary('kilo', 'PITROOM_KILO_BIN', ['~/.kilo/bin/kilo']);

function kilo(args: string[], timeout = 60_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

function invocation(req: WorkerRequest) {
  const args = [
    'run',
    '--agent', agentFor(req.mode),
    '--format', 'json',
    '--title', req.title,
    // Some failure causes only appear in the server logs (Kilo takes the level in capitals only).
    '--print-logs', '--log-level', 'ERROR',
  ];
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--session', req.sessionId);
  for (const f of req.files) args.push('--file', f);
  args.push(req.prompt);
  const { command, prefix } = resolveCommand(binary());
  return {
    command,
    args: [...prefix, ...args],
    env: {
      // A worker run must not upgrade Kilo underneath the user.
      KILO_CONFIG_CONTENT: configContent(process.env.KILO_CONFIG_CONTENT, req.web, 'kilo', { autoupdate: false }),
      // No daemon to attach to: a private server per run (see above).
      XDG_STATE_HOME: path.join(home(), 'kilo-state'),
    },
  };
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `kilo exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify(message), message };
}

function listModels(): string[] {
  return kilo(['models']).out.split('\n').map((s) => s.trim()).filter((s) => /^[\w.-]+\/\S+$/.test(s));
}

function defaultModel(): string | undefined {
  try {
    const out = kilo(['debug', 'config'], 30_000).out;
    const model = JSON.parse(out.slice(out.indexOf('{'))).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

function catalog(): ModelCatalog {
  return { models: listModels().map((id) => ({ id })), source: '`kilo models` (reasoning variants are provider-specific: provider/model#variant)' };
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = kilo(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `kilo not runnable (${binary()}). Install Kilo Code's CLI (npm i -g @kilocode/cli), or set PITROOM_KILO_BIN` }];
  }
  const checks: DoctorCheck[] = [{ level: 'ok', message: `Kilo Code ${version.out.trim().split('\n').pop()} at ${binary()} (beta worker: checked against 7.8)` }];
  const def = defaultModel();
  for (const m of models) {
    const model = m ?? def;
    checks.push(model ? { level: 'ok', message: `Kilo Code ${m ? 'model' : 'default model'}: ${model}` } : { level: 'warn', message: 'Kilo Code has no default model: pass -W kilo:<provider/model> or set "model" in its config' });
  }
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Kilo Code runs' });
  checks.push({ level: 'ok', message: `permission profiles ${AGENT.read}/${AGENT.write} injected per run through KILO_CONFIG_CONTENT` });
  return checks;
}

export const kiloBackend: Backend = {
  id: 'kilo',
  name: 'Kilo Code',
  capabilities: { readOnly: 'permission-rules', resume: 'by-id', reportsCost: true, attachFiles: true },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  listModels,
  catalog,
  doctor,
};
