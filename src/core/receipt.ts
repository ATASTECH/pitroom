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
  // Runs that never reached the model (stopped early, setup errors) would only skew the stats; an audit saved nothing.
  if (!meta.usage?.steps || meta.auditOf) return;
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

/** The shareable savings card: the dashboard's look (dark surface, orange mark, green savings, bordered tiles). */
export function card(t: Totals, period: string): string {
  const W = 720, H = 316, M = 32, GAP = 12;
  const tile = (i: number, value: string, label: string) => {
    const w = (W - 2 * M - 2 * GAP) / 3, x = M + i * (w + GAP);
    return `<rect x="${x}" y="196" width="${w}" height="72" rx="14" fill="#fff" fill-opacity=".035" stroke="#fff" stroke-opacity=".1"/>
<text x="${x + 18}" y="224" class="lab">${esc(label.toUpperCase())}</text><text x="${x + 18}" y="254" class="val">${esc(value)}</text>`;
  };
  const when = period.toUpperCase();
  const pill = 22 + when.length * 7.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="pitroom saved ${esc(usd(t.saved))}">
<style>
text{font-family:ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;fill:#f4f4f5}
.name{font-size:20px;font-weight:650;letter-spacing:-.01em}
.sub{font-size:12.5px;fill:#a1a1aa}
.pill{font-size:11px;font-weight:600;letter-spacing:.1em;fill:#a1a1aa}
.lab{font-size:11px;font-weight:500;letter-spacing:.09em;fill:#a1a1aa}
.big{font-size:60px;font-weight:700;letter-spacing:-.03em;fill:#3ddc97}
.val{font-size:26px;font-weight:650;letter-spacing:-.02em}
.foot{font-size:11.5px;fill:#71717a}
</style>
<defs>
<radialGradient id="o" cx="1" cy="0" r=".7"><stop offset="0" stop-color="#ff6a2b" stop-opacity=".24"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></radialGradient>
<radialGradient id="b" cx="0" cy="0" r=".7"><stop offset="0" stop-color="#38bdf8" stop-opacity=".16"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
<linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6a2b"/><stop offset="1" stop-color="#ffa86b"/></linearGradient>
<clipPath id="c"><rect width="${W}" height="${H}" rx="20"/></clipPath>
</defs>
<g clip-path="url(#c)"><rect width="${W}" height="${H}" fill="#0b0b0f"/><rect width="${W}" height="${H}" fill="url(#o)"/><rect width="${W}" height="${H}" fill="url(#b)"/></g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="19.5" fill="none" stroke="#fff" stroke-opacity=".1"/>
<rect x="${M}" y="28" width="38" height="38" rx="11" fill="url(#m)"/>
<path d="M4 4h4v4H4zm8 0h4v4h-4zM8 8h4v4H8zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4zm-4 4h4v4H8zm8 0h4v4h-4z" fill="#fff" transform="translate(${M + 7} 35) scale(1)"/>
<text x="${M + 52}" y="45" class="name">Pitroom</text><text x="${M + 52}" y="63" class="sub">Your agent's pit crew</text>
<rect x="${W - M - pill}" y="34" width="${pill}" height="26" rx="13" fill="#fff" fill-opacity=".04" stroke="#fff" stroke-opacity=".14"/>
<text x="${W - M - pill / 2}" y="51" class="pill" text-anchor="middle">${esc(when)}</text>
<text x="${M}" y="112" class="lab">SAVED ON YOUR MAIN CODING AGENT</text>
<text x="${M}" y="168" class="big">${esc(usd(t.saved))}</text>
${tile(0, compact(t.tokens), 'Tokens offloaded')}${tile(1, t.ratio ? `${Math.round(t.ratio)}×` : '—', 'Context compression')}${tile(2, String(t.runs), 'Delegated tasks')}
<text x="${M}" y="296" class="foot">Estimated against ${esc(primaryPrice().name)} pricing · npx pitroom</text>
</svg>
`;
}
