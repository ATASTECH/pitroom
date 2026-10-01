import { useScrollFade } from '@/hooks/use-scroll-fade';
import { cn } from '@/lib/utils';

/** A scrolling box whose edges fade out while there is more to scroll. */
export function FadeDiv({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useScrollFade<HTMLDivElement>();
  return <div ref={ref} className={cn('scroll-fade overflow-auto', className)}>{children}</div>;
}
