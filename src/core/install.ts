// `pitroom install` / `uninstall`: link the skill pack into the agents' skill
// folders and the CLI launcher onto PATH. Only symlinks Pitroom created are
// ever removed; anything else in the way is kept (or backed up with --force).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Earlier single-skill names, cleaned up on install. */
const LEGACY = ['pitroom', 'opencode-worker'];

export function packageRoot(): string {
  // dist/pitroom.mjs → package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function skillNames(root = packageRoot()): string[] {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')))
    .sort();
}

export function skillTargets(): string[] {
  const home = os.homedir();
  const targets = [path.join(home, '.agents', 'skills')];
  if (fs.existsSync(path.join(home, '.claude'))) targets.push(path.join(home, '.claude', 'skills'));
  return targets;
}

export const launcherPath = () => path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'pitroom.cmd' : 'pitroom');

const LAUNCHER_MARK = '# pitroom launcher';

/**
 * A tiny sh launcher instead of a symlink: agents' shells often put an old Node
 * first on PATH (nvm lists every version), and `#!/usr/bin/env node` would pick
 * it. The launcher tries PITROOM_NODE, the Node that ran `pitroom install`, the
 * PATH's node, then nvm installs, and uses the first that is Node 22.13+ (the first with a built-in SQLite that needs no flag).
 */
function launcherScript(bundle: string): string {
  // Windows: a .cmd. It uses PITROOM_NODE or the Node that ran `pitroom install` (no search for another one).
  if (process.platform === 'win32') {
    const q = (v: string) => v.replace(/%/g, '%%');
    return `@echo off\r\nrem ${LAUNCHER_MARK} (created by \`pitroom install\`; \`pitroom uninstall\` removes it)\r\nif defined PITROOM_NODE (\r\n  "%PITROOM_NODE%" "${q(bundle)}" %*\r\n) else (\r\n  "${q(process.execPath)}" "${q(bundle)}" %*\r\n)\r\nexit /b %ERRORLEVEL%\r\n`;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
${LAUNCHER_MARK} (created by \`pitroom install\`; \`pitroom uninstall\` removes it)
cli=${q(bundle)}
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
for n in "\${PITROOM_NODE:-}" ${q(process.execPath)} "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if ok "$n"; then exec "$n" "$cli" "$@"; fi
done
echo "pitroom: needs Node.js 22.13 or newer (set PITROOM_NODE to its path)" >&2
exit 127
`;
}

function isOurLauncher(file: string, root: string): boolean {
  if (linksInto(file, root)) return true;
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.includes(LAUNCHER_MARK) && s.includes(root);
  } catch {
    return false;
  }
}

/** A file that is a Pitroom launcher (of any install), not just any file at that path. */
export function isPitroomLauncher(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(LAUNCHER_MARK);
  } catch {
    return false;
  }
}

function placeLauncher(bundle: string, root: string, force: boolean): string {
  const dest = launcherPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const exists = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (exists && !isOurLauncher(dest, root)) {
    if (!force) return `! ${dest} exists and is not Pitroom's launcher; kept (use --force to back it up and replace)`;
    fs.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (exists) {
    fs.rmSync(dest, { force: true });
  }
  fs.writeFileSync(dest, launcherScript(bundle), { mode: 0o755 });
  return `✔ ${dest} → launcher for ${bundle} (Node 22.13+)`;
}

/** A symlink whose target lies inside `dir` (works for broken links too). */
function linksInto(link: string, dir: string): boolean {
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  const rel = path.relative(dir, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function place(src: string, dest: string, opts: { copy: boolean; force: boolean }): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const st = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    if (!opts.force) return `! ${dest} exists and is not a link; kept (use --force to back it up and replace)`;
    fs.renameSync(dest, `${dest}.bak-${Date.now()}`);
  } else if (st) {
    fs.unlinkSync(dest);
  }
  if (opts.copy) fs.cpSync(src, dest, { recursive: true });
  else fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : fs.statSync(src).isDirectory() ? 'dir' : 'file');
  return `✔ ${dest} → ${opts.copy ? 'copied' : src}`;
}

export function install(opts: { copy: boolean; force: boolean; skills?: boolean }): string[] {
  const root = packageRoot();
  const skills = opts.skills === false ? [] : skillNames(root);
  if (opts.skills !== false && !skills.length) throw new Error(`no skills found under ${path.join(root, 'skills')}`);
  const out: string[] = [];
  for (const base of opts.skills === false ? [] : skillTargets()) {
    for (const legacy of LEGACY) {
      const l = path.join(base, legacy);
      if (!skills.includes(legacy) && linksInto(l, root)) {
        fs.unlinkSync(l);
        out.push(`✔ removed old link ${l}`);
      }
    }
    for (const name of skills) out.push(place(path.join(root, 'skills', name), path.join(base, name), opts));
  }
  const bundle = path.join(root, 'dist', 'pitroom.mjs');
  if (fs.existsSync(bundle)) {
    out.push(placeLauncher(bundle, root, opts.force));
    const onPath = (process.env.PATH ?? '').split(path.delimiter).some((d) => path.resolve(d) === path.dirname(launcherPath()));
    if (!onPath) out.push(`! ${path.dirname(launcherPath())} is not on PATH; add it, or run ${launcherPath()} directly`);
  }
  return out;
}

export function uninstall(): string[] {
  const root = packageRoot();
  const out: string[] = [];
  for (const base of skillTargets()) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const l = path.join(base, name);
      if (linksInto(l, root)) {
        fs.unlinkSync(l);
        out.push(`✔ removed ${l}`);
      }
    }
  }
  if (isOurLauncher(launcherPath(), root)) {
    fs.rmSync(launcherPath(), { force: true });
    out.push(`✔ removed ${launcherPath()}`);
  }
  return out.length ? out : ['nothing to remove'];
}

/** Which of Pitroom's skills are visible to agents (for doctor). */
export function installedSkills(): { base: string; names: string[] }[] {
  const names = skillNames();
  return skillTargets().map((base) => ({ base, names: names.filter((n) => fs.existsSync(path.join(base, n, 'SKILL.md'))) }));
}
