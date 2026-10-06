import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { DashRun } from '@/api';
import { Pill } from '@/components/badges';
import { RunCard } from '@/components/run-card';
import { ago, tokens, usd } from '@/lib/format';
import { summarize } from '@/lib/groups';
import { cn } from '@/lib/utils';

/** A crew (runs sharing a group) as one card: how far along it is, what it cost, and its runs underneath. */
export function GroupCard({ name, runs, index }: { name: string; runs: DashRun[]; index: number }) {
  const s = summarize(runs);
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? s.running > 0; // a crew still at work shows its runs until you say otherwise
  const finished = s.total - s.running;
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both" style={{ animationDelay: `${Math.min(index, 8) * 45}ms`, animationDuration: '500ms' }}>
      <div className={cn('rounded-xl border transition-colors duration-300', s.running > 0 && 'border-info/30')}>
        <button type="button" aria-expanded={expanded} onClick={() => setOpen(!expanded)} className="grid w-full grid-cols-[1fr_auto] items-start gap-3.5 p-4 text-left">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[15px] font-medium leading-snug">{name}</span>
              <Pill>{s.total} runs</Pill>
              {s.running > 0 && <Pill>{s.running} running</Pill>}
              {s.done > 0 && <Pill tone="good">{s.done} done</Pill>}
              {s.problem > 0 && <span className="rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">{s.problem} need attention</span>}
            </div>
            <div className="flex h-[3px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={finished}>
              <div className="h-full bg-success transition-[width] duration-500" style={{ width: `${(s.done / s.total) * 100}%` }} />
              <div className="h-full bg-destructive/70 transition-[width] duration-500" style={{ width: `${((finished - s.done) / s.total) * 100}%` }} />
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
              <span>{finished}/{s.total} finished</span>
              {s.tokens ? <span>{tokens(s.tokens)} tokens</span> : null}
              {s.saved ? <span className="text-success">~{usd(s.saved)}</span> : null}
              <span title={new Date(s.startedAt).toLocaleString()}>{ago(s.startedAt)}</span>
            </div>
            <ChevronDown className={cn('mt-0.5 size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
          </div>
        </button>
        {expanded && (
          <div className="space-y-2.5 border-t p-3">
            {runs.map((r, i) => <RunCard key={r.id} run={r} index={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}
