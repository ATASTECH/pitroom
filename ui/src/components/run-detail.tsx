import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { type RunDetail, api } from '@/api';
import { Pill } from '@/components/badges';
import { AgentActivity } from '@/components/agents/agent-activity';
import { FadeDiv } from '@/components/fade-div';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePoll } from '@/hooks/use-poll';
import { tokens, usd } from '@/lib/format';
import { traceItems } from '@/lib/steps';
import { cn } from '@/lib/utils';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/80">{title}</h4>
      {children}
    </section>
  );
}

const Block = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
  <FadeDiv className={cn('max-h-60 whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-[13px] leading-relaxed', mono && 'font-mono text-xs')}>{children}</FadeDiv>
);

function Diff({ patch }: { patch: string }) {
  return (
    <FadeDiv className="max-h-72 rounded-lg border bg-muted/40">
      <pre className="min-w-max p-3 font-mono text-xs leading-5">
        {patch.split('\n').map((l, i) => (
          <div key={i} className={cn(l.startsWith('+') && !l.startsWith('+++') && 'bg-success/10 text-success', l.startsWith('-') && !l.startsWith('---') && 'bg-destructive/10 text-destructive', l.startsWith('@@') && 'text-info')}>
            {l || ' '}
          </div>
        ))}
      </pre>
    </FadeDiv>
  );
}

const LABEL: Record<string, string> = { worker: 'Worker', model: 'Model', mode: 'Mode', started: 'Started', time: 'Duration', steps: 'Steps', toolCalls: 'Tool calls', tokens: 'Tokens', returnedTokens: 'Returned to agent', cost: 'Worker cost', saved: 'Saved', group: 'Group', directory: 'Directory' };
function value(k: string, v: string | number): string {
  if (k === 'started') return new Date(v).toLocaleString();
  if (k === 'tokens' || k === 'returnedTokens') return tokens(Number(v));
  if (k === 'cost') return Number(v) ? `$${Number(v).toFixed(3)}` : 'free';
  if (k === 'saved') return `~${usd(Number(v))}`;
  return String(v);
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'bad' | 'ok' }) {
  return <p className={cn('text-[13px]', tone === 'bad' ? 'text-destructive' : tone === 'ok' ? 'text-muted-foreground' : 'text-warning')}>{children}</p>;
}

function Body({ d }: { d: RunDetail }) {
  const [diff, setDiff] = useState(false);
  const [report, setReport] = useState(false);
  const [copied, setCopied] = useState(false);
  const running = d.state === 'running' || d.state === 'queued';
  return (
    <div className="space-y-5">
      {!/^Review of /.test(d.task) && <Section title="Task"><Block>{d.task}</Block></Section>}
      <Section title={`What it did${d.steps.length ? ` · ${d.steps.length}` : ''}`}>
        {d.steps.length ? <AgentActivity items={traceItems(d.steps)} status={running ? 'working' : 'complete'} defaultOpen collapseOnComplete={false} maxHeight={260} activeLabel="Working…" /> : <p className="text-sm text-muted-foreground">{running ? 'Waiting for its first step…' : 'No activity was recorded for this run.'}</p>}
      </Section>
      {d.answer && <Section title="Result"><Block>{d.answer}</Block></Section>}
      {d.changes.length > 0 && (
        <Section title={`Changes · ${d.changes.length} file${d.changes.length === 1 ? '' : 's'}`}>
          <div className="space-y-0.5 font-mono text-xs">
            {d.changes.map((c) => (
              <div key={c.path} className="flex gap-2"><b className={cn('w-3', c.status === 'A' && 'text-success', c.status === 'M' && 'text-warning', c.status === 'D' && 'text-destructive')}>{c.status}</b><span className="break-all">{c.path}</span></div>
            ))}
          </div>
          {d.patch && <><Button variant="ghost" size="sm" onClick={() => setDiff((x) => !x)}>{diff ? 'Hide the diff' : 'Show the diff'}</Button>{diff && <Diff patch={d.patch} />}</>}
        </Section>
      )}
      <Section title="Details">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {Object.keys(LABEL).map((k) => {
            const v = d.info[k];
            if (v == null || v === '' || (v === 0 && k !== 'cost')) return null;
            return <div key={k} className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{LABEL[k]}</dt><dd className="break-words text-[13px]">{value(k, v)}</dd></div>;
          })}
        </dl>
        {d.refs && <Note tone={d.refs.valid < d.refs.total ? undefined : 'ok'}>References verified: {d.refs.valid} of {d.refs.total}{d.refs.invalid.length ? ` · not found: ${d.refs.invalid.join(', ')}` : ''}</Note>}
        {d.attempts.map((a, i) => <Note key={i}>Fell back from {a.target}: {a.error}</Note>)}
        {d.warnings.map((w, i) => <Note key={i}>{w}</Note>)}
        {d.verify && <Note tone={d.verify.ok ? 'ok' : 'bad'}>Verify {d.verify.ok ? 'passed' : 'failed'}: {d.verify.command}</Note>}
        {d.error && <Note tone="bad">{d.error}</Note>}
        <div className="flex gap-1 pt-1">
          <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(d.id); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
            {copied ? <Check /> : <Copy />}{copied ? 'Copied' : d.id}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setReport((x) => !x)}>{report ? 'Hide full report' : 'Full report'}</Button>
        </div>
        {report && <Block mono>{d.report}</Block>}
      </Section>
    </div>
  );
}

/** The expanded view of one run: its task, what the worker did, the result, the changes and the details. */
export function RunDetailView({ id, live }: { id: string; live?: boolean }) {
  const { data, error } = usePoll(() => api.run(id), live ? 3000 : 600_000, [id, live]);
  if (!data) return error ? <p className="text-sm text-destructive">Could not load this run.</p> : <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-24" /></div>;
  return <Body d={data} />;
}

export { Pill };
