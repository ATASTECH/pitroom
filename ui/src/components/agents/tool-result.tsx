import { Check, ChevronDown, CircleCheck, CircleX, Copy, Wrench } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { AgentCode, type AgentCodeLanguage } from '@/components/agents/agent-code';
import { AgentDisclosure } from '@/components/agents/agent-disclosure';
import { SPRING_PRESS, SPRING_SWAP } from '@/lib/ease';
import { cn } from '@/lib/utils';

export function ToolResult({ title, tool, detail, icon, meta, ok, language = 'text', variant = 'plain' }: {
  title: ReactNode;
  tool?: ReactNode;
  detail: string;
  icon?: ReactNode;
  meta?: ReactNode;
  ok?: boolean;
  language?: AgentCodeLanguage;
  variant?: 'plain' | 'hover';
}) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const reduce = useReducedMotion();
  const statusLabel = ok === true ? 'Completed' : ok === false ? 'Failed' : 'Recorded';
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(detail); setCopyState('copied'); }
    catch { setCopyState('failed'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 1800);
  };
  return (
    <div data-slot="tool-result" data-variant={variant} data-state={ok === false ? 'error' : ok === true ? 'success' : 'recorded'} className="min-w-0 w-full text-sm">
      <button type="button" id={`${id}-trigger`} aria-expanded={open} aria-controls={`${id}-content`} onClick={() => setOpen((value) => !value)}
        className={cn('group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', variant === 'hover' && 'cursor-pointer px-1 transition-colors hover:bg-muted/50')}>
        <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon ?? <Wrench className="size-4" />}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 font-medium text-foreground/90">{title}</span>
          {meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">{meta}</span>}
          {tool && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/55">{tool}</span>}
        </span>
        <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-medium', ok === false ? 'text-destructive' : ok === true ? 'text-success' : 'text-muted-foreground')}>
          {ok === true ? <CircleCheck aria-hidden="true" className="size-3" /> : ok === false ? <CircleX aria-hidden="true" className="size-3" /> : null}
          {statusLabel}
        </span>
        <motion.span aria-hidden="true" className={cn('shrink-0 text-muted-foreground/50 transition-colors', variant === 'hover' && 'group-hover:text-muted-foreground')} animate={{ rotate: open ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING_SWAP}>
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AgentDisclosure id={`${id}-content`} role="region" aria-labelledby={`${id}-trigger`} open={open}>
        {open && <div className="pl-6 pt-1.5">
          <div className="overflow-hidden rounded-xl bg-muted/80">
            <div tabIndex={0} aria-label="Full tool details" className="max-h-64 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="p-3"><AgentCode code={detail || 'No details recorded.'} language={language} /></div>
            </div>
            <div className="flex items-center gap-0.5 px-2 pb-1.5">
              <motion.button type="button" onClick={() => { void copy(); }} aria-label={copyState === 'copied' ? 'Copied tool details' : 'Copy tool details'} title={copyState === 'copied' ? 'Copied' : 'Copy result'}
                whileTap={reduce ? undefined : { scale: 0.9 }} transition={SPRING_PRESS}
                className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                {copyState === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </motion.button>
              {copyState === 'failed' && <span role="status" className="text-xs text-destructive">Could not copy.</span>}
              <span className="ml-auto text-[11px] text-muted-foreground/55">{statusLabel}</span>
            </div>
          </div>
        </div>}
      </AgentDisclosure>
    </div>
  );
}
