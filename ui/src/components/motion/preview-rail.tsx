import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRef, useState } from 'react';
import { EASE_OUT, SPRING_LAYOUT } from '@/lib/ease';

export interface PreviewRailItem {
  id: string;
  label: string;
  description?: string;
}

export function PreviewRail({ items, activeId, onSelect }: {
  items: PreviewRailItem[];
  activeId: string;
  onSelect: (item: PreviewRailItem) => void;
}) {
  const [previewId, setPreviewId] = useState<string>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const reduce = useReducedMotion();
  const preview = items.find((item) => item.id === previewId);
  const highlighted = items.findIndex((item) => item.id === (previewId ?? activeId));
  return (
    <nav aria-label="Activity navigation" className="absolute inset-y-2 right-2 z-10 flex w-7 flex-col justify-center"
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') setPreviewId(undefined); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(undefined); }}>
      {items.map((item, index) => {
        const distance = Math.abs(index - highlighted);
        return <button key={item.id} type="button" ref={(node) => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id); }}
          aria-label={`Go to ${item.label}`} aria-current={activeId === item.id ? 'location' : undefined}
          onPointerEnter={(event) => { if (event.pointerType === 'mouse') setPreviewId(item.id); }}
          onFocus={() => setPreviewId(item.id)} onClick={() => { setPreviewId(item.id); onSelect(item); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setPreviewId(undefined); return; }
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : undefined;
            if (next !== undefined) { event.preventDefault(); buttons.current.get(items[next]!.id)?.focus(); }
          }}
          className="flex h-5 w-7 shrink-0 items-center justify-end rounded-sm px-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <motion.span aria-hidden="true" className={`h-px w-5 origin-right bg-current ${distance === 0 ? 'text-foreground' : ''}`}
            animate={{ scaleX: distance === 0 ? 1 : distance === 1 ? 0.7 : distance === 2 ? 0.45 : 0.25 }} transition={reduce ? { duration: 0 } : SPRING_LAYOUT} />
        </button>;
      })}
      <AnimatePresence>
        {preview && <motion.div key={preview.id} aria-hidden="true" initial={{ opacity: 0, x: reduce ? 0 : 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.12, ease: EASE_OUT }}
          className="pointer-events-none absolute right-8 top-1/2 w-52 max-w-[calc(100vw-8rem)] -translate-y-1/2 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
          <p className="font-medium">{preview.label}</p>
          {preview.description && <p className="mt-1 line-clamp-3 [overflow-wrap:anywhere] leading-5 text-muted-foreground">{preview.description}</p>}
        </motion.div>}
      </AnimatePresence>
    </nav>
  );
}
