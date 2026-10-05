import { CircleCheck, CircleSlash, CircleX, Clock, Hourglass, Loader2, TriangleAlert } from 'lucide-react';
import type { RunState } from '@/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const ICONS = {
  running: { Icon: Loader2, cls: 'text-info animate-spin', hint: 'Running' },
  queued: { Icon: Hourglass, cls: 'text-warning animate-pulse', hint: 'Queued: waiting for a free worker slot' },
  done: { Icon: CircleCheck, cls: 'text-success animate-in zoom-in-50 duration-300', hint: 'Done' },
  failed: { Icon: CircleX, cls: 'text-destructive animate-in zoom-in-50 duration-300', hint: 'Failed: the worker or its model reported an error' },
  timeout: { Icon: Clock, cls: 'text-warning animate-in zoom-in-50 duration-300', hint: 'Timed out: the worker passed its time limit (30 minutes unless set otherwise) and was stopped; what it had done is kept' },
  stopped: { Icon: CircleSlash, cls: 'text-muted-foreground', hint: 'Stopped: ended with pitroom stop' },
} as const;

const VERIFY_FAILED = { Icon: TriangleAlert, cls: 'text-destructive animate-in zoom-in-50 duration-300', hint: 'Done, but its verify command failed: open it for the output' };

export function StateIcon({ state, verifyFailed, className }: { state: RunState; verifyFailed?: boolean; className?: string }) {
  const warn = state === 'done' && verifyFailed;
  const { Icon, cls, hint } = warn ? VERIFY_FAILED : ICONS[state];
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
        <Icon className={cn('size-5 shrink-0', cls, className)} aria-label={warn ? 'done, verify failed' : state} />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}
