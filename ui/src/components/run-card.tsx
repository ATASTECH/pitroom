import { useEffect, useState } from 'react';
import type { DashRun } from '@/api';
import { Pill, VerdictBadge, WorkerBadge } from '@/components/badges';
import {
  ExpandableCard,
  ExpandableCardBody,
  ExpandableCardContent,
  ExpandableCardDescription,
  ExpandableCardExpandContainer,
  ExpandableCardTitle,
} from '@/components/expandable-card';
import { TextShimmer } from '@/components/motion/text-shimmer';
import { RunDetailView } from '@/components/run-detail';
import { StateIcon } from '@/components/state-icon';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ago, clock, tokens, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

function Elapsed({ run, active }: { run: DashRun; active: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return <span className={cn('text-sm font-semibold tabular-nums', active && 'text-info')}>{active ? clock((now - Date.parse(run.startedAt)) / 1000) : run.time}</span>;
}

/** The card's face. The collapsed card and the expanded one render the same header, so motion morphs one into the other. */
function Header({ run, expanded, when }: { run: DashRun; expanded?: boolean; when?: boolean }) {
  const active = run.state === 'running' || run.state === 'queued';
  return (
    <div className={cn('grid grid-cols-[auto_1fr_auto] items-start gap-3.5 p-4 text-left', expanded && 'pr-12')}>
      <StateIcon state={run.state} className="mt-0.5" />
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <WorkerBadge worker={run.worker} />
          <span className="text-[13px] text-muted-foreground">{run.kind}</span>
          {run.verdict && <VerdictBadge verdict={run.verdict} />}
          {run.changes ? <Pill>{run.changes} file{run.changes === 1 ? '' : 's'}</Pill> : null}
          {run.applied && <Pill tone="good">applied</Pill>}
        </div>
        <ExpandableCardTitle className="!mt-0 break-words px-0 text-[15px] font-normal leading-snug tracking-normal">{run.task}</ExpandableCardTitle>
        {(active || run.note) && (
          <ExpandableCardDescription className="line-clamp-2 break-words px-0 text-[13px]">
            {active ? <TextShimmer duration={1.6}>{run.note || 'working'}</TextShimmer> : run.note}
          </ExpandableCardDescription>
        )}
        {run.state === 'running' && (
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-info/15">
            <div className="h-full w-[38%] rounded-full bg-gradient-to-r from-transparent via-info to-transparent" style={{ animation: 'indeterminate 1.5s cubic-bezier(.22,1,.36,1) infinite' }} />
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <Elapsed run={run} active={active} />
        <span className="text-xs text-muted-foreground">
          {[run.steps ? `${run.steps} step${run.steps === 1 ? '' : 's'}` : '', run.tokens ? `${tokens(run.tokens)} tokens` : ''].filter(Boolean).join(' · ')}
        </span>
        {run.saved ? <span className="text-xs text-success">~{usd(run.saved)}</span> : null}
        {when && <span title={new Date(run.startedAt).toLocaleString()} className="text-xs text-muted-foreground/80">{ago(run.startedAt)}</span>}
      </div>
    </div>
  );
}

/** A run as an expandable card (Shadix UI): click it and it grows into a focused panel with everything about the run. */
/** `when` adds how long ago it started (the History list, where the order is by time rather than by activity). */
export function RunCard({ run, index, when }: { run: DashRun; index: number; when?: boolean }) {
  const active = run.state === 'running' || run.state === 'queued';
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both" style={{ animationDelay: `${Math.min(index, 8) * 45}ms`, animationDuration: '500ms' }}>
      <ExpandableCard>
        <ExpandableCardBody className={cn('rounded-xl border pb-0 shadow-none transition-colors duration-300 hover:border-foreground/25', run.state === 'running' && 'border-info/30')}>
          <Header run={run} when={when} />
        </ExpandableCardBody>
        <ExpandableCardExpandContainer className="max-h-[88vh] w-full border pb-0 shadow-2xl">
          <div className="shrink-0"><Header run={run} expanded when={when} /></div>
          {/* the header stays put; everything below it scrolls */}
          <ScrollArea className="max-h-[calc(88vh-6.5rem)] border-t">
            <ExpandableCardContent className="px-4 pb-5 pt-4 sm:pl-[3.4rem]">
              <RunDetailView id={run.id} live={active} />
            </ExpandableCardContent>
          </ScrollArea>
        </ExpandableCardExpandContainer>
      </ExpandableCard>
    </div>
  );
}
