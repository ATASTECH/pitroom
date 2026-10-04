// Run notifications, for MCP clients that would rather be told than poll. A client that subscribed to a run's
// resource (resources/subscribe on pitroom://run/<id>, or its /patch) hears when that run changes state, or for a
// patch how many files it changed, and when it is gone (notifications/resources/updated); every client with an open
// channel hears when the newest run changes (notifications/resources/list_changed: several runs starting within one
// check are one notification). Read from the run records every two seconds, and only while some client can be told;
// a client without an open channel (an HTTP client with no event stream) is told once it opens one.
import { freshMeta, listRunIds } from '../core/store.js';
import { RpcError, runOfUri } from './mcp-extras.js';
import type { Session } from './mcp.js';

const EVERY_MS = 2000;
const MAX_SUBSCRIPTIONS = 100;
const watched = new Set<Session>();
let timer: NodeJS.Timeout | undefined;

/** What a subscriber hears about: the run's state, and for a patch also how many files it changed. */
const signature = (uri: string): string | undefined => {
  const id = runOfUri(uri);
  if (!id) return undefined;
  try {
    const m = freshMeta(id);
    return uri.endsWith('/patch') ? `${m.state}:${m.changes?.length ?? 0}` : m.state;
  } catch {
    return undefined; // gone (cleaned up) or unreadable
  }
};

const newestRun = (): string | undefined => {
  try {
    return listRunIds().at(-1);
  } catch {
    return undefined;
  }
};

export function subscribe(session: Session, uri: unknown): void {
  if (typeof uri !== 'string') throw new RpcError(-32602, '"uri" is required');
  if (!runOfUri(uri)) throw new RpcError(-32602, `only runs can be subscribed to (pitroom://run/<id>): ${uri}`);
  if (!session.subscriptions.has(uri) && session.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new RpcError(-32602, `at most ${MAX_SUBSCRIPTIONS} subscriptions: unsubscribe from finished runs first`);
  const sig = signature(uri);
  if (sig === undefined) throw new RpcError(-32002, `unknown resource: ${uri}`);
  session.subscriptions.set(uri, sig);
}

export function unsubscribe(session: Session, uri: unknown): void {
  if (typeof uri !== 'string') throw new RpcError(-32602, '"uri" is required');
  session.subscriptions.delete(uri);
}

function tick(): void {
  const listening = [...watched].filter((s) => s.push);
  if (!listening.length) return; // nobody to tell: nothing is read
  const newest = newestRun();
  const seen = new Map<string, string | undefined>(); // each run read once per tick, however many subscribe to it
  for (const s of listening) {
    const push = s.push!;
    if (newest !== s.newestRun) {
      s.newestRun = newest;
      push({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
    for (const [uri, last] of s.subscriptions) {
      if (!seen.has(uri)) seen.set(uri, signature(uri));
      const now = seen.get(uri);
      if (now === last) continue;
      // a run that is gone is told once, then forgotten
      if (now === undefined) s.subscriptions.delete(uri);
      else s.subscriptions.set(uri, now);
      push({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
    }
  }
}
/** Starts telling this session about runs. */
export function watch(session: Session): void {
  session.newestRun = newestRun();
  watched.add(session);
  if (!timer) {
    timer = setInterval(tick, EVERY_MS);
    timer.unref(); // never what keeps the process alive
  }
}

export function unwatch(session: Session): void {
  watched.delete(session);
  session.subscriptions.clear();
  if (!watched.size && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
