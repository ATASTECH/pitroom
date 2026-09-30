// Argument parsing and the pieces every command shares.
import fs from 'node:fs';
import type { Mode } from '../backends/types.js';
import { effective } from '../core/config.js';
import { UserError } from '../core/errors.js';
import type { RunOptions } from '../core/run.js';
import { type RunMeta, resolveRun } from '../core/store.js';

export interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const VALUE_FLAGS: Record<string, string> = {
  '-d': 'dir', '--dir': 'dir', '-f': 'file', '--file': 'file', '-m': 'model', '--model': 'model',
  '-W': 'worker', '--worker': 'worker', '--tier': 'tier', '-g': 'group', '--group': 'group',
  '-t': 'timeout', '--timeout': 'timeout', '--verify': 'verify', '--link': 'link', '-c': 'continue',
  '--continue': 'continue', '--task-file': 'task-file', '--since': 'since', '--card': 'card', '--days': 'days',
  '--interval': 'interval', '--range': 'range',
  '--plan': 'plan', '--step': 'step',
};

const BOOL_FLAGS: Record<string, string> = {
  '-r': 'read', '--read': 'read', '-w': 'write', '--write': 'write', '-i': 'isolate', '--isolate': 'isolate',
  '--bg': 'bg', '--web': 'web', '--no-fallback': 'no-fallback', '--json': 'json', '--allow-non-git': 'allow-non-git',
  '--patch': 'patch', '--events': 'events', '--full': 'full', '--badge': 'badge', '--probe': 'probe',
  '--copy': 'copy', '--force': 'force', '--yes': 'yes', '--any': 'any', '--brief': 'brief', '--running': 'running',
  '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version',
};

export function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const set = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const [name, inline] =
      a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (VALUE_FLAGS[name]) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UserError(`${name} needs a value`);
      set(VALUE_FLAGS[name]!, v);
    } else if (BOOL_FLAGS[name]) {
      set(BOOL_FLAGS[name]!, 'true');
    } else if (a.startsWith('-') && a !== '-') {
      throw new UserError(`unknown option ${a} (see pitroom --help)`);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export const flag = (p: Parsed, k: string) => p.flags.get(k)?.at(-1);
export const has = (p: Parsed, k: string) => p.flags.has(k);

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(s.trim());
  if (!m) throw new UserError(`bad duration "${s}" (use e.g. 900, 20m, 1h)`);
  return Math.round(Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[(m[2] ?? 's').toLowerCase()] ?? 1));
}

export function exitCodeFor(meta: RunMeta): number {
  switch (meta.state) {
    case 'queued':
    case 'running':
      return 75;
    case 'timeout':
      return 4;
    case 'failed':
    case 'stopped':
      return 1;
    default:
      if (meta.warnings.some((w) => w.startsWith('READ-ONLY VIOLATION'))) return 5;
      if (meta.verifyResult && !meta.verifyResult.ok) return 6;
      return 0;
  }
}

export function readTask(p: Parsed): string {
  const file = flag(p, 'task-file');
  if (file) return fs.readFileSync(file, 'utf8');
  // stdin is read only on an explicit "-": agents often leave an idle pipe open,
  // and reading it implicitly would hang forever.
  const words = p.positional;
  if (words.length === 1 && words[0] === '-') return fs.readFileSync(0, 'utf8');
  return words.join(' ');
}

export function runOptions(p: Parsed, task: string): RunOptions {
  const modes = (['read', 'write', 'isolate'] as Mode[]).filter((m) => has(p, m));
  if (modes.length > 1) throw new UserError('choose one of --read, --write, --isolate');
  const cont = flag(p, 'continue');
  return {
    mode: modes[0] ?? 'read',
    task,
    dir: flag(p, 'dir') ?? process.cwd(),
    files: p.flags.get('file') ?? [],
    link: p.flags.has('link')
      ? (p.flags.get('link') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
      : effective().link.value,
    worker: flag(p, 'worker'),
    model: flag(p, 'model'),
    tier: flag(p, 'tier'),
    timeoutSec: parseDuration(effective({ timeout: flag(p, 'timeout') }).timeout.value),
    verify: flag(p, 'verify'),
    continueFrom: cont ? resolveRun(cont) : undefined,
    allowNonGit: has(p, 'allow-non-git'),
    web: has(p, 'web') || effective().web.value,
    noFallback: has(p, 'no-fallback'),
    group: flag(p, 'group'),
  };
}

/** `--plan PLAN --step N`: one task of an implementation plan. */
export function planStep(p: Parsed): { file: string; step: number } | undefined {
  const file = flag(p, 'plan');
  const step = flag(p, 'step');
  if (!file && !step) return undefined;
  if (!file || !step) throw new UserError('--plan and --step go together: pitroom run -i --plan PLAN.md --step N');
  if (!/^\d+$/.test(step)) throw new UserError(`--step takes a task number, not "${step}"`);
  return { file, step: Number(step) };
}
