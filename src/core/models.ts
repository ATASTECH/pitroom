// `pitroom models`: what each worker CLI offers, put next to what you told Pitroom about cost and
// what your own runs show, so the primary agent (and you) can pick the cheapest model that fits.
// Pitroom cannot know vendor prices and does not fetch them: a cost is what you put in the config
// ("costs"), usage comes from the ledger, and the model lists come from the CLIs themselves.
import { allBackends } from '../backends/index.js';
import { effective } from './config.js';
import { readLedger } from './receipt.js';
import { parseTarget } from './target.js';

export interface ModelRow {
  worker: string;
  model: string;
  efforts?: string[];
  defaultEffort?: string;
  /** Your relative cost from the config, if you set one. */
  cost?: number;
  runs: number;
  avgTokens?: number;
  /** Cost per run in USD where the worker CLI reports it (Claude Code, OpenCode). */
  reportedUsdPerRun?: number;
  /** Where your config uses it: default worker, a tier, a fallback or a per-worker default. */
  inUse: string[];
}

export interface ModelTable {
  rows: ModelRow[];
  /** One line per worker saying where its list comes from. */
  sources: string[];
  hiddenOpenCode: number;
}

const base = (model: string | undefined) => (model ?? '').split('#')[0]!;

/** Where the config points at each worker:model pair. */
function usage(): Map<string, string[]> {
  const eff = effective();
  const out = new Map<string, string[]>();
  const add = (spec: string, label: string) => {
    let t;
    try {
      t = parseTarget(spec, 'opencode');
    } catch {
      return;
    }
    const model = base(t.model) || base(eff.models.value[t.backend]);
    if (!model) return;
    const key = `${t.backend}:${model}`;
    out.set(key, [...(out.get(key) ?? []), label]);
  };
  add(eff.worker.value, 'default worker');
  for (const [name, spec] of Object.entries(eff.tiers.value)) add(spec, `tier ${name}`);
  eff.fallback.value.forEach((spec) => add(spec, 'fallback'));
  for (const [backend, model] of Object.entries(eff.models.value)) add(`${backend}:${model}`, 'models');
  return out;
}

export function modelTable(opts: { backend?: string; all?: boolean } = {}): ModelTable {
  const costs = effective().costs.value;
  const used = usage();
  const seen = new Map<string, { runs: number; tokens: number; usd: number }>();
  for (const e of readLedger()) {
    if (!e.backend || !e.model) continue;
    const key = `${e.backend}:${base(e.model)}`;
    const a = seen.get(key) ?? { runs: 0, tokens: 0, usd: 0 };
    seen.set(key, { runs: a.runs + 1, tokens: a.tokens + e.tokens, usd: a.usd + e.workerCost });
  }

  const rows: ModelRow[] = [];
  const sources: string[] = [];
  let hiddenOpenCode = 0;
  const known = new Set<string>();
  for (const b of allBackends()) {
    if (opts.backend && b.id !== opts.backend) continue;
    const catalog = b.catalog?.() ?? { models: [], source: 'no model list for this worker' };
    sources.push(`${b.id}: ${catalog.source}`);
    for (const m of catalog.models) {
      const key = `${b.id}:${m.id}`;
      known.add(key);
      const s = seen.get(key);
      const row: ModelRow = {
        worker: b.id,
        model: m.id,
        efforts: m.efforts?.length ? m.efforts : undefined,
        defaultEffort: m.defaultEffort,
        cost: costs[key],
        runs: s?.runs ?? 0,
        avgTokens: s ? Math.round(s.tokens / s.runs) : undefined,
        reportedUsdPerRun: s && s.usd > 0 ? s.usd / s.runs : undefined,
        inUse: used.get(key) ?? [],
      };
      // OpenCode lists hundreds of models (embeddings, image models, …): show the ones that matter
      // unless asked for all of them.
      const relevant = row.inUse.length || row.runs || row.cost !== undefined;
      if (b.id === 'opencode' && !opts.all && !relevant) hiddenOpenCode++;
      else rows.push(row);
    }
  }
  // Models your config or your history name that the CLI's list does not show (a full Claude id, a new Codex model).
  for (const [key, labels] of used) {
    const [worker, ...rest] = key.split(':');
    if (known.has(key) || (opts.backend && worker !== opts.backend)) continue;
    const s = seen.get(key);
    rows.push({ worker: worker!, model: rest.join(':'), cost: costs[key], runs: s?.runs ?? 0, avgTokens: s ? Math.round(s.tokens / s.runs) : undefined, inUse: labels });
  }
  rows.sort(
    (a, b) =>
      a.worker.localeCompare(b.worker) ||
      Number(b.inUse.length > 0) - Number(a.inUse.length > 0) ||
      (a.cost ?? Infinity) - (b.cost ?? Infinity) ||
      b.runs - a.runs ||
      a.model.localeCompare(b.model),
  );
  return { rows, sources, hiddenOpenCode };
}

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function formatModels(t: ModelTable): string {
  const efforts = (r: ModelRow) => (r.efforts ? r.efforts.map((e) => (e === r.defaultEffort ? `${e}*` : e)).join('/') : '-');
  const cells = t.rows.map((r) => [
    r.worker,
    r.model,
    efforts(r),
    r.cost !== undefined ? String(r.cost) : '?',
    r.runs ? String(r.runs) : '-',
    r.avgTokens !== undefined ? compact(r.avgTokens) : '-',
    r.reportedUsdPerRun !== undefined ? `$${r.reportedUsdPerRun.toFixed(3)}` : '-',
    r.inUse.join(', ') || '-',
  ]);
  const head = ['worker', 'model', 'effort (* default)', 'cost', 'runs', 'avg tokens', '$/run', 'in use'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(widths[i]!)).join('  ').trimEnd();
  const out = [line(head), ...cells.map(line), ''];
  out.push('cost: your relative cost from the config ("costs": {"codex:gpt-6-sol": 1, …}); ? = not set. Pitroom cannot know vendor prices.');
  out.push('runs, avg tokens, $/run: from your own runs (only Claude Code and OpenCode report dollars). Choose one with -W worker:model --effort LEVEL.');
  if (t.hiddenOpenCode) out.push(`${t.hiddenOpenCode} more OpenCode models not shown (use --all).`);
  out.push(...t.sources.map((s) => `source ${s}`));
  return out.join('\n');
}
