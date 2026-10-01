import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type DashRun, api } from '@/api';
import { RunCard } from '@/components/run-card';
import { Segmented } from '@/components/segmented';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { usePoll } from '@/hooks/use-poll';
import { usd } from '@/lib/format';
import { cn } from '@/lib/utils';

function useCount(to: number, ms = 450) {
  const [v, setV] = useState(to);
  const [from, setFrom] = useState(to);
  if (from !== to) {
    setFrom(to);
    const t0 = performance.now(), start = v;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(start + (to - start) * (1 - (1 - p) ** 3));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return v;
}

function Stat({ label, value, tone, pulse }: { label: string; value: string; tone?: string; pulse?: boolean }) {
  return (
    <Card className={cn('relative gap-1 overflow-hidden px-5 py-4 animate-in fade-in slide-in-from-bottom-1 duration-500 fill-mode-both', pulse && 'border-info/30')}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('flex items-center gap-2.5 text-3xl font-semibold tabular-nums tracking-tight', tone)}>
        {pulse !== undefined && <span className={cn('size-2.5 rounded-full', pulse ? 'animate-ping-slow bg-info' : 'bg-muted-foreground/40')} />}
        {value}
      </p>
    </Card>
  );
}

const matches = (r: DashRun, q: string) => !q || `${r.task} ${r.worker} ${r.kind} ${r.note}`.toLowerCase().includes(q);

export function LivePage({ focus }: { focus?: string }) {
  const [limit, setLimit] = useState(40);
  const [filter, setFilter] = useState<'all' | 'running' | 'problem'>('all');
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const { data } = usePoll(() => api.state(limit, group || undefined), 2000, [limit, group]);
  const running = useCount(data?.running ?? 0);
  const saved = useCount(data?.saved ?? 0);
  const finished = useCount(data?.runs.filter((r) => r.state === 'done').length ?? 0);

  const shown = useMemo(
    () =>
      (data?.runs ?? []).filter(
        (r) => matches(r, q.trim().toLowerCase()) && (filter === 'all' || (filter === 'running' ? r.state === 'running' || r.state === 'queued' : r.state === 'failed' || r.state === 'timeout' || r.state === 'stopped')),
      ),
    [data, q, filter],
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Running now" value={String(Math.round(running))} pulse={(data?.running ?? 0) > 0} tone={data?.running ? 'text-info' : undefined} />
        <Stat label="Finished" value={String(Math.round(finished))} />
        <Stat label="Saved this week" value={usd(saved)} tone="text-success" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter these runs" className="pl-8" />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'problem', label: 'Needs attention' }]} />
        {data && data.groups.length > 0 && (
          <Select value={group || 'all'} onValueChange={(v) => setGroup(v === 'all' ? '' : (v ?? ''))} items={{ all: 'All groups', ...Object.fromEntries(data.groups.map((g) => [g, g])) }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All groups</SelectItem>{data.groups.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </div>
      <div className="space-y-2.5">
        {!data && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        {data && shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground animate-in fade-in duration-500">
            <span className="text-5xl animate-wave">🏁</span>
            <p>{data.runs.length ? 'Nothing matches this filter.' : 'All quiet. Workers appear here the moment they start.'}</p>
            {!data.runs.length && <code className="rounded-lg border bg-card px-3 py-1.5 text-sm text-foreground">pitroom run "your task"</code>}
          </div>
        )}
        {shown.map((r, i) => <RunCard key={r.id} run={r} index={i} />)}
        {data && data.runs.length >= limit && <div className="flex justify-center pt-1"><Button variant="outline" onClick={() => setLimit((l) => l + 40)}>Show older runs</Button></div>}
      </div>
    </div>
  );
}
