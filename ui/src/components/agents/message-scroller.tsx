import { ArrowDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PreviewRail, type PreviewRailItem } from '@/components/motion/preview-rail';
import { cn } from '@/lib/utils';

export function MessageScroller({ children, items, followOutput, maxHeight, className }: {
  children: ReactNode;
  items: PreviewRailItem[];
  followOutput: boolean;
  maxHeight: number;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(followOutput);
  const [atEnd, setAtEnd] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');
  const sync = useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    const end = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    setAtEnd(end);
    setOverflowing(node.scrollHeight > node.clientHeight + 1);
    const targets = Array.from(node.querySelectorAll<HTMLElement>('[data-activity-id]'));
    const bounds = node.getBoundingClientRect();
    const target = end ? targets.at(-1) : targets.find((element) => element.getBoundingClientRect().bottom > bounds.top + 32);
    if (target?.dataset.activityId) setActiveId(target.dataset.activityId);
  }, []);
  const latest = useCallback(() => {
    following.current = true;
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'auto' });
    sync();
  }, [sync]);
  useLayoutEffect(() => {
    if (followOutput && following.current) latest();
    sync();
  }, [items, followOutput, latest, sync]);
  useEffect(() => {
    const node = content.current;
    const view = viewport.current;
    if (!node || !view) return;
    const observer = new ResizeObserver(() => { if (followOutput && following.current) latest(); else sync(); });
    observer.observe(node);
    observer.observe(view);
    return () => observer.disconnect();
  }, [followOutput, latest, sync]);
  const rail = items.filter((_, i) => i % Math.max(1, Math.ceil(items.length / 14)) === 0 || i === items.length - 1);
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const activeRail = rail.findLast((item) => items.findIndex((entry) => entry.id === item.id) <= activeIndex)?.id ?? rail[0]?.id ?? '';
  return (
    <div data-slot="message-scroller" className="relative min-w-0">
      <div className={cn('relative', overflowing && 'pr-11')}>
      <div ref={viewport} role="region" aria-label="Recorded activity" tabIndex={0}
        onScroll={() => { const node = viewport.current!; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; sync(); }}
        onWheel={(event) => { if (event.deltaY < 0) following.current = false; }}
        onTouchStart={() => { following.current = false; }}
        onTouchEnd={() => { const node = viewport.current!; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; sync(); }}
        onKeyDown={(event) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) following.current = false; }}
        style={{ maxHeight }} className={cn('min-w-0 overflow-y-auto py-1 pr-2 outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', className)}>
        <div ref={content} role="list" className="min-w-0 space-y-1.5">{children}</div>
      </div>
      {overflowing && <PreviewRail items={rail} activeId={activeRail} onSelect={(item) => {
        const node = viewport.current;
        const target = Array.from(node?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? []).find((element) => element.dataset.activityId === item.id);
        if (!node || !target) return;
        following.current = false;
        node.scrollTo({ top: node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top - 8, behavior: 'auto' });
        sync();
      }} />}
      </div>
      {overflowing && <div className="flex min-h-8 items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span className="tabular-nums">Step {Math.max(0, activeIndex) + 1} of {items.length}</span>
        {!atEnd && <button type="button" onClick={latest} className="flex items-center gap-1.5 rounded-md px-2 py-1 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowDown aria-hidden="true" className="size-3" />{followOutput ? 'Latest activity' : 'Last step'}
        </button>}
      </div>}
    </div>
  );
}
