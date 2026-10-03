import { Badge } from '@/components/ui/badge';
import { BACKEND_COLOR, splitWorker } from '@/lib/format';
import { cn } from '@/lib/utils';

export function WorkerBadge({ worker, backend, model }: { worker?: string; backend?: string; model?: string }) {
  const w = worker ? splitWorker(worker) : { backend: backend ?? '', model };
  return (
    <Badge variant="outline" className="gap-1.5 pl-1.5">
      <span className="size-1.5 rounded-full" style={{ background: BACKEND_COLOR[w.backend] ?? 'var(--muted-foreground)' }} />
      {w.backend}
      {w.model && <span className="font-normal text-muted-foreground">{w.model.split('/').pop()}</span>}
    </Badge>
  );
}

const AUDIT_LABEL: Record<string, string> = { AGREE: 'agrees', PARTIAL: 'partly agrees', DISAGREE: 'disagrees', UNCLEAR: 'unclear' };

/** An audit run's own verdict ("AUDIT AGREE") reads as the audit's, not as a review's. */
export function VerdictBadge({ verdict }: { verdict: string }) {
  if (verdict.startsWith('AUDIT ')) return <AuditBadge audit={verdict.slice(6)} own />;
  const good = /PASS/.test(verdict) && /APPROVED/.test(verdict);
  const label = good ? 'Approved' : /FAIL/.test(verdict) ? 'Spec fail' : 'Needs fixes';
  return <Badge className={cn('border', good ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive')}>{label}</Badge>;
}

/** What an audit found about a run's answer: on the audited run, or (own) on the audit's card. */
export function AuditBadge({ audit, own }: { audit: string; own?: boolean }) {
  const pending = audit === 'PENDING';
  const good = audit === 'AGREE';
  const bad = audit === 'DISAGREE';
  const text = pending ? 'audit running' : audit === 'FAILED' ? 'audit failed' : own ? `Audit ${AUDIT_LABEL[audit] ?? audit.toLowerCase()}` : `audited · ${AUDIT_LABEL[audit] ?? audit.toLowerCase()}`;
  return (
    <Badge variant={pending || audit === 'FAILED' ? 'secondary' : undefined} title="Another worker re-checked this answer"
      className={cn(!pending && audit !== 'FAILED' && 'border', good && 'border-success/30 bg-success/10 text-success', bad && 'border-destructive/30 bg-destructive/10 text-destructive', !pending && !good && !bad && audit !== 'FAILED' && 'border-warning/30 bg-warning/10 text-warning')}>
      {text}
    </Badge>
  );
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: 'good' }) {
  return <Badge variant="secondary" className={cn(tone === 'good' && 'bg-success/10 text-success')}>{children}</Badge>;
}
