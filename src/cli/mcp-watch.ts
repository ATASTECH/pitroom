// Run notifications, for MCP clients that would rather be told than poll. A client that subscribed to a run's
// resource (resources/subscribe on pitroom://run/<id> or its /patch) hears when that run changes state
// (notifications/resources/updated), and every client with an open channel hears when a run starts or goes away
// (notifications/resources/list_changed). Read from the run records every two seconds while any client is watched;
// a client without an open channel (an HTTP client with no event stream) is told once it opens one.
import { freshMeta, listRunIds } from '../core/store.js';
import { RpcError, runOfUri } from './mcp-extras.js';
import type { Session } from './mcp.js';

const EVERY_MS = 2000;
const watched = new Set<Session>();
let timer: NodeJS.Timeout | undefined;

const stateOf = (id: string): string | undefined => {
  try {
    return freshMeta(id).state;
  } catch {
    return undefined;
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
  const id = runOfUri(uri);
  if (!id) throw new RpcError(-32602, `only runs can be subscribed to (pitroom://run/<id>): ${uri}`);
  const state = stateOf(id);
  if (state === undefined) throw new RpcError(-32002, `unknown resource: ${uri}`);
  session.subscriptions.set(uri, state);
}

export function unsubscribe(session: Session, uri: unknown): void {
  if (typeof uri !== 'string') throw new RpcError(-32602, '"uri" is required');
  session.subscriptions.delete(uri);
}

function tick(): void {
  const newest = newestRun();
  for (const s of watched) {
    if (!s.push) continue; // kept as it is: told when a channel opens
    if (newest !== s.newestRun) {
      s.newestRun = newest;
      s.push({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
    for (const [uri, last] of s.subscriptions) {
      const now = stateOf(runOfUri(uri)!);
      if (now === undefined || now === last) continue;
      s.subscriptions.set(uri, now);
      s.push({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
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
