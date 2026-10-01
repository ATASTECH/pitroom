import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type HistoryRow, type Stats, api } from '@/api';
import { WorkerBadge } from '@/components/badges';
import { StateIcon } from '@/components/state-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ago, clock, tokens, usd } from '@/lib/format';

const STATES = { all: 'Any state', done: 'Done', problem: 'Needs attention' };
const PERIODS = { '0': 'All time', '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days' };

export function HistoryPage({ onOpen }: { onOpen: (id: string) => void }) {
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
      <div className="overflow-hidden rounded-xl border bg-card animate-in fade-in duration-500">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10" /><TableHead>Task</TableHead><TableHead className="hidden md:table-cell">Worker</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Time</TableHead><TableHead className="hidden text-right lg:table-cell">Tokens</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Saved</TableHead><TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {busy && !rows.length && [0, 1, 2, 3].map((i) => <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>)}
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => onOpen(r.id)}>
                <TableCell><StateIcon state={r.state} className="size-4" /></TableCell>
                <TableCell className="max-w-0 min-w-48"><div className="truncate font-medium">{r.task}</div><div className="truncate text-xs text-muted-foreground">{r.kind}{r.verdict ? ` · ${r.verdict}` : ''}{r.files ? ` · ${r.files} file${r.files === 1 ? '' : 's'}` : ''}</div></TableCell>
                <TableCell className="hidden md:table-cell"><WorkerBadge backend={r.backend} model={r.model} /></TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.seconds != null ? clock(r.seconds) : '-'}</TableCell>
                <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">{r.tokens ? tokens(r.tokens) : '-'}</TableCell>
                <TableCell className="hidden text-right tabular-nums text-success lg:table-cell">{r.saved ? usd(r.saved) : '-'}</TableCell>
                <TableCell className="whitespace-nowrap text-right text-muted-foreground" title={new Date(r.startedAt).toLocaleString()}>{ago(r.startedAt)}</TableCell>
              </TableRow>
            ))}
            {!busy && !rows.length && <TableRow className="hover:bg-transparent"><TableCell colSpan={7} className="py-12 text-center text-muted-foreground">No runs match.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{total != null ? `${rows.length} of ${total} runs` : ''}</span>
        {total != null && rows.length < total && <Button variant="outline" onClick={() => void more()}>Load more</Button>}
      </div>
    </div>
  );
}
