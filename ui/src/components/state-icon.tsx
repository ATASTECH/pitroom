import { CircleCheck, CircleSlash, CircleX, Clock, Hourglass, Loader2 } from 'lucide-react';
import type { RunState } from '@/api';
import { cn } from '@/lib/utils';

const ICONS = {
  running: { Icon: Loader2, cls: 'text-info animate-spin' },
  queued: { Icon: Hourglass, cls: 'text-warning animate-pulse' },
  done: { Icon: CircleCheck, cls: 'text-success animate-in zoom-in-50 duration-300' },
  failed: { Icon: CircleX, cls: 'text-destructive animate-in zoom-in-50 duration-300' },
  timeout: { Icon: Clock, cls: 'text-warning animate-in zoom-in-50 duration-300' },
  stopped: { Icon: CircleSlash, cls: 'text-muted-foreground' },
} as const;

export function StateIcon({ state, className }: { state: RunState; className?: string }) {
  const { Icon, cls } = ICONS[state];
  return <Icon className={cn('size-5 shrink-0', cls, className)} aria-label={state} />;
}
