// Optional user config: $XDG_CONFIG_HOME/pitroom/config.json (default ~/.config/pitroom/config.json).
// Precedence everywhere: command-line flag > PITROOM_* env > this file > the worker CLI's own default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BACKEND } from '../backends/index.js';

export interface PitroomConfig {
  /** Preferred worker target, "backend[:model]" (default "opencode"). */
  worker?: string;
  /** Targets tried in order when the worker's model/provider fails. */
  fallback?: string[];
  timeout?: string;
  primary?: string;
  price?: string;
  link?: string[];
  web?: boolean;
  /** Workers talking to models at once; more runs wait in a queue (default 4). */
  maxParallel?: number;
  /** Default model per worker, used when a target names none: {"codex": "gpt-5.6-sol"}. */
  models?: Record<string, string>;
  /** Worker targets by tier, for --tier and plan tasks: {"cheap": "opencode", "capable": "claude"}. */
  tiers?: Record<string, string>;
  /** Where read runs read: "auto" (a clean snapshot when the directory holds secret-looking files), "snapshot" or "project". */
  readIn?: string;
  /** Chance (0 to 1) that a finished read run is re-checked by another worker in the background (default 0: off). */
  audit?: number;
  /** Days an answer may be reused for the same read question on the same code (default 7; 0 turns the cache off). */
  cacheDays?: number;
  /** Your relative cost per model, keyed "backend:model": {"codex:gpt-6-sol": 1, "codex:gpt-6.1-sol": 2}. Any unit; it is only compared. */
  costs?: Record<string, number>;
}

const SCHEMA: Record<keyof PitroomConfig, 'string' | 'string[]' | 'boolean' | 'number' | 'record' | 'numbers'> = {
  worker: 'string',
  fallback: 'string[]',
  timeout: 'string',
  primary: 'string',
  price: 'string',
  link: 'string[]',
  web: 'boolean',
  maxParallel: 'number',
  models: 'record',
  tiers: 'record',
  costs: 'numbers',
  audit: 'number',
  readIn: 'string',
  cacheDays: 'number',
};

export function configPath(): string {
  if (process.env.PITROOM_CONFIG) return path.resolve(process.env.PITROOM_CONFIG);
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return path.join(base, 'pitroom', 'config.json');
}

let cached: { config: PitroomConfig; warnings: string[] } | undefined;

export function loadConfig(): { config: PitroomConfig; warnings: string[] } {
  if (cached) return cached;
  const file = configPath();
  const config: PitroomConfig = {};
  const warnings: string[] = [];
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      warnings.push(`${file}: invalid JSON (${(e as Error).message}); ignored`);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const type = SCHEMA[key as keyof PitroomConfig];
        if (!type) {
          warnings.push(`${file}: unknown key "${key}" ignored`);
        } else if (matches(value, type)) {
          (config as Record<string, unknown>)[key] = value;
        } else {
          warnings.push(`${file}: "${key}" must be ${type}; ignored`);
        }
      }
    }
  }
  cached = { config, warnings };
  return cached;
}

function matches(v: unknown, type: string): boolean {
  if (type === 'string[]') return Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (type === 'record') {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((s) => typeof s === 'string');
  }
  if (type === 'numbers') {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  }
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return typeof v === type;
}

export type Source = 'flag' | 'env' | 'config' | 'default';

export interface Setting<T> {
  value: T;
  source: Source;
}

/** Workers that run at once when nothing says otherwise, and the most any setting can ask for. */
export const DEFAULT_PARALLEL = 20;
export const MAX_PARALLEL_LIMIT = 30;
const clampParallel = (s: Setting<number>): Setting<number> => ({ ...s, value: Math.min(s.value, MAX_PARALLEL_LIMIT) });

const positiveInt = (v: unknown) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** An audit chance: 0 to 1. */
const rate = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n, 1) : undefined;
};

/** A whole number of days, 0 or more. */
const days = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
};

const readIn = (v: unknown) => (v === 'auto' || v === 'snapshot' || v === 'project' ? v : undefined);

const list = (s: string | undefined) => s?.split(',').map((x) => x.trim()).filter(Boolean);

export function setting<T>(flag: T | undefined, env: T | undefined, conf: T | undefined, fallback: T): Setting<T> {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  if (env !== undefined) return { value: env, source: 'env' };
  if (conf !== undefined) return { value: conf, source: 'config' };
  return { value: fallback, source: 'default' };
}

/** Every effective setting with where it came from (for `pitroom config`). */
export function effective(flags: { worker?: string; model?: string; timeout?: string } = {}) {
  const c = loadConfig().config;
  const e = process.env;
  return {
    worker: setting<string>(flags.worker, e.PITROOM_WORKER, c.worker, DEFAULT_BACKEND),
    /** Overrides the model of the preferred worker only. */
    model: setting<string | undefined>(flags.model, e.PITROOM_MODEL, undefined, undefined),
    fallback: setting<string[]>(undefined, list(e.PITROOM_FALLBACK), c.fallback, []),
    timeout: setting<string>(flags.timeout, e.PITROOM_TIMEOUT, c.timeout, '30m'),
    primary: setting<string>(undefined, e.PITROOM_PRIMARY, c.primary, 'sonnet'),
    price: setting<string | undefined>(undefined, e.PITROOM_PRICE, c.price, undefined),
    link: setting<string[]>(undefined, undefined, c.link, []),
    web: setting<boolean>(undefined, undefined, c.web, false),
    maxParallel: clampParallel(setting<number>(undefined, positiveInt(e.PITROOM_MAX_PARALLEL), positiveInt(c.maxParallel), DEFAULT_PARALLEL)),
    models: setting<Record<string, string>>(undefined, undefined, c.models, {}),
    tiers: setting<Record<string, string>>(undefined, undefined, c.tiers, {}),
    costs: setting<Record<string, number>>(undefined, undefined, c.costs, {}),
    audit: setting<number>(undefined, rate(e.PITROOM_AUDIT), rate(c.audit), 0),
    readIn: setting<string>(undefined, readIn(e.PITROOM_READ_IN), readIn(c.readIn), 'auto'),
    cacheDays: setting<number>(undefined, days(e.PITROOM_CACHE_DAYS), days(c.cacheDays), 7),
  };
}
