// Structured lines in worker answers for plan work (see the templates in
// skills/pitroom-driven-development and skills/pitroom-review).

export const TASK_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number] | 'unknown';

/** The implementer's `STATUS:` line. */
export function parseStatus(text: string): TaskStatus {
  const value = /^\s*STATUS:\s*([A-Za-z_]+)/im.exec(text)?.[1]?.toUpperCase() ?? '';
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : 'unknown';
}

export interface Verdict {
  spec: 'pass' | 'fail' | 'unknown';
  quality: 'approved' | 'needs-fixes' | 'unknown';
  critical: number;
  important: number;
  minor: number;
}

/** A reviewer's `SPEC: … · QUALITY: … · ISSUES: …` summary line. */
export function parseVerdict(text: string): Verdict {
  const spec = /\bSPEC:\s*(PASS|FAIL)\b/i.exec(text)?.[1]?.toLowerCase();
  const quality = /\bQUALITY:\s*(APPROVED|NEEDS[_ -]?FIXES)\b/i.exec(text)?.[1]?.toUpperCase();
  const count = (k: string) => Number(new RegExp(`\\b${k}=(\\d+)`, 'i').exec(text)?.[1] ?? 0);
  return {
    spec: spec === 'pass' || spec === 'fail' ? spec : 'unknown',
    quality: quality === 'APPROVED' ? 'approved' : quality ? 'needs-fixes' : 'unknown',
    critical: count('critical'),
    important: count('important'),
    minor: count('minor'),
  };
}
