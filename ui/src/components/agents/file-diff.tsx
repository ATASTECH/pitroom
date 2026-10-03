import { Check, ChevronDown, Copy, FileCode2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { FileDiffData, FileDiffLine } from '@/api';
import { AgentCodeLine, fileLanguage, useAgentCodeTokens } from '@/components/agents/agent-code';
import { AgentDisclosure } from '@/components/agents/agent-disclosure';
import { SPRING_PRESS, SPRING_SWAP } from '@/lib/ease';
import { cn } from '@/lib/utils';

function DiffLines({ lines, file }: { lines: FileDiffLine[]; file: string }) {
  const code = lines.map((line) => line.type === 'meta' || line.type === 'hunk' ? '' : line.content).join('\n');
  const tokens = useAgentCodeTokens(code, fileLanguage(file));
  return (
    <div className="w-max min-w-full font-mono text-xs leading-5">
      {lines.map((line, index) => line.type === 'hunk' || line.type === 'meta' ? (
        <div key={line.id} className={cn('whitespace-pre px-3 py-0.5', line.type === 'hunk' ? 'bg-info/5 text-info' : 'text-muted-foreground')}>{line.content}</div>
      ) : (
        <div key={line.id} className={cn('grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]', line.type === 'added' && 'bg-success/10', line.type === 'removed' && 'bg-destructive/10')}>
          <span aria-label={line.oldLine === undefined ? undefined : `Old line ${line.oldLine}`} className="select-none pr-2 text-right tabular-nums text-muted-foreground/60">{line.oldLine}</span>
          <span aria-label={line.newLine === undefined ? undefined : `New line ${line.newLine}`} className="select-none pr-2 text-right tabular-nums text-muted-foreground/60">{line.newLine}</span>
          <span className={cn('select-none text-center', line.type === 'added' ? 'text-success' : line.type === 'removed' ? 'text-destructive' : 'text-muted-foreground')}>
            {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ''}
          </span>
          <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', T: 'Type changed' };

export function FileDiff({ diff, meta, maxHeight = 240, variant = 'plain' }: { diff: FileDiffData; meta?: ReactNode; maxHeight?: number; variant?: 'plain' | 'hover' }) {
  const reduce = useReducedMotion() ?? false;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diff.lines.map((line) => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.type === 'context' ? ' ' : ''}${line.content}`).join('\n'));
      setCopied(true);
      setCopyError(false);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch { setCopyError(true); }
  };

  return (
    <div data-slot="file-diff" data-variant={variant} className="min-w-0 w-full text-sm">
      <button id={`${id}-trigger`} type="button" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => setOpen((value) => !value)}
        className={cn('group flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', variant === 'hover' && 'hover:bg-muted/50')}>
        <FileCode2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span title={diff.path} className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">{diff.path}</span>
        {meta && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{meta}</span>}
        <span title={STATUS[diff.status] ?? diff.status} aria-label={STATUS[diff.status] ?? diff.status} className={cn('shrink-0 font-mono text-[11px]', diff.status === 'A' ? 'text-success' : diff.status === 'D' ? 'text-destructive' : 'text-warning')}>{diff.status}</span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
          {!!diff.additions && <span aria-label={`${diff.additions} added lines`} className="text-success">+{diff.additions}</span>}
          {!!diff.deletions && <span aria-label={`${diff.deletions} removed lines`} className="text-destructive">−{diff.deletions}</span>}
        </span>
        <motion.span aria-hidden animate={{ rotate: open ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING_SWAP} className="shrink-0 text-muted-foreground/60">
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AgentDisclosure id={`${id}-content`} role="region" aria-labelledby={`${id}-trigger`} open={open}>
        {open && <div className="pb-2 pl-6 pt-1.5">
          <div className="overflow-hidden rounded-lg bg-muted/60">
            <div data-slot="file-diff-viewport" tabIndex={0} aria-label={`Diff for ${diff.path}`} className="overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" style={{ maxHeight }}>
              <DiffLines lines={diff.lines} file={diff.path} />
              {diff.binary && <p className="px-3 py-3 text-xs text-muted-foreground">Binary file changed. No text diff is available.</p>}
              {diff.unavailable && <p className="px-3 py-3 text-xs text-muted-foreground">No text diff is available for this file.</p>}
              {!diff.binary && !diff.unavailable && !diff.lines.length && <p className="px-3 py-3 text-xs text-muted-foreground">No text changes.</p>}
            </div>
            {(diff.omittedLines > 0 || diff.incomplete) && <p className="px-3 pt-2 text-xs text-muted-foreground">
              {diff.omittedLines > 0 ? `${diff.omittedLines} more diff rows are outside this preview.` : 'Only part of this file’s diff is available.'}
              {diff.incomplete && diff.omittedLines > 0 && ' The saved diff is also incomplete.'}
            </p>}
            {diff.lines.length > 0 && !diff.binary && <div className="flex items-center justify-end gap-2 px-2 py-1">
              {copyError && <span role="alert" className="text-xs text-destructive">Could not copy the diff.</span>}
              <motion.button type="button" aria-label={copied ? 'Copied' : 'Copy shown diff'} title={copied ? 'Copied' : 'Copy shown diff'} onClick={() => void copy()}
                whileTap={reduce ? undefined : { scale: 0.96 }} transition={SPRING_PRESS}
                className="grid size-9 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </motion.button>
            </div>}
          </div>
        </div>}
      </AgentDisclosure>
    </div>
  );
}
