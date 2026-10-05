// Cooldowns: a model that just said "rate limited" (a daily quota is used up, the provider is overloaded) is
// remembered for a while, so the next runs go straight to the fallback instead of each one trying the exhausted
// model first and waiting for it to fail. Kept in <pitroom home>/cooldowns.json. The time comes from the
// provider's own message when it gives one ("retry in 4h28m"), else a guess by the kind of limit. A cooldown only
// skips a target while a fallback is left to run, and it expires on its own; `pitroom cooldown --clear` drops them.
import fs from 'node:fs';
import path from 'node:path';
import type { Backend, Target } from '../backends/types.js';
import { renameOver } from './fs-atomic.js';
import { home } from './store.js';

export interface Cooldown {
  /** When the target may be tried again (ISO time). */
  until: string;
  /** What the provider said, shortened. */
  reason: string;
  /** What the target was called when it failed, for display. */
  target: string;
}

const MAX_MS = 24 * 3_600_000;
const OVERLOAD_MS = 20 * 60_000;
const DAILY_MS = 4 * 3_600_000;

const file = () => path.join(home(), 'cooldowns.json');

/** The key of a target: its backend and model, the CLI's own default model when none is named. */
export function cooldownKey(target: Target, backend: Backend): string {
  const model = (target.model ?? backend.defaultModel?.() ?? '').split('#')[0];
  return `${target.backend}:${model}`;
}

/** How long a provider's message says to wait ("retry in 4h28m23s", "try again in 30 seconds"), in ms. */
export function retryAfterMs(message: string): number | undefined {
  const compact = /(?:retry|try again|resets?|available again)[^0-9]{0,24}((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i.exec(message)?.[1];
  const words = /(?:retry|try again|resets?)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i.exec(message);
  let ms = 0;
  if (compact) {
    for (const [, n, unit] of compact.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(n) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit!.toLowerCase() as 'd' | 'h' | 'm' | 's'];
  } else if (words) {
    ms = Number(words[1]) * { second: 1000, minute: 60_000, hour: 3_600_000 }[words[2]!.toLowerCase() as 'second' | 'minute' | 'hour'];
  }
  return ms > 0 ? ms : undefined;
}

/** How long to leave a model alone after this failure message. */
export function cooldownMs(message: string): number {
  const told = retryAfterMs(message);
  if (told !== undefined) return Math.min(Math.max(told, 60_000), MAX_MS);
  return /daily|per.?day|per day|exhausted your/i.test(message) ? DAILY_MS : OVERLOAD_MS;
}

function read(): Record<string, Cooldown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, Cooldown>;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, Cooldown>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameOver(tmp, file());
}

/** The cooldowns still running. */
export function activeCooldowns(now = Date.now()): Record<string, Cooldown> {
  return Object.fromEntries(Object.entries(read()).filter(([, c]) => Date.parse(c.until) > now));
}

export const activeCooldown = (key: string, now = Date.now()): Cooldown | undefined => activeCooldowns(now)[key];

/** Remembers that this target is rate limited. Best effort: a cooldown is a convenience, never a reason to fail a run. */
export function recordCooldown(key: string, targetName: string, message: string, now = Date.now()): void {
  try {
    const all = activeCooldowns(now);
    all[key] = { until: new Date(now + cooldownMs(message)).toISOString(), reason: message.replace(/\s+/g, ' ').trim().slice(0, 160), target: targetName };
    write(all);
  } catch {
    // not remembered
  }
}

/** Drops every cooldown (or one key); the number dropped. */
export function clearCooldowns(key?: string): number {
  const all = read();
  const keys = key ? Object.keys(all).filter((k) => k === key) : Object.keys(all);
  for (const k of keys) delete all[k];
  if (keys.length) write(all);
  return keys.length;
}

/** "until 14:05", or with the date when it is not today. */
export function untilText(c: Cooldown, now = Date.now()): string {
  const d = new Date(c.until);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? `until ${time}` : `until ${d.toLocaleDateString()} ${time}`;
}
