import { useState } from 'react';
import type { Step } from '@/api';
import { GenericTool } from '@/components/agent-elements/tools/generic-tool';
import { ToolRowBase } from '@/components/agent-elements/tools/tool-row-base';
import { Badge } from '@/components/ui/badge';
import { clock } from '@/lib/format';
import { stepMeta, summarize } from '@/lib/steps';

/** What the worker did, step by step: Agent Elements' row (collapsible, shimmer while running) with a tool row per step. */
export function WorkerActivity({ steps, running }: { steps: Step[]; running: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <ToolRowBase
      completeLabel="Worker activity"
      shimmerLabel="Working"
      isAnimating={running}
      detail={summarize(steps)}
      expandable
      expanded={open}
      onToggleExpand={() => setOpen((o) => !o)}
    >
      <ol className="relative ml-1 space-y-1 border-l border-border pl-3">
        {steps.map((s, i) => {
          const { Icon, title, subtitle } = stepMeta(s);
          return (
            <li key={i} className="flex items-center gap-2 animate-in fade-in slide-in-from-left-1 fill-mode-both" style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }}>
              <div className="min-w-0 flex-1">
                <GenericTool icon={Icon} title={title} subtitle={subtitle} isPending={running && i === steps.length - 1} isError={s.ok === false} />
              </div>
              {s.ok === false && <Badge variant="destructive">failed</Badge>}
              {s.t != null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">+{clock(s.t)}</span>}
            </li>
          );
        })}
      </ol>
    </ToolRowBase>
  );
}
