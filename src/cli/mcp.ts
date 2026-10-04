// `pitroom mcp`: Pitroom as a Model Context Protocol server over stdio, so an agent that speaks MCP (Cursor, Claude
// Desktop, Gemini CLI, Codex, …) can call it as tools instead of running shell commands and reading skills.
//
// Every tool runs the matching `pitroom` command in a child process and returns its text, so the tools and the CLI
// cannot drift apart and every rule of the CLI (permission profiles, the git guard, isolation, snapshots) applies
// unchanged. A run is started in the background and waited for up to `waitSeconds` (with progress notifications
// while it waits, when the client asks for them); a longer one comes back as "still running" with its id, and
// `pitroom_wait` collects it. A client that cancels a request stops what the request started. The runs are also
// resources, and a few prompts say how to use Pitroom. Messages are one JSON object per line on stdin and stdout;
// nothing else is ever written to stdout (logs go to stderr).
import readline from 'node:readline';
import { VERSION } from '../core/run.js';
import { RpcError, getPrompt, listPrompts, listResources, readResource, resourceTemplates } from './mcp-extras.js';
import { type Ctx, type Json, ToolError } from './mcp-support.js';
import { TOOLS } from './mcp-tools.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Pitroom hands bounded work to cheaper worker agents and returns a verified answer, the exact diff and a cost receipt. You decide, verify and answer.',
  'Use pitroom_run with mode "read" for research and locating code, mode "isolate" for code changes (the worker edits a copy; check it with pitroom_review, then pitroom_apply or pitroom_discard); pitroom_crew for independent tasks in parallel.',
  'A run can take minutes: pitroom_run waits up to waitSeconds, then returns the run id as "still running"; call pitroom_wait with it.',
  'It is optional: for a small task you can do yourself, skip it.',
].join(' ');

const log = (msg: string): void => void process.stderr.write(`pitroom mcp: ${msg}\n`);
// a client that went away mid-run leaves a closed pipe: the writes then fail, which is not worth a crash
process.stdout.on('error', () => {});
const send = (msg: Json): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);

/** One request being served: its cancel switch and the progress it may report. */
interface Inflight {
  abort: AbortController;
  ctx: Ctx;
}
const inflight = new Map<string | number, Inflight>();

/** Progress for one request, only when the client sent a progress token with it. */
function contextFor(params: Json, abort: AbortController): Ctx {
  const meta = params._meta && typeof params._meta === 'object' ? (params._meta as Json) : {};
  const token = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : undefined;
  let n = 0;
  return {
    signal: abort.signal,
    progress: (message) => {
      if (token === undefined || abort.signal.aborted) return;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } });
    },
  };
}

async function dispatch(method: string, params: Json, ctx: Ctx): Promise<Json> {
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
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
        const r = await tool.call(args, ctx);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
        log(`${tool.name} failed: ${(e as Error).stack ?? e}`);
        return { content: [{ type: 'text', text: `pitroom: ${(e as Error).message}` }], isError: true };
      }
    }
    case 'resources/list':
      return listResources();
    case 'resources/templates/list':
      return resourceTemplates();
    case 'resources/read':
      if (typeof params.uri !== 'string') throw new RpcError(-32602, '"uri" is required');
      return readResource(params.uri, ctx);
    case 'prompts/list':
      return listPrompts();
    case 'prompts/get':
      return getPrompt(params.name, params.arguments);
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

/** The client no longer wants the answer to a request: end what it started, and send nothing back. */
function cancel(params: Json): void {
  const id = params.requestId;
  if (typeof id !== 'string' && typeof id !== 'number') return;
  inflight.get(id)?.abort.abort('cancelled');
}

/** One incoming message: a response to send back, or nothing (a notification, or a cancelled request). */
async function handle(msg: unknown): Promise<Json | undefined> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  const m = msg as Json;
  if (typeof m.method !== 'string') return undefined; // a response from the client: nothing to do
  const params = m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? (m.params as Json) : {};
  if (m.method === 'notifications/cancelled') {
    cancel(params);
    return undefined;
  }
  // a request has a string or number id; a null id is treated like a notification (JSON-RPC discourages it)
  const isRequest = typeof m.id === 'string' || typeof m.id === 'number';
  const abort = new AbortController();
  const entry: Inflight = { abort, ctx: contextFor(params, abort) };
  if (isRequest) inflight.set(m.id as string | number, entry);
  try {
    const result = await dispatch(m.method, params, entry.ctx);
    if (abort.signal.aborted && abort.signal.reason === 'cancelled') return undefined;
    return isRequest ? { jsonrpc: '2.0', id: m.id, result } : undefined;
  } catch (e) {
    if (!isRequest || (abort.signal.aborted && abort.signal.reason === 'cancelled')) return undefined;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id: m.id, error: { code, message: (e as Error).message } };
  } finally {
    if (isRequest && inflight.get(m.id as string | number) === entry) inflight.delete(m.id as string | number);
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
  const pending = new Set<Promise<void>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const p = handleLine(line).catch((e) => log(String((e as Error).stack ?? e)));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  await new Promise<void>((resolve) => rl.once('close', resolve));
  // a client that sent its requests and closed the pipe (`printf … | pitroom mcp`) still gets the answers
  await Promise.allSettled([...pending]);
  return 0;
}
