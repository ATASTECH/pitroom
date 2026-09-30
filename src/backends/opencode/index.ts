// OpenCode adapter (OpenCode v2+): `opencode run --standalone --format json`, with
// per-run permission profiles injected through OPENCODE_CONFIG_CONTENT (the user's
// config is never written). Models are OpenCode's `provider/model[#variant]` ids.
//
// --standalone is a safety requirement, not an optimisation: without it `run`
// attaches to OpenCode's shared background service, which was started with its
// own environment, so the injected profiles and the git guard on PATH would not
// apply to the worker at all.
import { spawnSync } from 'node:child_process';
import { findBinary, resolveCommand } from '../exec.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ModelCatalog, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';
import { AGENT, agentFor, configContent } from './profiles.js';

const binary = () => findBinary('opencode', 'PITROOM_OPENCODE_BIN', ['~/.opencode/bin/opencode']);

function oc(args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

const jsonIn = (s: string) => JSON.parse(s.slice(s.indexOf('{')));

function invocation(req: WorkerRequest) {
  // The worker's directory is the process cwd (set by the core); v2 has no --dir.
  const args = [
    'run',
    '--standalone',
    '--agent', agentFor(req.mode),
    '--format', 'json',
    '--title', req.title,
    // Some failure causes only appear in the server logs.
    '--print-logs', '--log-level', 'error',
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
      OPENCODE_CONFIG_CONTENT: configContent(process.env.OPENCODE_CONFIG_CONTENT, req.web),
      // A worker run must not upgrade OpenCode underneath the user.
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
  };
}

/** Major version from `opencode --version` ("opencode v2.0.20", "1.18.33"). */
export function majorVersion(output: string): number | undefined {
  const m = /(\d+)\.\d+\.\d+/.exec(output);
  return m ? Number(m[1]) : undefined;
}

export function classify(message: string): FailureKind {
  if (/model not found|ModelNotFound|unknown model|no such model|deprecated/i.test(message)) return 'model-unavailable';
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded|\b50[23]\b|unavailable|capacity/i.test(message)) return 'rate-limited';
  // v2: "provider.auth" / HTTP 403 FreeTierError ("free tier can only be used from within OpenCode").
  if (/provider\.auth|FreeTierError|free tier|unauthori[sz]ed|\b40[13]\b|api.?key|insufficient|credits?\b|billing|payment/i.test(message)) {
    return 'auth';
  }
  return 'other';
}

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  if (exitCode === 0 && !run.error) return undefined;
  // `opencode run` reports "Unexpected server error"; the cause is in the ERROR log line.
  const detail = stderr.match(/error="([^"]+)"/g)?.pop()?.slice(7, -1);
  const raw = run.error ?? `opencode exited with code ${exitCode}`;
  const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;
  return { kind: classify(message), message };
}

/** "provider/model" from a v2 model object ({providerID, model|id}) or a v1 string. */
function modelId(m: any): string | undefined {
  if (typeof m === 'string') return m;
  const id = m?.model ?? m?.id;
  return m?.providerID && id ? `${m.providerID}/${id}` : undefined;
}

function defaultModel(): string | undefined {
  try {
    const out = oc(['debug', 'config'], { timeout: 30_000 }).out;
    const json = JSON.parse(out.slice(out.search(/[[{]/)));
    // v2: a list of config sources (later sources win); v1: the resolved config.
    if (Array.isArray(json)) {
      const withModel = json.filter((s: any) => s?.info?.model);
      return modelId(withModel[withModel.length - 1]?.info.model);
    }
    return modelId(json.model);
  } catch {
    return undefined;
  }
}

function resolveModel(sessionId: string): string | undefined {
  try {
    const json = jsonIn(oc(['session', 'export', sessionId], { timeout: 20_000 }).out);
    const msgs = [...(json.messages ?? [])].reverse();
    // v2: {type: "assistant", model: {providerID, id}}; v1: {info: {role, providerID, modelID}}
    const v2 = msgs.find((m: any) => m.type === 'assistant' && m.model)?.model;
    if (v2) return modelId(v2);
    const v1 = msgs.find((m: any) => m.info?.role === 'assistant')?.info;
    return v1?.providerID && v1?.modelID ? `${v1.providerID}/${v1.modelID}` : undefined;
  } catch {
    return undefined;
  }
}

function catalog(): ModelCatalog {
  // The first call can come back empty while OpenCode's background service starts: ask once more.
  const ids = listModels();
  return {
    models: (ids.length ? ids : listModels()).map((id) => ({ id })),
    source: '`opencode models` (reasoning variants are provider-specific: provider/model#variant)',
  };
}

function listModels(): string[] {
  return oc(['models']).out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const version = oc(['--version']);
  if (version.missing || !version.ok) {
    return [{ level: 'fail', message: `opencode not runnable (${binary()}). Install: https://opencode.ai or set PITROOM_OPENCODE_BIN` }];
  }
  const v = version.out.trim().replace(/^opencode\s+/i, '');
  const major = majorVersion(v);
  if (major !== undefined && major < 2) {
    return [{ level: 'fail', message: `OpenCode ${v} is too old: Pitroom needs OpenCode v2 or newer (run \`opencode upgrade\`)` }];
  }
  checks.push({ level: 'ok', message: `opencode ${v} at ${binary()} (private --standalone server per run)` });

  const known = new Set(listModels());
  const def = defaultModel();
  for (const m of models) {
    const model = m ?? def;
    const label = m ? 'model' : 'default model';
    if (!model) {
      checks.push({ level: 'warn', message: 'OpenCode has no default model; it will pick one (set "model" in opencode.json)' });
    } else if (known.size && !known.has(model)) {
      checks.push({ level: 'fail', message: `OpenCode ${label} "${model}" is not in \`opencode models\`` });
    } else {
      checks.push({ level: 'ok', message: `OpenCode ${label}: ${model}` });
    }
  }
  if (!hasFallback) {
    // A suggestion from the user's own catalogue; Pitroom never picks models by itself.
    const free = [...known].filter((m) => /-free$/.test(m) && m !== def).slice(0, 4);
    checks.push({
      level: 'warn',
      message: `no fallback workers: if the model is rate-limited or removed, runs fail.${free.length ? ` Free OpenCode models you have: ${free.join(', ')}` : ''}`,
    });
  }
  // v2 only loads injected config into a private server, so the profiles can only be
  // proven by a real run: `pitroom doctor --probe` runs one on the read-only profile.
  checks.push({ level: 'ok', message: `permission profiles ${AGENT.read}/${AGENT.write} injected per run (verify: pitroom doctor --probe)` });
  return checks;
}

export const opencode: Backend = {
  id: 'opencode',
  name: 'OpenCode',
  capabilities: { readOnly: 'permission-rules', resume: 'by-id', reportsCost: true, attachFiles: true },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  defaultModel,
  resolveModel,
  listModels,
  catalog,
  doctor,
};
