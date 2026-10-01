import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DashRun } from '@/api';
import { Pill, VerdictBadge, WorkerBadge } from '@/components/badges';
import { RunDetailView } from '@/components/run-detail';
import { StateIcon } from '@/components/state-icon';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TextShimmer } from '@/components/agent-elements/text-shimmer';
import { clock, tokens, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

function Elapsed({ run }: { run: DashRun }) {
  const active = run.state === 'running' || run.state === 'queued';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return <span className={cn('text-sm font-semibold tabular-nums', active && 'text-info')}>{active ? clock((now - Date.parse(run.startedAt)) / 1000) : run.time}</span>;
}

export function RunCard({ run, defaultOpen, index }: { run: DashRun; defaultOpen?: boolean; index: number }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const active = run.state === 'running' || run.state === 'queued';
  return (
    <Card
      className={cn('animate-in fade-in slide-in-from-bottom-2 fill-mode-both gap-0 overflow-hidden py-0 transition-colors duration-300 hover:border-foreground/25', run.state === 'running' && 'border-info/30')}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms`, animationDuration: '500ms' }}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-3.5 p-4 text-left outline-none focus-visible:bg-accent/50">
          <StateIcon state={run.state} className="mt-0.5" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <WorkerBadge worker={run.worker} />
              <span className="text-[13px] text-muted-foreground">{run.kind}</span>
              {run.verdict && <VerdictBadge verdict={run.verdict} />}
              {run.changes ? <Pill>{run.changes} file{run.changes === 1 ? '' : 's'}</Pill> : null}
              {run.applied && <Pill tone="good">applied</Pill>}
            </div>
            <p className="break-words text-[15px] leading-snug">{run.task}</p>
            {active ? (
              <TextShimmer as="p" duration={1.6} className="truncate text-[13px]">{run.note || 'working'}</TextShimmer>
            ) : run.note ? (
              <p className="line-clamp-2 break-words text-[13px] text-muted-foreground">{run.note}</p>
            ) : null}
            {run.state === 'running' && <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-info/15"><div className="h-full w-[38%] rounded-full bg-gradient-to-r from-transparent via-info to-transparent" style={{ animation: 'indeterminate 1.5s cubic-bezier(.22,1,.36,1) infinite' }} /></div>}
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <Elapsed run={run} />
            <span className="text-xs text-muted-foreground">
              {[run.steps ? `${run.steps} step${run.steps === 1 ? '' : 's'}` : '', run.tokens ? `${tokens(run.tokens)} tokens` : ''].filter(Boolean).join(' · ')}
            </span>
            {run.saved ? <span className="text-xs text-success">~{usd(run.saved)}</span> : null}
            <ChevronDown className="mt-1 size-4 text-muted-foreground/60 transition-transform duration-300 group-data-[panel-open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-300 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
          <div className="border-t px-4 pb-4 pt-4 sm:pl-[3.4rem]">{open && <RunDetailView id={run.id} live={active} />}</div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
