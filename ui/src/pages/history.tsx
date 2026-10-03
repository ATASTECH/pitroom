import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type DashRun, type HistoryRow, type Stats, api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { RunCard } from '@/components/run-card';
import { clock } from '@/lib/format';

const STATES = { all: 'Any state', done: 'Done', problem: 'Needs attention' };
const PERIODS = { '0': 'All time', '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days' };

/** The same short model name the Live cards show (the CLI's workerName). */
const shortModel = (m: string) => (m.split('/').pop() ?? m).replace(/-(contributor-)?free$/, '').replace(/-\d+\.\d+$/, '');

/** A history row in the shape the Live cards use, so both lists open the same card. */
const toRun = (r: HistoryRow): DashRun => ({
  id: r.id, state: r.state, kind: r.kind, worker: r.model ? `${r.backend} (${shortModel(r.model)})` : r.backend, task: r.task, group: r.group,
  startedAt: r.startedAt, time: r.seconds != null ? clock(r.seconds) : '', steps: r.steps ?? 0, tokens: r.tokens, saved: r.saved,
  verdict: r.verdict, audit: r.audit, changes: r.files || undefined, applied: r.applied || undefined, note: '',
});

export function HistoryPage() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('all');
  const [model, setModel] = useState('all');
  const [days, setDays] = useState('0');
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<Stats>();

  useEffect(() => { void api.stats(0).then(setStats).catch(() => undefined); }, []);
  useEffect(() => { const t = setTimeout(() => setSearch(q), 250); return () => clearTimeout(t); }, [q]);
  const filters = { q: search, state: state === 'all' ? undefined : state, model: model === 'all' ? undefined : model, days: Number(days) || undefined };

  useEffect(() => {
    let live = true;
    setBusy(true);
    void api.history({ ...filters, limit: 30 }).then((r) => { if (live) { setRows(r.rows); setTotal(r.total); setBusy(false); } }).catch(() => live && setBusy(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, state, model, days]);

  const more = async () => {
    const r = await api.history({ ...filters, limit: 30, before: rows.at(-1)?.id });
    setRows((x) => [...x, ...r.rows]);
  };
  const models = [...new Set((stats?.byWorker ?? []).map((w) => w.model).filter(Boolean) as string[])];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, answers and steps" className="pl-8" />
        </div>
        <Select value={state} onValueChange={(v) => setState(v ?? 'all')} items={STATES}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(STATES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
        <Select value={model} onValueChange={(v) => setModel(v ?? 'all')} items={{ all: 'Any model', ...Object.fromEntries(models.map((m) => [m, m.split('/').pop()])) }}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any model</SelectItem>{models.map((m) => <SelectItem key={m} value={m}>{m.split('/').pop()}</SelectItem>)}</SelectContent></Select>
        <Select value={days} onValueChange={(v) => setDays(v ?? '0')} items={PERIODS}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(PERIODS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
      </div>
      <div className="space-y-2.5">
        {busy && !rows.length && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        {rows.map((r, i) => <RunCard key={r.id} run={toRun(r)} index={i} when />)}
        {!busy && !rows.length && <div className="py-16 text-center text-muted-foreground">No runs match.</div>}
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{total != null ? `${rows.length} of ${total} runs` : ''}</span>
        {total != null && rows.length < total && <Button variant="outline" onClick={() => void more()}>Load more</Button>}
      </div>
    </div>
  );
}
