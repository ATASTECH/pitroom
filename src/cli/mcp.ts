// `pitroom mcp`: Pitroom as a Model Context Protocol server over stdio, so an agent that speaks MCP (Cursor, Claude
// Desktop, Gemini CLI, Codex, …) can call it as tools instead of running shell commands and reading skills.
//
// Every tool runs the matching `pitroom` command in a child process and returns its text, so the tools and the CLI
// cannot drift apart and every rule of the CLI (permission profiles, the git guard, isolation, snapshots) applies
// unchanged. A run is started in the background and waited for up to `waitSeconds`; a longer one comes back as
// "still running" with its id, and `pitroom_wait` collects it. Messages are one JSON object per line on stdin and
// stdout; nothing else is ever written to stdout (logs go to stderr).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { VERSION } from '../core/run.js';

type Json = Record<string, unknown>;
interface ToolResult {
  text: string;
  isError?: boolean;
}
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  call(args: Json): Promise<ToolResult>;
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_OUTPUT = 120_000;
const DEFAULT_WAIT = 50;
const MAX_WAIT = 540;

const INSTRUCTIONS = [
  'Pitroom hands bounded work to cheaper worker agents and returns a verified answer, the exact diff and a cost receipt. You decide, verify and answer.',
  'Use pitroom_run with mode "read" for research and locating code, mode "isolate" for code changes (the worker edits a copy; check it with pitroom_review, then pitroom_apply or pitroom_discard).',
  'A run can take minutes: pitroom_run waits up to waitSeconds, then returns the run id as "still running"; call pitroom_wait with it.',
  'It is optional: for a small task you can do yourself, skip it.',
].join(' ');

class ToolError extends Error {}

// ── argument helpers ──────────────────────────────────────────────────────────────────────────────

const str = (a: Json, key: string, required = false): string | undefined => {
  const v = a[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  return v;
};
const strs = (a: Json, key: string): string[] => {
  const v = a[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`"${key}" must be a list of strings`);
  return v as string[];
};
const bool = (a: Json, key: string): boolean => {
  const v = a[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" must be true or false`);
  return v;
};
const waitSeconds = (a: Json): number => {
  const v = a.waitSeconds;
  if (v === undefined || v === null) return DEFAULT_WAIT;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw new ToolError('"waitSeconds" must be a number of seconds, 1 or more');
  return Math.min(Math.round(v), MAX_WAIT);
};
const oneOf = <T extends string>(a: Json, key: string, allowed: readonly T[], fallback: T): T => {
  const v = str(a, key);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new ToolError(`"${key}" must be one of: ${allowed.join(', ')}`);
  return v as T;
};

/** The options every run-like tool shares, as CLI flags (`only` limits them to some). */
function workerFlags(a: Json, only?: string[]): string[] {
  const out: string[] = [];
  const on = (key: string) => !only || only.includes(key);
  const pairs: [string, string][] = [['worker', '-W'], ['model', '-m'], ['tier', '--tier'], ['effort', '--effort'], ['dir', '-d'], ['verify', '--verify'], ['group', '-g']];
  for (const [key, flag] of pairs) {
    const v = on(key) ? str(a, key) : undefined;
    if (v !== undefined) out.push(flag, v);
  }
  if (on('files')) for (const f of strs(a, 'files')) out.push('-f', f);
  const link = on('link') ? strs(a, 'link') : [];
  if (link.length) out.push('--link', link.join(','));
  if (on('web') && bool(a, 'web')) out.push('--web');
  return out;
}

// ── running the CLI ───────────────────────────────────────────────────────────────────────────────

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} more characters)` : s);

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

function pit(args: string[], timeoutMs = 60 * 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) return resolve({ code: 1, out: '', err: 'cannot locate the pitroom executable' });
    const child = spawn(process.execPath, [script, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => resolve({ code: 1, out, err: err || String(e.message) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: strip(out).trim(), err: strip(err).trim() });
    });
  });
}

/** The CLI's text as a tool result: usage mistakes and refusals (exit 2, 3) are errors, a failed run is a report. */
function asResult(r: Ran, still?: string): ToolResult {
  const text = [r.out, r.err && r.code !== 0 ? r.err : ''].filter(Boolean).join('\n\n') || '(no output)';
  if (r.code === 75 && still) return { text: clip(`${text}\n\n${still}`) };
  return { text: clip(text), isError: r.code === 2 || r.code === 3 || (r.code === 1 && !r.out) };
}

/** Starts a run (or review, audit) in the background and waits for it a while. */
async function startAndWait(start: string[], seconds: number, task?: string): Promise<ToolResult> {
  // the task goes last, after "--", so that it can start with a dash
  const started = await pit([...start, '--bg', '--json', ...(task === undefined ? [] : ['--', task])]);
  if (started.code !== 0) return asResult(started);
  let id: string;
  try {
    id = (JSON.parse(started.out) as { id: string }).id;
  } catch {
    return { text: `could not read the run id from: ${started.out.slice(0, 200)}`, isError: true };
  }
  return waitFor([id], seconds);
}

async function waitFor(ids: string[], seconds: number, group?: string): Promise<ToolResult> {
  const args = group ? ['wait', '-g', group, '--timeout', String(seconds)] : ['wait', ...ids, '--timeout', String(seconds)];
  const r = await pit(args, (seconds + 60) * 1000);
  const again = group ? `{"group": "${group}"}` : `{"runs": ${JSON.stringify(ids)}}`;
  return asResult(r, `Not finished yet: call pitroom_wait with ${again} (waitSeconds up to ${MAX_WAIT}); pitroom_stop ends it.`);
}

// ── the tools ─────────────────────────────────────────────────────────────────────────────────────

const WORKER_PROPS = {
  worker: { type: 'string', description: 'Worker target "backend[:model]", e.g. "opencode", "codex", "claude:haiku", "gemini:gemini-3.8-flash". Default: the configured worker.' },
  model: { type: 'string', description: 'Model for the preferred worker.' },
  tier: { type: 'string', description: 'A worker tier from the config: cheap, standard, capable (an explicit worker wins).' },
  effort: { type: 'string', description: 'Reasoning effort for the worker: low, medium, high, xhigh.' },
  dir: { type: 'string', description: 'Project directory (default: the directory the server was started in).' },
  files: { type: 'array', items: { type: 'string' }, description: 'Files to attach (paths).' },
  verify: { type: 'string', description: 'A command run after the worker finishes (e.g. "npm test"); a failing one is reported.' },
  link: { type: 'array', items: { type: 'string' }, description: 'Ignored directories to link into an isolated copy so tests can run (e.g. ["node_modules"]).' },
  web: { type: 'boolean', description: 'Let the worker use web tools.' },
  group: { type: 'string', description: 'A name to group related runs under.' },
};
const WAIT_PROP = { waitSeconds: { type: 'number', description: `How long to wait for the result before returning "still running" (default ${DEFAULT_WAIT}, at most ${MAX_WAIT}).` } };
const RUN_ID = { type: 'string', description: 'A run id as printed by a run, or "last".' };

const TOOLS: Tool[] = [
  {
    name: 'pitroom_run',
    title: 'Run a worker',
    description:
      'Hand a bounded task to a cheaper worker agent. mode "read" (default) is read-only research that returns an answer whose file:line references are verified; "isolate" lets the worker edit a private copy and returns the exact diff (review it, then pitroom_apply or pitroom_discard); "write" edits the working tree in place and is undoable with the CLI (`pitroom revert`). Returns the worker\'s answer and a receipt, or "still running" with the run id.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the worker should do, with the context it needs.' },
        mode: { type: 'string', enum: ['read', 'isolate', 'write'], description: 'read (default), isolate, or write.' },
        inPlace: { type: 'boolean', description: 'Read mode only: read the directory itself instead of a clean snapshot without secret-looking files.' },
        audit: { type: 'boolean', description: 'Read mode only: have another worker re-check the answer afterwards.' },
        ...WORKER_PROPS,
        ...WAIT_PROP,
      },
      required: ['task'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a) {
      const task = str(a, 'task', true)!;
      const mode = oneOf(a, 'mode', ['read', 'isolate', 'write'], 'read');
      const flags = mode === 'isolate' ? ['-i'] : mode === 'write' ? ['-w'] : [];
      if (mode === 'read') {
        if (bool(a, 'inPlace')) flags.push('--in-place');
        if (bool(a, 'audit')) flags.push('--audit');
      }
      return startAndWait(['run', ...flags, ...workerFlags(a)], waitSeconds(a), task);
    },
  },
  {
    name: 'pitroom_wait',
    title: 'Wait for runs',
    description: 'Wait for runs started earlier (a run that came back "still running") and return their reports.',
    inputSchema: {
      type: 'object',
      properties: { runs: { type: 'array', items: { type: 'string' }, description: 'Run ids.' }, group: { type: 'string', description: 'Or a group name.' }, ...WAIT_PROP },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async call(a) {
      const runs = strs(a, 'runs');
      const group = str(a, 'group');
      if (!runs.length && !group) throw new ToolError('give "runs" or "group"');
      return waitFor(runs, waitSeconds(a), runs.length ? undefined : group);
    },
  },
  {
    name: 'pitroom_status',
    title: 'Run status',
    description: 'The state and live progress of a run (default: the latest), or of a group.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string', description: 'A group name.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async call(a) {
      const group = str(a, 'group');
      const run = str(a, 'run');
      return asResult(await pit(['status', ...(group ? ['-g', group] : run ? [run] : [])], 60_000));
    },
  },
  {
    name: 'pitroom_show',
    title: 'Show a run',
    description: 'A finished run\'s report again; with patch the exact diff of an isolated change, with full the untruncated answer.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, patch: { type: 'boolean' }, full: { type: 'boolean' } }, required: ['run'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async call(a) {
      const run = str(a, 'run', true)!;
      return asResult(await pit(['show', run, ...(bool(a, 'patch') ? ['--patch'] : bool(a, 'full') ? ['--full'] : [])], 60_000));
    },
  },
  {
    name: 'pitroom_review',
    title: 'Review a change',
    description: 'A read-only reviewer (by default another worker than the implementer) judges one run\'s change, or a range of commits ("main..HEAD"). Returns findings with severities and a SPEC / QUALITY verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { ...RUN_ID, description: 'The run whose change to review (an isolated or in-place change).' },
        range: { type: 'string', description: 'Or a commit range "A..B".' },
        plan: { type: 'string', description: 'With range: the plan file the commits implement.' },
        worker: WORKER_PROPS.worker,
        tier: WORKER_PROPS.tier,
        dir: WORKER_PROPS.dir,
        group: WORKER_PROPS.group,
        ...WAIT_PROP,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a) {
      const run = str(a, 'run');
      const range = str(a, 'range');
      if (!run === !range) throw new ToolError('give exactly one of "run" or "range"');
      const plan = str(a, 'plan');
      const flags = workerFlags(a, ['worker', 'tier', 'dir', 'group']);
      return startAndWait(['review', ...(range ? ['--range', range, ...(plan ? ['--plan', plan] : [])] : [run!]), ...flags], waitSeconds(a));
    },
  },
  {
    name: 'pitroom_audit',
    title: 'Audit an answer',
    description: 'Another worker re-checks a finished read run\'s answer against the project and says AGREE, PARTIAL or DISAGREE with the claims it disputes.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, worker: WORKER_PROPS.worker, ...WAIT_PROP }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a) {
      const run = str(a, 'run', true)!;
      const worker = str(a, 'worker');
      return startAndWait(['audit', run, ...(worker ? ['-W', worker] : [])], waitSeconds(a));
    },
  },
  {
    name: 'pitroom_apply',
    title: 'Apply an isolated change',
    description: 'Land an isolated run\'s patch on the user\'s working tree (checked first; refused if it no longer applies cleanly). A patch that deletes files is refused unless allowDelete is true: only pass it after checking the deletions are what the user asked for.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' }, allowDelete: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a) {
      const group = str(a, 'group');
      const run = str(a, 'run');
      if (!run && !group) throw new ToolError('give "run" or "group"');
      return asResult(await pit(['apply', ...(group && !run ? ['-g', group] : [run!]), ...(bool(a, 'allowDelete') ? ['--allow-delete'] : [])], 120_000));
    },
  },
  {
    name: 'pitroom_discard',
    title: 'Discard an isolated change',
    description: 'Drop an isolated run\'s private copy (its patch is kept).',
    inputSchema: { type: 'object', properties: { run: RUN_ID }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a) {
      return asResult(await pit(['discard', str(a, 'run', true)!], 60_000));
    },
  },
  {
    name: 'pitroom_stop',
    title: 'Stop runs',
    description: 'Stop a running or queued run, or every run of a group.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a) {
      const run = str(a, 'run');
      const group = str(a, 'group');
      if (!run && !group) throw new ToolError('give "run" or "group"');
      return asResult(await pit(['stop', ...(run ? [run] : ['-g', group!])], 60_000));
    },
  },
];

// ── the protocol ──────────────────────────────────────────────────────────────────────────────────

const log = (msg: string): void => void process.stderr.write(`pitroom mcp: ${msg}\n`);
const send = (msg: Json): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function dispatch(method: string, params: Json): Promise<Json> {
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pitroom', title: 'Pitroom', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Json) : {};
      try {
        const r = await tool.call(args);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
        log(`${tool.name} failed: ${(e as Error).stack ?? e}`);
        return { content: [{ type: 'text', text: `pitroom: ${(e as Error).message}` }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

/** One incoming message: a response to send back, or nothing (a notification). */
async function handle(msg: unknown): Promise<Json | undefined> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  const m = msg as Json;
  if (typeof m.method !== 'string') return undefined; // a response from the client: nothing to do
  const isRequest = m.id !== undefined && m.id !== null;
  try {
    const result = await dispatch(m.method, m.params && typeof m.params === 'object' ? (m.params as Json) : {});
    return isRequest ? { jsonrpc: '2.0', id: m.id, result } : undefined;
  } catch (e) {
    if (!isRequest) return undefined;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id: m.id, error: { code, message: (e as Error).message } };
  }
}

async function handleLine(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const replies = (await Promise.all(parsed.map(handle))).filter((r): r is Json => !!r);
    if (replies.length) send(replies as unknown as Json);
    return;
  }
  const reply = await handle(parsed);
  if (reply) send(reply);
}

/** Serves MCP on stdin/stdout until the client closes the pipe. */
export async function serveMcp(): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin });
  const inflight = new Set<Promise<void>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const p = handleLine(line).catch((e) => log(String((e as Error).stack ?? e)));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  });
  await new Promise<void>((resolve) => rl.once('close', resolve));
  await Promise.allSettled([...inflight]);
  return 0;
}
