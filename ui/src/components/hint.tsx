import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** A small (i) that explains a number on hover or keyboard focus. */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} aria-label="What is this?" className="inline-flex cursor-help items-center text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-foreground" />}>
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-balance">{children}</TooltipContent>
    </Tooltip>
  );
}
