// `pitroom doctor`: core checks (git, config, guard, skill) plus each worker
// backend in the configured chain checking itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allBackends, getBackend } from '../backends/index.js';
import type { DoctorCheck, Target } from '../backends/types.js';
import { gitAvailable } from '../vcs/git.js';
import { guardEnv, shimDir } from '../vcs/guard.js';
import { pickAuditor } from './audit.js';
import { activeCooldowns, untilText } from './cooldown.js';
import { resolveChain } from './chain.js';
import { configPath, effective, loadConfig } from './config.js';
import { installedSkills, launcherPath, skillNames } from './install.js';
import { mcpStatus } from './mcp-install.js';
import { VERSION } from './run.js';
import { type RunMeta, home } from './store.js';
import { bold, cyan, dim, green, red, wrapText, yellow } from './style.js';
import { describeTarget } from './target.js';

const MARK: Record<DoctorCheck['level'], () => string> = { ok: () => green('✔'), warn: () => yellow('!'), fail: () => red('✘') };

type Row = DoctorCheck & { section: string };

/** Commands the findings point to, shown once under "Next". */
const NEXT: { when: RegExp; command: string; why: string }[] = [
  { when: /no default model|no fallback workers/, command: 'pitroom init', why: 'propose a starter config (fallback models from your catalogue)' },
  { when: /pitroom install|no Pitroom skills|launcher on PATH/, command: 'pitroom install', why: 'link the skills and the pitroom command' },
  { when: /first `node` on PATH/, command: 'nvm alias default 24', why: 'a current Node first in every new shell' },
  { when: /not logged in/, command: 'claude auth login', why: 'sign in the Claude Code worker (Codex: codex login)' },
  { when: /Gemini CLI is not signed in|IneligibleTierError/, command: 'export GEMINI_API_KEY=…', why: 'a Google AI Studio key for the Gemini worker' },
];

/** The first `node` a shell would run, and its version (agent apps start such shells). */
function firstNodeOnPath(): { path: string; version: string } | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const r = spawnSync(file, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? { path: file, version: r.stdout.trim() } : { path: file, version: '' };
  }
  return undefined;
}
const tooOld = (v: string) => {
  const [a = 0, b = 0] = v.split('.').map(Number);
  return a < 22 || (a === 22 && b < 13);
};

const READ_ONLY_HOW: Record<string, string> = {
  'permission-rules': 'per-run permission rules',
  'os-sandbox': 'an OS sandbox',
  'tool-allowlist': 'a tool allowlist',
  'approval-mode': "the CLI's read-only approval mode",
};

export function doctor(probe: boolean): number {
  const checks: Row[] = [];
  let current = 'Setup';
  const section = (name: string) => void (current = name);
  const add = (level: DoctorCheck['level'], message: string) => checks.push({ level, message, section: current });
  const addAll = (list: DoctorCheck[]) => list.forEach((c) => add(c.level, c.message));

  add('ok', `pitroom ${VERSION} · node ${process.versions.node} · state in ${home()}`);
  const onPath = firstNodeOnPath();
  if (onPath && onPath.version && tooOld(onPath.version) && path.resolve(onPath.path) !== path.resolve(process.execPath)) {
    add('warn', `the first \`node\` on PATH is v${onPath.version} (${onPath.path}), older than the 22.13 Pitroom needs: shells that agent apps start may use it (the pitroom command finds a newer Node itself; other tools may not)`);
  }
  add(gitAvailable() ? 'ok' : 'warn', gitAvailable() ? 'git available' : 'git not found: --write/--isolate tracking disabled');
  const cfg = loadConfig();
  add(cfg.warnings.length ? 'warn' : 'ok', `config: ${configPath()}${fs.existsSync(configPath()) ? '' : ' (not present, defaults in use)'}`);
  for (const w of cfg.warnings) add('warn', w);
  if (process.platform === 'win32') {
    add('warn', "git guard: not available on Windows yet, so Pitroom does not block a worker's git history changes or pushes there (read-only runs are still limited by each worker CLI's own rules, and --isolate keeps edits in a copy); prefer --isolate and check the patch before apply");
  } else {
    const guarded = guardEnv(process.env).PATH?.startsWith(shimDir());
    add(guarded ? 'ok' : 'warn', guarded ? 'git guard shim ready' : 'git guard unavailable (git not on PATH)');
  }

  // The worker chain, grouped per backend so each backend checks its own models once.
  section('Worker chain');
  const chain: Target[] = [];
  try {
    const resolved = resolveChain();
    chain.push(resolved.worker, ...resolved.fallback);
    for (const w of resolved.warnings) add('warn', w);
  } catch (e) {
    add('fail', (e as Error).message);
  }
  if (chain.length) add('ok', `worker chain: ${chain.map(describeTarget).join(' → ')}`);
  // Audits (config "audit") need a worker other than the one that answered: say when there is none.
  const rate = effective().audit.value;
  if (rate > 0 && chain.length) {
    const auditor = pickAuditor({ worker: chain[0]!, fallback: chain.slice(1) } as RunMeta);
    add(auditor ? 'ok' : 'warn', auditor ? `audit: ${Math.round(rate * 100)}% of read runs are re-checked by ${auditor}` : `audit is on (${Math.round(rate * 100)}%) but no other worker could do it: add tiers "audit" or "cheap", or a fallback, that differs from ${describeTarget(chain[0]!)}`);
  }
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
  // Costs you entered: show what the models in use cost and whether you priced a cheaper one of the same worker.
  const costs = effective().costs.value;
  if (Object.keys(costs).length) {
    for (const t of [...chain, ...tierTargets]) {
      const key = `${t.backend}:${(t.model ?? '').split('#')[0]}`;
      const mine = costs[key];
      if (mine === undefined) continue;
      const cheaper = Object.entries(costs).filter(([k, v]) => k.startsWith(`${t.backend}:`) && v < mine).sort((a, b) => a[1] - b[1])[0];
      add('ok', `cost: ${key} = ${mine}${cheaper ? `; you priced ${cheaper[0]} cheaper (${cheaper[1]}): is the dearer one needed?` : ''}`);
    }
  }
  // Models skipped for now because they said "rate limited": say so, with when they come back.
  for (const c of Object.values(activeCooldowns())) {
    add('warn', `${c.target} is cooling down ${untilText(c)} (${c.reason.slice(0, 80)}): runs skip it while a fallback is left; \`pitroom cooldown --clear\` tries it again`);
  }
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
    section(backend.name);
    addAll(backend.doctor({ models: [...new Set(models)], hasFallback: chain.length > 1 }));
    add('ok', `${backend.name}: read-only runs enforced by ${READ_ONLY_HOW[backend.capabilities.readOnly]}`);
  }

  // Worker CLIs that are installed but not in the config: say so, so a new worker is not invisible (a problem with
  // one is not a problem with this setup, so nothing here counts as a warning).
  const unused = allBackends().filter((b) => !byBackend.has(b.id));
  for (const backend of unused) {
    let found: DoctorCheck[];
    try {
      found = backend.doctor({ models: [], hasFallback: true });
    } catch {
      continue;
    }
    if (!found.length || found[0]!.level === 'fail') continue; // not installed
    section(`${backend.name} (installed, not in your config)`);
    for (const c of found) add('ok', c.message);
    add('ok', `use it with -W ${backend.id}[:model], or name it in "fallback" or "tiers" in the config`);
  }

  // MCP: which clients have `pitroom mcp` (read from their config files; nothing is started)
  section('MCP');
  const have = mcpStatus().filter((m) => m.state !== 'absent');
  const stale = have.filter((m) => m.state === 'different');
  add('ok', have.length ? `pitroom mcp is registered in: ${have.map((m) => m.name).join(', ')}` : 'pitroom mcp is not registered in any client: `pitroom install --mcp` does it for the ones found (Cursor, Claude Desktop, Claude Code, Codex, Gemini CLI)');
  for (const m of stale) add('warn', `${m.name} runs a different command for pitroom mcp than this install's: \`pitroom install --mcp --no-skills\` updates it`);

  section('Skills and agents');
  addAll(skillChecks());

  if (probe && chain[0]) {
    section('Live probe');
    const p = liveProbe(chain[0]);
    add(p.level, p.message);
  }
  print(checks);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/** Sections, the checks under them, a one-line verdict and the commands the findings point to. */
function print(checks: Row[]): void {
  console.log(`${bold('Pitroom doctor')} ${dim(`v${VERSION}`)}`);
  for (const name of [...new Set(checks.map((c) => c.section))]) {
    console.log(`\n${bold(name)}`);
    for (const c of checks.filter((x) => x.section === name)) console.log(`  ${MARK[c.level]()} ${wrapText(c.message, 4)}`);
  }
  const count = (level: DoctorCheck['level']) => checks.filter((c) => c.level === level).length;
  const [ok, warn, fail] = [count('ok'), count('warn'), count('fail')];
  console.log(`\n${green(`✔ ${ok} ok`)}   ${warn ? yellow(`! ${warn} warning${warn === 1 ? '' : 's'}`) : dim('! 0 warnings')}   ${fail ? red(`✘ ${fail} problem${fail === 1 ? '' : 's'}`) : dim('✘ 0 problems')}`);
  const next = NEXT.filter((n) => checks.some((c) => c.level !== 'ok' && n.when.test(c.message)));
  if (next.length) {
    console.log(`\n${bold('Next')}`);
    const width = Math.max(...next.map((n) => n.command.length));
    for (const n of next) console.log(`  ${cyan(n.command.padEnd(width))}  ${dim(n.why)}`);
  }
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
  if (geminiExtensionInstalled()) {
    const linked = installedSkills().some((i) => i.base.includes(`${path.sep}.agents${path.sep}`) && i.names.length);
    checks.push(
      linked
        ? { level: 'warn', message: 'Pitroom is installed as a Gemini CLI extension and linked into ~/.agents/skills: Gemini loads the skills twice; run `pitroom uninstall` or `gemini extensions uninstall pitroom`' }
        : { level: 'ok', message: 'Gemini CLI extension installed (skills + context)' },
    );
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
    // a .cmd file only starts through a shell on Windows
    const r = spawnSync(launcher, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
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

/** Is Pitroom installed as a Gemini CLI extension (`gemini extensions install …`)? */
function geminiExtensionInstalled(): boolean {
  const home = process.env.GEMINI_CLI_HOME ?? os.homedir();
  return fs.existsSync(path.join(home, '.gemini', 'extensions', 'pitroom'));
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
