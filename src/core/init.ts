// `pitroom init`: looks at the worker CLIs on this machine and proposes a starter config. Pitroom never picks
// a model by itself: models come from the user's own OpenCode catalogue, are only suggested, and nothing is
// written without --yes.
import fs from 'node:fs';
import path from 'node:path';
import { backendIds, getBackend } from '../backends/index.js';
import { type PitroomConfig, configPath } from './config.js';
import { UserError } from './errors.js';
import { bold, dim, green, yellow } from './style.js';

export interface InitPlan {
  path: string;
  exists: boolean;
  workers: { id: string; name: string; found: boolean; binary: string }[];
  opencode?: { defaultModel?: string; models: number; free: string[] };
  config: PitroomConfig;
  /** Why nothing can be written yet (the user has to choose first). */
  blocked?: string;
  notes: string[];
}

const FREE = /-free$/;
const TIER_ORDER: [string, string][] = [['cheap', 'opencode'], ['standard', 'codex'], ['capable', 'claude']];

const isFound = (binary: string) => path.isAbsolute(binary) && fs.existsSync(binary);

export function planInit(opts: { model?: string; fallback?: string[] } = {}): InitPlan {
  const file = configPath();
  const workers = backendIds().map((id) => {
    const b = getBackend(id);
    const binary = b.binary();
    return { id, name: b.name, found: isFound(binary), binary };
  });
  const notes: string[] = [];
  const config: PitroomConfig = {};
  let blocked: string | undefined;
  let opencode: InitPlan['opencode'];

  if (workers.find((w) => w.id === 'opencode')?.found) {
    const b = getBackend('opencode');
    let models: string[] = [];
    try {
      models = b.listModels?.() ?? [];
    } catch {
      notes.push('could not list OpenCode models (is it logged in?)');
    }
    const defaultModel = b.defaultModel?.();
    const chosen = opts.model ?? defaultModel;
    const free = models.filter((m) => FREE.test(m) && m !== chosen);
    opencode = { defaultModel, models: models.length, free: free.slice(0, 6) };

    if (opts.model) {
      if (models.length && !models.includes(opts.model)) throw new UserError(`"${opts.model}" is not in \`opencode models\``);
      if (!models.length) notes.push(`could not check "${opts.model}": \`opencode models\` listed nothing`);
      config.models = { opencode: opts.model };
    } else if (!defaultModel) {
      blocked = `OpenCode has no default model: choose one with --model <id>${free.length ? ` (free models you have: ${free.slice(0, 4).join(', ')})` : ''}`;
    }

    // Workers that take over when the first one is rate-limited or its model is removed.
    const fallback = opts.fallback ?? free.slice(0, 2);
    for (const m of fallback) {
      if (models.length && !models.includes(m)) throw new UserError(`"${m}" is not in \`opencode models\``);
    }
    if (fallback.length) {
      config.fallback = fallback.map((m) => `opencode:${m}`);
      if (!opts.fallback) notes.push(`fallback suggested from the free models in your catalogue: ${fallback.join(', ')} (change it with --fallback a,b)`);
    } else {
      notes.push('no fallback: no free OpenCode model found to suggest (pass --fallback a,b to name some)');
    }
  }

  // Tiers name a worker per kind of task (plans use them): only worth proposing when more than one worker exists.
  const tiers = Object.fromEntries(TIER_ORDER.filter(([, id]) => workers.find((w) => w.id === id)?.found));
  if (Object.keys(tiers).length > 1) config.tiers = tiers;
  if (!workers.some((w) => w.found)) blocked = 'no worker CLI found: install OpenCode (https://opencode.ai), Codex CLI or Claude Code first';
  else if (!blocked && !Object.keys(config).length) notes.push('nothing to propose: the default model and the single worker need no config');

  return { path: file, exists: fs.existsSync(file), workers, opencode, config, blocked, notes };
}

/** Writes the proposal. An existing file is only replaced with `force`, and kept next to it as `.bak`. */
export function writeInit(plan: InitPlan, force: boolean): string {
  if (plan.blocked) throw new UserError(plan.blocked);
  if (!Object.keys(plan.config).length) throw new UserError('nothing to write: the proposal is empty');
  if (plan.exists && !force) throw new UserError(`${plan.path} already exists: pass --force to replace it (the old file is kept as ${path.basename(plan.path)}.bak)`);
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  if (plan.exists) fs.copyFileSync(plan.path, `${plan.path}.bak`);
  fs.writeFileSync(plan.path, `${JSON.stringify(plan.config, null, 2)}\n`);
  return plan.path;
}

export function formatInit(plan: InitPlan, written?: string): string {
  const out: string[] = [bold('pitroom init') + dim(': worker CLIs on this machine')];
  for (const w of plan.workers) out.push(`  ${w.found ? green('✔') : dim('·')} ${w.name.padEnd(12)} ${w.found ? w.binary : dim('not found')}`);
  if (plan.opencode) {
    const o = plan.opencode;
    out.push(`  OpenCode: ${o.models} models, default ${o.defaultModel ?? 'none'}${o.free.length ? `, free: ${o.free.slice(0, 3).join(', ')}${o.free.length > 3 ? ', …' : ''}` : ''}`);
  }
  out.push('', `config file: ${plan.path}${plan.exists ? ' (exists)' : ' (not present)'}`, JSON.stringify(plan.config, null, 2));
  for (const n of plan.notes) out.push(`  note: ${n}`);
  if (written) out.push('', green(`✔ written to ${written}`), dim('  next: pitroom doctor, then pitroom install'));
  else if (plan.blocked) out.push('', yellow(`! ${plan.blocked}`));
  else out.push('', `nothing written yet: pass --yes to write it${plan.exists ? ' (with --force, since the file exists)' : ''}`);
  return out.join('\n');
}
