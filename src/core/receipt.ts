// Receipts: what the worker burned, what came back to the primary agent, and an
// estimate of what the primary would have paid to do the same work itself.
//
// The estimate assumes the primary would have processed roughly the same tokens
// the worker did, priced at the primary's rates. Prices are list prices in USD
// per 1M tokens and are only used for this estimate; override with
// PITROOM_PRIMARY=<preset> or PITROOM_PRICE="in,out[,cachedIn]" (or primary/price in the config file).
import fs from 'node:fs';
import path from 'node:path';
import { effective } from './config.js';
import type { Usage } from '../backends/types.js';
import { ledgerFile, type RunMeta } from './store.js';

export interface Price {
  name: string;
  input: number;
  output: number;
  cachedInput: number;
}

export const PRESETS: Record<string, Price> = {
  sonnet: { name: 'Claude Sonnet', input: 3, output: 15, cachedInput: 0.3 },
  opus: { name: 'Claude Opus', input: 5, output: 25, cachedInput: 0.5 },
  haiku: { name: 'Claude Haiku', input: 1, output: 5, cachedInput: 0.1 },
  'gpt-5': { name: 'GPT-5', input: 1.25, output: 10, cachedInput: 0.125 },
};

export function primaryPrice(): Price {
  const eff = effective();
  const custom = eff.price.value?.split(',').map(Number);
  if (custom && custom.length >= 2 && custom.every((n) => Number.isFinite(n) && n >= 0)) {
    return { name: 'custom', input: custom[0]!, output: custom[1]!, cachedInput: custom[2] ?? custom[0]! / 10 };
  }
  return PRESETS[eff.primary.value.toLowerCase()] ?? PRESETS.sonnet!;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function savedUsd(usage: Usage, returnedTokens: number, price = primaryPrice()): number {
  const wouldCost =
    (usage.input * price.input + usage.cacheRead * price.cachedInput + (usage.output + usage.reasoning) * price.output) / 1e6;
  const readingTheReport = (returnedTokens * price.input) / 1e6;
  return Math.max(0, wouldCost - (usage.cost ?? 0) - readingTheReport);
}

export interface LedgerEntry {
  backend?: string;
  id: string;
  at: string;
  mode: string;
  state: string;
  model?: string;
  tokens: number;
  returned: number;
  workerCost: number;
  saved: number;
  price: string;
}

export function record(meta: RunMeta): void {
  // Runs that never reached the model (stopped early, setup errors) would only skew the stats.
  if (!meta.usage?.steps) return;
  const entry: LedgerEntry = {
    id: meta.id,
    at: meta.endedAt ?? new Date().toISOString(),
    mode: meta.mode,
    state: meta.state,
    backend: (meta.ran ?? meta.worker).backend,
    model: meta.resolvedModel ?? (meta.ran ?? meta.worker).model,
    tokens: meta.usage.total,
    returned: meta.returnedTokens ?? 0,
    workerCost: meta.usage.cost ?? 0,
    saved: meta.savedUsd ?? 0,
    price: primaryPrice().name,
  };
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}\n`);
}

export function readLedger(sinceMs?: number): LedgerEntry[] {
  if (!fs.existsSync(ledgerFile())) return [];
  return fs
    .readFileSync(ledgerFile(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LedgerEntry];
      } catch {
        return [];
      }
    })
    .filter((e) => !sinceMs || Date.parse(e.at) >= sinceMs);
}

export interface Totals {
  runs: number;
  tokens: number;
  returned: number;
  workerCost: number;
  saved: number;
  ratio: number;
}

export function totals(entries: LedgerEntry[]): Totals {
  const t = entries.reduce(
    (a, e) => ({
      runs: a.runs + 1,
      tokens: a.tokens + e.tokens,
      returned: a.returned + e.returned,
      workerCost: a.workerCost + e.workerCost,
      saved: a.saved + e.saved,
    }),
    { runs: 0, tokens: 0, returned: 0, workerCost: 0, saved: 0 },
  );
  return { ...t, ratio: t.returned ? t.tokens / t.returned : 0 };
}

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

export function compact(n: number): string {
  const fmt = (v: number) => v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, '');
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}k`;
  return String(Math.round(n));
}

export function badgeUrl(t: Totals): string {
  const msg = encodeURIComponent(`saved ${usd(t.saved)} · ${compact(t.tokens)} tokens offloaded`).replace(/-/g, '--');
  return `https://img.shields.io/badge/pitroom-${msg}-7c3aed`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function card(t: Totals, period: string): string {
  const stat = (x: number, value: string, label: string) =>
    `<text x="${x}" y="148" class="v">${esc(value)}</text><text x="${x}" y="170" class="l">${esc(label)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="pitroom saved ${esc(usd(t.saved))}">
<style>
text{font-family:ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#ede9fe}
.h{font-size:15px;font-weight:600;fill:#a78bfa;letter-spacing:.08em}
.big{font-size:54px;font-weight:800;fill:#fff}
.sub{font-size:15px;fill:#c4b5fd}
.v{font-size:22px;font-weight:700;fill:#fff}
.l{font-size:12px;fill:#a78bfa}
.f{font-size:11px;fill:#8b5cf6}
</style>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#3b0764"/></linearGradient></defs>
<rect width="600" height="220" rx="18" fill="url(#g)"/>
<text x="32" y="42" class="h">PITROOM · ${esc(period.toUpperCase())}</text>
<text x="32" y="98" class="big">${esc(usd(t.saved))}</text>
<text x="${Math.min(60 + usd(t.saved).length * 30, 330)}" y="98" class="sub">saved on my main coding agent</text>
${stat(32, compact(t.tokens), 'tokens offloaded')}
${stat(200, t.ratio ? `${Math.round(t.ratio)}×` : '—', 'context compression')}
${stat(380, String(t.runs), 'delegated tasks')}
<text x="32" y="202" class="f">estimated vs. ${esc(primaryPrice().name)} pricing · npx pitroom</text>
</svg>
`;
}
