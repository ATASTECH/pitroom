import { Eye, FolderSearch, Globe, MessageSquare, PencilLine, Search, SquareTerminal, Wrench } from 'lucide-react';
import type { Step } from '@/api';
import type { AgentActivityItem } from '@/components/agents/agent-activity';
import { clock } from '@/lib/format';

const cls = 'size-4';

function describe(s: Step): { kind: string; label: string; icon: React.ReactNode } {
  const name = (s.name ?? '').toLowerCase();
  if (s.kind === 'say') return { kind: 'message', label: 'Said', icon: <MessageSquare className={cls} /> };
  if (s.kind === 'shell') return { kind: 'run', label: 'Ran command', icon: <SquareTerminal className={cls} /> };
  if (s.kind === 'edit') return { kind: 'write', label: 'Edited', icon: <PencilLine className={cls} /> };
  if (/^(read|cat|view|open)$/.test(name)) return { kind: 'read', label: 'Read', icon: <Eye className={cls} /> };
  if (/grep|search|rg/.test(name) && !/web/.test(name)) return { kind: 'tool', label: 'Searched', icon: <Search className={cls} /> };
  if (/glob|list|ls|tree|find/.test(name)) return { kind: 'tool', label: 'Listed files', icon: <FolderSearch className={cls} /> };
  if (/web|fetch/.test(name)) return { kind: 'tool', label: 'Fetched', icon: <Globe className={cls} /> };
  return { kind: 'tool', label: s.name ?? 'Tool', icon: <Wrench className={cls} /> };
}

/** The worker's steps as beUI's Agent Activity trace rows (icon, label with its time offset, the path or command). */
export function traceItems(steps: Step[]): AgentActivityItem[] {
  return steps.map((s, i) => {
    const d = describe(s);
    return {
      id: `step-${i}`,
      type: 'trace',
      kind: d.kind,
      icon: d.icon,
      label: (
        <>
          {d.label}
          {s.ok === false && <span className="ml-1.5 text-xs font-normal text-destructive">failed</span>}
          {s.t != null && <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground/60">+{clock(s.t)}</span>}
        </>
      ),
      detail: s.text.length > 200 ? `${s.text.slice(0, 199)}…` : s.text,
    };
  });
}
