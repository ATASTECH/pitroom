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

export function VerdictBadge({ verdict }: { verdict: string }) {
  const good = /PASS/.test(verdict) && /APPROVED/.test(verdict);
  const label = good ? 'Approved' : /FAIL/.test(verdict) ? 'Spec fail' : 'Needs fixes';
  return <Badge className={cn('border', good ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive')}>{label}</Badge>;
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: 'good' }) {
  return <Badge variant="secondary" className={cn(tone === 'good' && 'bg-success/10 text-success')}>{children}</Badge>;
}
