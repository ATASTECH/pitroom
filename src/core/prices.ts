// A price catalog that keeps itself up to date, opt-in (config `priceFeed`, env PITROOM_PRICE_FEED=1). It is the public
// models.dev list (the one OpenCode reads its models from): per model, USD per 1M tokens for input, output and cached input.
// Pitroom asks for that one file with a plain GET, sends nothing about you or your work, keeps a trimmed copy in its state
// directory, and refreshes it at most once a day, in a background process after a run, never while a run waits. It is only a
// fallback: your own `workerPrices` come first, and without the feed Pitroom knows no vendor prices.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { effective } from './config.js';
import { renameOver } from './fs-atomic.js';
import { home } from './store.js';

export type Triple = [input: number, output: number, cachedInput: number];

export interface Catalog {
  fetchedAt: string;
  source: string;
  /** `provider/model` → USD per 1M tokens. */
  models: Record<string, Triple>;
}

export const DEFAULT_URL = 'https://models.dev/api.json';
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const MIN_MODELS = 100; // a catalog with fewer is not the catalog: keep the old one

/** Where the numbers came from, for a receipt: models.dev, or the host of the mirror the user set. */
export function catalogLabel(): string {
  const url = effective().priceFeedUrl.value;
  if (url === DEFAULT_URL) return 'models.dev';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const catalogFile = () => path.join(home(), 'prices.json');
const attemptFile = () => path.join(home(), 'prices.attempt');

/** What models.dev publishes, cut down to what is used: `provider/model` and three prices. */
export function trim(raw: unknown): Record<string, Triple> {
  const out: Record<string, Triple> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [provider, p] of Object.entries(raw as Record<string, { models?: Record<string, { cost?: Record<string, unknown> }> }>)) {
    for (const [id, m] of Object.entries(p?.models ?? {})) {
      const c = m?.cost;
      // numbers from a server are checked like the ones a user types: finite, not negative (1e999 is Infinity in JSON)
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (!c || !ok(c.input) || !ok(c.output)) continue;
      out[`${provider}/${id}`] = [c.input, c.output, ok(c.cache_read) ? c.cache_read : c.input / 10];
    }
  }
  return out;
}

let cached: { file: string; mtimeMs: number; catalog: Catalog | undefined } | undefined;

/** The catalog on disk, or undefined (none yet, or unreadable). Re-read when the file changes. */
export function readCatalog(): Catalog | undefined {
  const file = catalogFile();
  try {
    const { mtimeMs } = fs.statSync(file);
    if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.catalog;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
    // a file edited by hand or half written is not a catalog: a date that is not one, or no models
    const catalog = parsed && typeof parsed.models === 'object' && parsed.models && Number.isFinite(Date.parse(parsed.fetchedAt)) ? parsed : undefined;
    cached = { file, mtimeMs, catalog };
    return catalog;
  } catch {
    return undefined;
  }
}

const ageMs = (file: string): number => {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** Whether a refresh is due: the feed is on, the catalog is missing or older than `priceFeedHours`, and the last try did not just fail. */
export function refreshDue(): boolean {
  const eff = effective();
  if (!eff.priceFeed.value) return false;
  if (ageMs(catalogFile()) < eff.priceFeedHours.value * 3_600_000) return false;
  return ageMs(attemptFile()) > RETRY_AFTER_FAILURE_MS;
}

export interface Refreshed {
  state: 'updated' | 'failed';
  models?: number;
  error?: string;
}

/** Fetches the catalog and replaces the trimmed copy. Never throws: a failure keeps the old copy and notes the attempt. */
export async function refreshCatalog(): Promise<Refreshed> {
  const url = effective().priceFeedUrl.value;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const models = trim(await r.json());
    const n = Object.keys(models).length;
    if (n < MIN_MODELS) throw new Error(`only ${n} priced models in it (a catalog has thousands): not used`);
    fs.mkdirSync(home(), { recursive: true });
    const tmp = `${catalogFile()}.${process.pid}.tmp`;
    const catalog: Catalog = { fetchedAt: new Date().toISOString(), source: url, models };
    fs.writeFileSync(tmp, JSON.stringify(catalog));
    renameOver(tmp, catalogFile());
    fs.rmSync(attemptFile(), { force: true });
    return { state: 'updated', models: n };
  } catch (e) {
    try {
      fs.mkdirSync(home(), { recursive: true });
      fs.writeFileSync(attemptFile(), `${new Date().toISOString()} ${(e as Error).message}\n`);
    } catch {
      // not even that: the next run asks again
    }
    return { state: 'failed', error: (e as Error).message };
  }
}

/** After a run: refresh in a process of its own when it is due, so no run ever waits for the network. */
export function refreshInBackground(): void {
  try {
    if (!refreshDue()) return;
    const script = process.argv[1];
    if (!script) return;
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(attemptFile(), `${new Date().toISOString()} refresh started\n`); // so that runs ending together start one
    const child = spawn(process.execPath, [script, 'prices', '--refresh', '--quiet'], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // a price list is a convenience
  }
}

/** The vendor's own provider first: the same model costs different amounts on a reseller. */
const OWN: Record<string, string[]> = { codex: ['openai'], claude: ['anthropic'], gemini: ['google'] };

/** The catalog's price for a worker model (the first of `models` found), or undefined. `provider/model` ids (OpenCode) are looked up as they are. */
export function catalogPrice(backend: string, ...models: (string | undefined)[]): { input: number; output: number; cachedInput: number; key: string } | undefined {
  const catalog = readCatalog();
  if (!catalog) return undefined;
  for (const raw of models) {
    const id = raw?.split('#')[0];
    if (!id) continue;
    // the id as it is (`provider/model`), then the vendor's own provider, then any provider (the first by name, so the answer
    // does not change from run to run)
    const keys = [id, ...[...(OWN[backend] ?? []), 'anthropic', 'openai', 'google'].map((p) => `${p}/${id}`)];
    const any = keys.find((k) => catalog.models[k]) ?? Object.keys(catalog.models).filter((k) => k.endsWith(`/${id}`)).sort()[0];
    const triple = any ? catalog.models[any] : undefined;
    if (any && triple && triple.length === 3 && triple.every((n) => Number.isFinite(n) && n >= 0)) {
      const [input, output, cachedInput] = triple;
      return { input, output, cachedInput, key: any };
    }
  }
  return undefined;
}

export interface CatalogStatus {
  enabled: boolean;
  url: string;
  hours: number;
  file: string;
  models?: number;
  fetchedAt?: string;
  ageHours?: number;
  lastFailure?: string;
}

export function catalogStatus(): CatalogStatus {
  const eff = effective();
  const c = readCatalog();
  let lastFailure: string | undefined;
  try {
    const t = fs.readFileSync(attemptFile(), 'utf8').trim();
    if (t && !t.endsWith('refresh started')) lastFailure = t;
  } catch {
    // none
  }
  return {
    enabled: eff.priceFeed.value,
    url: eff.priceFeedUrl.value,
    hours: eff.priceFeedHours.value,
    file: catalogFile(),
    models: c ? Object.keys(c.models).length : undefined,
    fetchedAt: c?.fetchedAt,
    ageHours: c ? (Date.now() - Date.parse(c.fetchedAt)) / 3_600_000 : undefined,
    lastFailure,
  };
}
