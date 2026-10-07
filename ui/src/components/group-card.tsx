import { Check, ChevronDown, Copy } from 'lucide-react';
import { useState } from 'react';
import { type DashRun, api } from '@/api';
import { Pill, WorkerBadge } from '@/components/badges';
import { RunCard } from '@/components/run-card';
import { Button } from '@/components/ui/button';
import { ago, tokens, usd } from '@/lib/format';
import { summarize } from '@/lib/groups';
import { cn } from '@/lib/utils';

/**
 * What can be done to a whole crew: stop the runs still at work, throw away the isolated copies nobody applied (each
 * asks once more), and get the commands that start its failed runs again. The page never starts a run itself.
 */
function GroupActions({ name, running, discardable, problem }: { name: string; running: number; discardable: number; problem: number }) {
  const [asking, setAsking] = useState<'stop' | 'discard' | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>();
  const [commands, setCommands] = useState<string[]>();
  const [copied, setCopied] = useState(false);
  if (!running && !discardable && !problem) return null;
  const go = async (verb: 'stop' | 'discard') => {
    setBusy(true);
    setNote(undefined);
    try {
      setNote({ text: await (verb === 'stop' ? api.stopGroup(name) : api.discardGroup(name)) });
      setAsking(undefined);
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    try {
      setCommands((await api.retryGroup(name)).commands);
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    }
  };
  const question = asking === 'stop' ? `Stop the ${running} run${running === 1 ? '' : 's'} still at work?` : `Throw away ${discardable} isolated cop${discardable === 1 ? 'y' : 'ies'}? The patch files stay.`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {asking ? (
          <>
            <span className="text-[13px] text-muted-foreground">{question}</span>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void go(asking)}>{busy ? '…' : asking === 'stop' ? 'Yes, stop all' : 'Yes, discard all'}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(undefined)}>Cancel</Button>
          </>
        ) : (
          <>
            {running > 0 && <Button variant="outline" size="sm" onClick={() => setAsking('stop')}>Stop all ({running})</Button>}
            {discardable > 0 && <Button variant="outline" size="sm" onClick={() => setAsking('discard')}>Discard all ({discardable})</Button>}
            {problem > 0 && <Button variant="outline" size="sm" onClick={() => void retry()}>Retry command ({problem})</Button>}
          </>
        )}
      </div>
      {note && <p className={note.bad ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'}>{note.text}</p>}
      {commands && (
        commands.length ? (
          <div className="space-y-1.5">
            <p className="text-[13px] text-muted-foreground">Run in a terminal (or ask your agent) to start the failed runs again in this crew:</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-xs">{commands.join('\n')}</pre>
            <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(commands.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
              {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nothing to retry: the runs that need attention are audits, reviews or follow-ups of another run.</p>
        )
      )}
    </div>
  );
}

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
            <div className="flex flex-wrap items-center gap-1.5">
              {s.workers.map(([worker, n]) => (
                <span key={worker} className="inline-flex items-center gap-1">
                  <WorkerBadge worker={worker} />
                  {n > 1 && <span className="text-xs text-muted-foreground">×{n}</span>}
                </span>
              ))}
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
            <GroupActions name={name} running={s.running} discardable={runs.filter((r) => r.discardable).length} problem={s.problem} />
            {runs.map((r, i) => <RunCard key={r.id} run={r} index={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}
