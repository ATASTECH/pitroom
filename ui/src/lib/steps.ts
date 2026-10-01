import { IconMessage, IconTool } from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { toolRegistry } from '@/components/agent-elements/tools/tool-registry';
import type { Step } from '@/api';

export interface StepMeta {
  Icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  group: 'file' | 'search' | 'command' | 'other';
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Maps one worker step onto Agent Elements' tool vocabulary (icon, title, subtitle). */
export function stepMeta(s: Step): StepMeta {
  if (s.kind === 'say') return { Icon: IconMessage, title: 'Said', subtitle: clip(s.text), group: 'other' };
  const name = (s.name ?? '').toLowerCase();
  let type: string | undefined;
  let input: Record<string, string> = {};
  let group: StepMeta['group'] = 'other';
  if (s.kind === 'shell') [type, input, group] = ['tool-Bash', { command: s.text }, 'command'];
  else if (s.kind === 'edit') [type, input, group] = ['tool-Write', { file_path: s.text.split(', ')[0] ?? s.text }, 'file'];
  else if (/^(read|cat|view|open)$/.test(name)) [type, input, group] = ['tool-Read', { file_path: s.text }, 'file'];
  else if (/grep|search|rg|codesearch/.test(name)) [type, input, group] = ['tool-Grep', { pattern: s.text }, 'search'];
  else if (/glob|list|ls|tree|find/.test(name)) [type, input, group] = ['tool-Glob', { pattern: s.text }, 'search'];
  else if (/webfetch|fetch/.test(name)) [type, input] = ['tool-WebFetch', { url: s.text }];
  else if (/websearch/.test(name)) [type, input, group] = ['tool-WebSearch', { query: s.text }, 'search'];
  const meta = type ? toolRegistry[type] : undefined;
  if (meta && type) {
    const part = { type, state: 'output-available', input };
    return { Icon: meta.icon, title: meta.title(part), subtitle: meta.subtitle?.(part) ?? '', group };
  }
  return { Icon: IconTool, title: s.name ?? 'Tool', subtitle: clip(s.text), group };
}

const n = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** "3 files, 2 searches and 1 command" */
export function summarize(steps: Step[]): string {
  const c = { file: 0, search: 0, command: 0 };
  for (const s of steps) {
    const g = stepMeta(s).group;
    if (g !== 'other') c[g]++;
  }
  const parts = [c.file && n(c.file, 'file'), c.search && n(c.search, 'search', 'searches'), c.command && n(c.command, 'command')].filter(Boolean) as string[];
  if (!parts.length) return steps.length ? n(steps.length, 'step') : '';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}
