import { api } from '@/api';
import { WorkerBadge } from '@/components/badges';
import { WorkerIcon } from '@/components/worker-icon';
import { Hint } from '@/components/hint';
import { SavingsNote } from '@/components/savings-note';
import { Segmented } from '@/components/segmented';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePoll } from '@/hooks/use-poll';
import { clock, tokens, usd } from '@/lib/format';
import { useState } from 'react';

function Tile({ label, value, sub, tone, hint }: { label: string; value: string; sub?: string; tone?: string; hint?: React.ReactNode }) {
  return (
    <Card className="gap-1 px-5 py-4 animate-in fade-in slide-in-from-bottom-1 duration-500 fill-mode-both">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}{hint && <Hint>{hint}</Hint>}</p>
      <p className={`text-3xl lg:text-2xl font-semibold tabular-nums tracking-tight ${tone ?? ''}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

export function StatsPage() {
  const [days, setDays] = useState('30');
  const { data } = usePoll(() => api.stats(Number(days)), 15000, [days]);
  const t = data?.totals;
  const max = Math.max(1, ...(data?.byDay ?? []).map((d) => d.runs));
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Statistics</h2>
        <Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '0', label: 'All' }]} />
      </div>
      {!t ? <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div> : (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Tile label="Runs" value={String(t.runs)} sub={`${t.failed} not ok`} />
          <Tile label="Success" value={t.runs ? `${Math.round((100 * t.ok) / t.runs)}%` : '-'} tone="text-success" />
          <Tile label="Worker time" value={clock(t.seconds)} />
          <Tile label="Tokens" value={tokens(t.tokens)} />
          <Tile label="Est. saved" value={usd(t.saved)} tone="text-success" hint={<SavingsNote price={data?.price} />} />
        </div>
      )}
      {data && data.byDay.length > 0 && (
        <Card className="gap-3 px-5 py-4 animate-in fade-in duration-700">
          <div className="flex items-baseline justify-between"><h3 className="text-sm font-medium">Runs per day</h3><span className="text-xs text-muted-foreground">{data.byDay[0]?.day} → {data.byDay.at(-1)?.day}</span></div>
          <div className="flex h-36 items-end gap-1.5">
            {data.byDay.map((d, i) => (
              <Tooltip key={d.day}>
                <TooltipTrigger render={<div className="group flex h-full max-w-14 flex-1 flex-col justify-end" />}>
                  <div className="flex w-full flex-col justify-end overflow-hidden rounded-t-md transition-opacity group-hover:opacity-80 origin-bottom animate-in slide-in-from-bottom-4 fill-mode-both" style={{ height: `${(d.runs / max) * 100}%`, animationDelay: `${i * 18}ms` }}>
                    <div className="bg-destructive/70" style={{ height: `${d.runs ? ((d.runs - d.ok) / d.runs) * 100 : 0}%` }} />
                    <div className="flex-1 bg-success/80" />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{d.day}: {d.runs} runs, {d.ok} ok, ~{usd(d.saved)} saved</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </Card>
      )}
      {data && (
        <Card className="overflow-hidden py-0 animate-in fade-in duration-700">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Worker</TableHead><TableHead className="text-right">Runs</TableHead><TableHead className="w-44">Success</TableHead><TableHead className="hidden text-right sm:table-cell">Avg time</TableHead><TableHead className="hidden text-right md:table-cell">Avg tokens</TableHead><TableHead className="text-right">Saved</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.byWorker.map((w) => {
                // a worker the ledger names but the history files under another model has no runs of its own here
                const pct = w.runs ? Math.round((100 * w.ok) / w.runs) : undefined;
                return (
                  <TableRow key={`${w.backend}:${w.model}`}>
                    <TableCell><div className="flex items-center gap-2"><WorkerIcon backend={w.backend} className="size-[18px] rounded-[5px]" /><WorkerBadge backend={w.backend} model={w.model} /></div></TableCell>
                    <TableCell className="text-right tabular-nums">{w.runs}</TableCell>
                    <TableCell>{pct === undefined ? <span className="text-muted-foreground">-</span> : <div className="flex items-center gap-2"><Progress value={pct} className="flex-1" /><span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span></div>}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{w.avgSeconds != null ? clock(w.avgSeconds) : '-'}</TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{w.avgTokens ? tokens(w.avgTokens) : '-'}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{w.saved ? usd(w.saved) : '-'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
