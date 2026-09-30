// `pitroom doctor`: core checks (git, config, guard, skill) plus each worker
// backend in the configured chain checking itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBackend } from '../backends/index.js';
import type { DoctorCheck, Target } from '../backends/types.js';
import { gitAvailable } from '../vcs/git.js';
import { guardEnv, shimDir } from '../vcs/guard.js';
import { resolveChain } from './chain.js';
import { configPath, effective, loadConfig } from './config.js';
import { installedSkills, launcherPath, skillNames } from './install.js';
import { VERSION } from './run.js';
import { home } from './store.js';
import { describeTarget } from './target.js';

const MARK: Record<DoctorCheck['level'], string> = { ok: '✔', warn: '!', fail: '✘' };

const READ_ONLY_HOW: Record<string, string> = {
  'permission-rules': 'per-run permission rules',
  'os-sandbox': 'an OS sandbox',
  'tool-allowlist': 'a tool allowlist',
  'approval-mode': "the CLI's read-only approval mode",
};

export function doctor(probe: boolean): number {
  const checks: DoctorCheck[] = [];
  const add = (level: DoctorCheck['level'], message: string) => checks.push({ level, message });

  add('ok', `pitroom ${VERSION} · node ${process.versions.node} · state in ${home()}`);
  add(gitAvailable() ? 'ok' : 'warn', gitAvailable() ? 'git available' : 'git not found: --write/--isolate tracking disabled');
  const cfg = loadConfig();
  add(cfg.warnings.length ? 'warn' : 'ok', `config: ${configPath()}${fs.existsSync(configPath()) ? '' : ' (not present, defaults in use)'}`);
  for (const w of cfg.warnings) add('warn', w);
  if (process.platform !== 'win32') {
    const guarded = guardEnv(process.env).PATH?.startsWith(shimDir());
    add(guarded ? 'ok' : 'warn', guarded ? 'git guard shim ready' : 'git guard unavailable (git not on PATH)');
  }

  // The worker chain, grouped per backend so each backend checks its own models once.
  const chain: Target[] = [];
  try {
    const resolved = resolveChain();
    chain.push(resolved.worker, ...resolved.fallback);
    for (const w of resolved.warnings) add('warn', w);
  } catch (e) {
    add('fail', (e as Error).message);
  }
  if (chain.length) add('ok', `worker chain: ${chain.map(describeTarget).join(' → ')}`);
  // Tier workers (config "tiers") are checked like the chain's; a broken tier is one failed
  // check, not the end of the diagnosis.
  const tierTargets: Target[] = [];
  const tierNames: string[] = [];
  for (const name of Object.keys(effective().tiers.value)) {
    try {
      tierTargets.push(resolveChain({ tier: name, noFallback: true }).worker);
      tierNames.push(name);
    } catch (e) {
      add('fail', `tier "${name}": ${(e as Error).message}`);
    }
  }
  if (tierNames.length) add('ok', `tiers: ${tierNames.map((name, i) => `${name}=${describeTarget(tierTargets[i]!)}`).join(', ')}`);
  const byBackend = new Map<string, (string | undefined)[]>();
  for (const t of [...chain, ...tierTargets]) byBackend.set(t.backend, [...(byBackend.get(t.backend) ?? []), t.model]);
  for (const [id, models] of byBackend) {
    let backend;
    try {
      backend = getBackend(id);
    } catch (e) {
      add('fail', (e as Error).message);
      continue;
    }
    checks.push(...backend.doctor({ models: [...new Set(models)], hasFallback: chain.length > 1 }));
    add('ok', `${backend.name}: read-only runs enforced by ${READ_ONLY_HOW[backend.capabilities.readOnly]}`);
  }

  checks.push(...skillChecks());

  if (probe && chain[0]) checks.push(liveProbe(chain[0]));
  for (const c of checks) console.log(`${MARK[c.level]} ${c.message}`);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/** One real, read-only round trip through the preferred worker. */
function liveProbe(target: Target): DoctorCheck {
  let backend;
  try {
    backend = getBackend(target.backend);
  } catch (e) {
    return { level: 'fail', message: (e as Error).message };
  }
  const inv = backend.invocation({
    mode: 'read',
    prompt: 'Reply with exactly: PONG',
    cwd: process.cwd(),
    model: target.model,
    files: [],
    web: false,
    title: 'pitroom doctor probe',
  });
  const t0 = Date.now();
  const r = spawnSync(inv.command, inv.args, {
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: guardEnv({ ...process.env, ...inv.env, PWD: process.cwd(), PITROOM_ACTIVE: '1' }),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const run = backend.parse(r.stdout ?? '');
  if (run.finalText.includes('PONG')) return { level: 'ok', message: `live probe (${describeTarget(target)}) answered in ${secs}s` };
  const why = backend.failure(run, r.stderr ?? '', r.status)?.message ?? run.finalText.slice(0, 200);
  return { level: 'fail', message: `live probe (${describeTarget(target)}) failed after ${secs}s: ${why}` };
}

/** Are the skills and the CLI reachable for agents, and is there exactly one copy of the skills? */
function skillChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const all = skillNames();
  const viaPlugin = pluginInstalled();
  const superpowers = superpowersActive();
  if (superpowers.length) {
    checks.push({
      level: 'warn',
      message: `superpowers is installed too (${superpowers.join(', ')}): two bootstraps compete for the same work; keep one (Pitroom includes the superpowers workflow)`,
    });
  }
  for (const { base, names } of installedSkills()) {
    if (names.length === all.length) checks.push({ level: 'ok', message: `skills in ${base}: ${names.join(', ')}` });
    else if (names.length) checks.push({ level: 'warn', message: `skills in ${base}: only ${names.join(', ')} of ${all.length}; run \`pitroom install\`` });
    else if (!viaPlugin) checks.push({ level: 'warn', message: `no Pitroom skills in ${base}; run \`pitroom install\`` });
  }
  if (viaPlugin) {
    const linked = installedSkills().some((i) => i.base.includes(`${path.sep}.claude${path.sep}`) && i.names.length);
    checks.push(
      linked
        ? { level: 'warn', message: 'Pitroom is installed as a Claude Code plugin and linked into ~/.claude/skills: skills load twice; run `pitroom uninstall` or remove the plugin' }
        : { level: 'ok', message: 'Claude Code plugin installed (skills + session-start hook)' },
    );
  }
  const launcher = launcherPath();
  if (fs.existsSync(launcher)) {
    const r = spawnSync(launcher, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    checks.push(
      r.status === 0
        ? { level: 'ok', message: `launcher ${launcher} → pitroom ${r.stdout.trim()}` }
        : { level: 'fail', message: `launcher ${launcher} does not start: ${(r.stderr || r.stdout).trim().slice(0, 200)}` },
    );
  } else {
    checks.push({ level: 'warn', message: 'no `pitroom` launcher on PATH: run `pitroom install`' });
  }
  return checks;
}

function pluginInstalled(): boolean {
  try {
    const f = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const plugins = JSON.parse(fs.readFileSync(f, 'utf8')).plugins ?? {};
    return Object.keys(plugins).some((k) => k.startsWith('pitroom@'));
  } catch {
    return false;
  }
}

/**
 * Where superpowers is active next to Pitroom. A plugin that is installed but disabled
 * (Claude Code, Codex) or not listed (OpenCode) loads nothing, so it does not compete
 * with Pitroom's bootstrap and is not reported.
 */
function superpowersActive(): string[] {
  const found: string[] = [];
  for (const key of claudePlugins()) {
    if (key.startsWith('superpowers@') && claudePluginEnabled(key)) found.push(`Claude Code plugin ${key}`);
  }
  for (const [key, enabled] of codexPlugins()) {
    if (key.startsWith('superpowers@') && enabled) found.push(`Codex plugin ${key}`);
  }
  for (const p of openCodePlugins()) {
    if (/superpowers/i.test(p)) found.push(`OpenCode plugin ${p}`);
  }
  for (const base of [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
    const dir = path.join(base, 'using-superpowers');
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) found.push(dir);
  }
  return found;
}

function claudePlugins(): string[] {
  try {
    const f = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    return Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).plugins ?? {});
  } catch {
    return []; // no Claude Code plugins
  }
}

/** False only when the user's Claude Code settings turn the plugin off. */
function claudePluginEnabled(key: string): boolean {
  try {
    const f = path.join(os.homedir(), '.claude', 'settings.json');
    return JSON.parse(fs.readFileSync(f, 'utf8')).enabledPlugins?.[key] !== false;
  } catch {
    return true;
  }
}

/**
 * Codex plugins from `[plugins."name@marketplace"]` tables in config.toml, with their
 * `enabled` flag (a table without one counts as enabled). A line scan is enough for these
 * flat tables and keeps Pitroom free of a TOML dependency.
 */
function codexPlugins(): Map<string, boolean> {
  const plugins = new Map<string, boolean>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
  } catch {
    return plugins; // no Codex config
  }
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[(.*)\]\s*(#.*)?$/.exec(line);
    if (table) {
      current = /^plugins\."([^"]+)"$/.exec(table[1]!.trim())?.[1];
      if (current) plugins.set(current, true);
      continue;
    }
    const flag = current && /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (flag) plugins.set(current!, flag[1] === 'true');
  }
  return plugins;
}

/** OpenCode plugins: the `plugin` list of opencode.json(c) and the files in its plugin folders. */
function openCodePlugins(): string[] {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'opencode');
  const plugins: string[] = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      // opencode.jsonc may carry comments; strip them before parsing.
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      const list: unknown = JSON.parse(text).plugin;
      if (Array.isArray(list)) plugins.push(...list.filter((p): p is string => typeof p === 'string'));
    } catch {
      // no such config, or one we cannot read
    }
  }
  for (const folder of ['plugin', 'plugins']) {
    try {
      for (const f of fs.readdirSync(path.join(dir, folder))) plugins.push(path.join(dir, folder, f));
    } catch {
      // no plugin folder
    }
  }
  return plugins;
}
