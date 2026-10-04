// `pitroom mcp --http`: the same MCP server as on stdio, over Streamable HTTP (one endpoint, POST /mcp), for clients
// that connect to a URL instead of starting a process. It is a local service: it listens on 127.0.0.1 only, wants
// a bearer token (anyone who has it can run workers as you), and refuses requests whose Host or Origin is not
// local (a web page in your browser cannot use it). Sessions are kept per client, because a cancel names a request
// id that is only unique within one client. A call that asks for progress is answered as an event stream (progress
// events, then the result); every other call is answered with plain JSON. Ending a session (DELETE, or stopping the
// server) ends the waiting, not the runs: they go on, and pitroom_wait or the CLI collects them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LOCAL_HOST } from '../core/dash.js';
import { UserError } from '../core/errors.js';
import { home } from '../core/store.js';
import { type Session, endSession, handlePayload, newSession, parseError, progressToken } from './mcp.js';
import type { Json } from './mcp-support.js';

export const DEFAULT_PORT = 7117;
const MAX_BODY = 4_000_000;
const MAX_SESSIONS = 64;
const IDLE_MS = 60 * 60_000;
const PATH = '/mcp';

export const tokenFile = () => path.join(home(), 'mcp-token');

const readToken = (file: string): string | undefined => {
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    return kept.length >= 16 ? kept : undefined;
  } catch {
    return undefined;
  }
};

/** The bearer token: PITROOM_MCP_TOKEN, else the one kept in Pitroom's state directory (made on first use, 0600). */
export function mcpToken(): { token: string; from: string } {
  const env = process.env.PITROOM_MCP_TOKEN?.trim();
  if (env) {
    if (env.length < 16) throw new UserError('PITROOM_MCP_TOKEN is too short to be a secret (16 characters at least)', 3);
    return { token: env, from: 'PITROOM_MCP_TOKEN' };
  }
  const file = tokenFile();
  let token = readToken(file);
  if (!token) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    token = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // made by a server starting at the same moment (use that one, so neither invalidates the other's clients),
      // or a file that holds no token
      token = readToken(file);
      if (!token) throw new UserError(`${file} holds no usable token: delete it and start again`, 3);
    }
  }
  try {
    fs.chmodSync(file, 0o600); // a file made or copied by hand may be readable by others
  } catch {
    // not ours to change: it still works
  }
  return { token, from: file };
}

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

const sameSecret = (given: string, token: string): boolean => {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
};

interface Kept {
  session: Session;
  lastSeen: number;
}

function reply(res: http.ServerResponse, status: number, body?: Json | Json[], headers: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
const failure = (code: number, message: string): Json => ({ jsonrpc: '2.0', id: null, error: { code, message } });

/** The request body; past the limit the rest is read and dropped, so that the answer still reaches the client. */
function readBody(req: http.IncomingMessage): Promise<string | 'too-big'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY ? 'too-big' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Does the payload hold a request that asked for progress (so it is answered as an event stream)? */
const wantsStream = (parsed: unknown): boolean => {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some((m) => m && typeof m === 'object' && (m as Json).id !== undefined && (m as Json).id !== null && progressToken((m as Json).params) !== undefined);
};

/** Makes room for a new session by dropping the one unused longest, if one has nothing in flight. */
function evictIdle(sessions: Map<string, Kept>): boolean {
  let oldest: [string, Kept] | undefined;
  for (const entry of sessions) if (!entry[1].session.inflight.size && (!oldest || entry[1].lastSeen < oldest[1].lastSeen)) oldest = entry;
  if (!oldest) return false;
  sessions.delete(oldest[0]);
  return true;
}

function makeHandler(token: string, sessions: Map<string, Kept>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== PATH) return reply(res, 404, failure(-32600, `not found: the endpoint is ${PATH}`));
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply(res, 403, failure(-32600, 'forbidden host'));
    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return reply(res, 403, failure(-32600, 'forbidden origin'));
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!auth || !sameSecret(auth, token)) return reply(res, 401, failure(-32001, 'a bearer token is needed'), { 'WWW-Authenticate': 'Bearer' });

    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    if (req.method === 'DELETE') {
      const kept = sid ? sessions.get(sid) : undefined;
      if (!kept) return reply(res, 404, failure(-32600, 'no such session'));
      endSession(kept.session);
      sessions.delete(sid!);
      return reply(res, 204);
    }
    if (req.method !== 'POST') return reply(res, 405, failure(-32600, 'POST requests only'), { Allow: 'POST, DELETE' });

    const body = await readBody(req);
    if (body === 'too-big') return reply(res, 413, failure(-32600, `a request body is at most ${MAX_BODY} bytes`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(res, 400, parseError());
    }

    const headers: Record<string, string> = {};
    let kept: Kept | undefined;
    const single = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : undefined;
    if (single?.method === 'initialize') {
      // a client that starts over and still sends its old session id: that one is done
      const old = sid ? sessions.get(sid) : undefined;
      if (old) {
        endSession(old.session);
        sessions.delete(sid!);
      }
      if (sessions.size >= MAX_SESSIONS && !evictIdle(sessions)) return reply(res, 503, failure(-32000, 'too many sessions with requests in flight'));
      const id = crypto.randomUUID();
      kept = { session: newSession(), lastSeen: Date.now() };
      sessions.set(id, kept);
      headers['Mcp-Session-Id'] = id;
    } else {
      if (!sid) return reply(res, 400, failure(-32600, 'Mcp-Session-Id is missing: initialize first'));
      kept = sessions.get(sid);
      if (!kept) return reply(res, 404, failure(-32600, 'no such session: initialize again'));
    }
    kept.lastSeen = Date.now();

    if (!wantsStream(parsed)) {
      const out = await handlePayload(kept.session, parsed, () => {});
      kept.lastSeen = Date.now();
      return out === undefined ? reply(res, 202, undefined, headers) : reply(res, 200, out, headers);
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
    const event = (msg: Json | Json[]) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    };
    const out = await handlePayload(kept.session, parsed, event);
    if (out !== undefined) event(out);
    kept.lastSeen = Date.now();
    res.end();
  };
}

/** Serves MCP over HTTP on 127.0.0.1 until interrupted. `port` 0 picks a free one. */
export async function serveMcpHttp(opts: { port: number }): Promise<number> {
  const { token, from } = mcpToken();
  const sessions = new Map<string, Kept>();
  const handler = makeHandler(token, sessions);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      process.stderr.write(`pitroom mcp: ${String((e as Error).stack ?? e)}\n`);
      reply(res, 500, failure(-32603, 'internal error'));
    });
  });
  const sweep = setInterval(() => {
    for (const [id, k] of sessions) if (Date.now() - k.lastSeen > IDLE_MS && !k.session.inflight.size) sessions.delete(id);
  }, 60_000);
  sweep.unref();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new UserError(`port ${opts.port} is in use: pick another with --port N (0 picks a free one)`, 3) : e));
    server.listen(opts.port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  const url = `http://127.0.0.1:${port}${PATH}`;
  const secret = from === 'PITROOM_MCP_TOKEN' ? '$PITROOM_MCP_TOKEN' : `$(cat "${from}")`;
  console.log(`pitroom mcp: listening on ${url} (127.0.0.1 only; token from ${from})`);
  console.log(`  working in ${process.cwd()} (-d DIR starts it in another project; the tools' "dir" argument picks one per call)`);
  console.log(`  Claude Code: claude mcp add --transport http pitroom ${url} --header "Authorization: Bearer ${secret}"`);
  console.log('  other clients: URL as above, header "Authorization: Bearer <the token>"');
  console.log('  anyone with the token can run workers as you: keep it private');

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearInterval(sweep);
  // the waits end; the runs go on and can be collected later
  for (const k of sessions.values()) endSession(k.session);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}
