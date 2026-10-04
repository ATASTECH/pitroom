// `pitroom install --mcp`: registers `pitroom mcp` as an MCP server in the clients found on this machine.
//
// Claude Code, Codex and Gemini CLI keep their own MCP settings and have a command to change them, so that command is
// what is run (no hand-editing of files they also write). Cursor and Claude Desktop have none: their JSON config is
// merged, a backup kept the first time, and a file that is not valid JSON is left alone. Whether a client already has
// the server is read from its config file, never by starting the server (a client's own `mcp get` connects to it).
// The command registered is the launcher (it finds a Node 22.13+), which GUI apps need: they start without your PATH.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBackend } from '../backends/index.js';
import { resolveCommand } from '../backends/exec.js';
import { launcherPath } from './install.js';

export type ClientId = 'claude-code' | 'codex' | 'gemini' | 'cursor' | 'claude-desktop';
export const CLIENT_IDS: ClientId[] = ['claude-code', 'codex', 'gemini', 'cursor', 'claude-desktop'];
const NAME = 'pitroom';

export interface McpCommand {
  command: string;
  args: string[];
}

export interface McpResult {
  id: ClientId;
  name: string;
  state: 'added' | 'updated' | 'already' | 'removed' | 'not-found' | 'failed' | 'would-add';
  message: string;
}

/** What the clients are told to run: the launcher, else `pitroom` from PATH, else this Node and bundle. */
export function mcpCommand(): McpCommand {
  const launcher = launcherPath();
  if (fs.existsSync(launcher)) return { command: launcher, args: ['mcp'] };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, process.platform === 'win32' ? 'pitroom.cmd' : 'pitroom');
    if (fs.existsSync(p)) return { command: path.resolve(p), args: ['mcp'] };
  }
  return { command: process.execPath, args: [process.argv[1] ?? 'pitroom', 'mcp'] };
}

const same = (a: McpCommand, b: unknown): boolean => {
  const o = b as Partial<McpCommand> | undefined;
  return !!o && o.command === a.command && Array.isArray(o.args) && o.args.join('\0') === a.args.join('\0');
};

// ── clients with a command of their own ───────────────────────────────────────────────────────────

function run(backendId: string, args: string[]): { ok: boolean; out: string } {
  const { command, prefix } = resolveCommand(getBackend(backendId).binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0 && !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const runnable = (backendId: string) => run(backendId, ['--version']).ok;

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

interface Client {
  id: ClientId;
  name: string;
  where: string;
  found(): boolean;
  /** Is the server in this client's config, and is it ours as registered now? */
  state(c: McpCommand): 'absent' | 'same' | 'different';
  add(c: McpCommand): { ok: boolean; message: string };
  remove(): { ok: boolean; message: string };
}

const home = () => os.homedir();
const geminiDir = () => path.join(process.env.GEMINI_CLI_HOME ?? home(), '.gemini');

function cliClient(id: ClientId, backend: string, name: string, where: string, o: { add(c: McpCommand): string[]; remove(): string[]; state(c: McpCommand): 'absent' | 'same' | 'different' }): Client {
  return {
    id, name, where,
    found: () => runnable(backend),
    state: o.state,
    add: (c) => {
      const r = run(backend, o.add(c));
      return { ok: r.ok, message: r.ok ? where : r.out.split('\n')[0] ?? 'failed' };
    },
    remove: () => {
      const r = run(backend, o.remove());
      return { ok: r.ok, message: r.ok ? where : r.out.split('\n')[0] ?? 'failed' };
    },
  };
}

function jsonClient(id: ClientId, name: string, file: () => string, dir: () => string): Client {
  const rel = () => file().replace(home(), '~');
  return {
    id, name, where: '',
    found: () => fs.existsSync(dir()),
    state: (c) => {
      const entry = readJson(file())?.mcpServers?.[NAME];
      return entry === undefined ? 'absent' : same(c, entry) ? 'same' : 'different';
    },
    add: (c) => {
      let config: any = {};
      if (fs.existsSync(file())) {
        config = readJson(file());
        if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, message: `${rel()} is not valid JSON: left alone` };
        const backup = `${file()}.bak-pitroom`;
        if (!fs.existsSync(backup)) fs.copyFileSync(file(), backup);
      }
      config.mcpServers = { ...(config.mcpServers ?? {}), [NAME]: { command: c.command, args: c.args } };
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
      fs.renameSync(tmp, file());
      return { ok: true, message: rel() };
    },
    remove: () => {
      const config = readJson(file());
      if (!config?.mcpServers?.[NAME]) return { ok: true, message: rel() };
      delete config.mcpServers[NAME];
      fs.writeFileSync(file(), `${JSON.stringify(config, null, 2)}\n`);
      return { ok: true, message: rel() };
    },
  };
}

function desktopFile(): string {
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home(), '.config'), 'Claude', 'claude_desktop_config.json');
}

const jsonState = (file: string, c: McpCommand): 'absent' | 'same' | 'different' => {
  const entry = readJson(file)?.mcpServers?.[NAME];
  return entry === undefined ? 'absent' : same(c, entry) ? 'same' : 'different';
};

function clients(): Client[] {
  return [
    cliClient('claude-code', 'claude', 'Claude Code', 'user settings (~/.claude.json)', {
      state: (c) => jsonState(path.join(home(), '.claude.json'), c),
      add: (c) => ['mcp', 'add', '--scope', 'user', NAME, '--', c.command, ...c.args],
      remove: () => ['mcp', 'remove', NAME, '--scope', 'user'],
    }),
    cliClient('codex', 'codex', 'Codex', '~/.codex/config.toml', {
      state: () => {
        try {
          return /^\[mcp_servers\.pitroom\]/m.test(fs.readFileSync(path.join(process.env.CODEX_HOME ?? path.join(home(), '.codex'), 'config.toml'), 'utf8')) ? 'same' : 'absent';
        } catch {
          return 'absent';
        }
      },
      add: (c) => ['mcp', 'add', NAME, '--', c.command, ...c.args],
      remove: () => ['mcp', 'remove', NAME],
    }),
    cliClient('gemini', 'gemini', 'Gemini CLI', 'user settings (~/.gemini/settings.json)', {
      state: (c) => jsonState(path.join(geminiDir(), 'settings.json'), c),
      add: (c) => ['mcp', 'add', '--scope', 'user', NAME, c.command, ...c.args],
      remove: () => ['mcp', 'remove', '--scope', 'user', NAME],
    }),
    jsonClient('cursor', 'Cursor', () => path.join(home(), '.cursor', 'mcp.json'), () => path.join(home(), '.cursor')),
    jsonClient('claude-desktop', 'Claude Desktop', desktopFile, () => path.dirname(desktopFile())),
  ];
}

// ── what install, uninstall and doctor use ────────────────────────────────────────────────────────

/** Registers `pitroom mcp` in the clients found (or the named ones). `dryRun` only says what it would do. */
export function installMcp(opts: { only?: ClientId[]; dryRun?: boolean; force?: boolean } = {}): McpResult[] {
  const c = mcpCommand();
  const out: McpResult[] = [];
  for (const client of clients()) {
    if (opts.only && !opts.only.includes(client.id)) continue;
    const r = (state: McpResult['state'], message: string) => out.push({ id: client.id, name: client.name, state, message });
    if (!client.found()) {
      r('not-found', client.id === 'cursor' || client.id === 'claude-desktop' ? 'not found on this machine' : 'not installed (its command does not run)');
      continue;
    }
    const now = client.state(c);
    if (now === 'same' && !opts.force) {
      r('already', 'already registered');
      continue;
    }
    if (opts.dryRun) {
      r('would-add', `would register ${[c.command, ...c.args].join(' ')}`);
      continue;
    }
    if (now !== 'absent') client.remove(); // replace what is there (a changed path, or --force)
    const done = client.add(c);
    r(done.ok ? (now === 'absent' ? 'added' : 'updated') : 'failed', done.ok ? `registered in ${done.message}` : done.message);
  }
  return out;
}

/** Removes the `pitroom` server from the clients that have it. */
export function uninstallMcp(): McpResult[] {
  const c = mcpCommand();
  const out: McpResult[] = [];
  for (const client of clients()) {
    let has = false;
    try {
      has = client.state(c) !== 'absent';
    } catch {
      has = false;
    }
    if (!has) continue;
    const done = client.remove();
    out.push({ id: client.id, name: client.name, state: done.ok ? 'removed' : 'failed', message: done.ok ? `removed from ${done.message}` : done.message });
  }
  return out;
}

/** For doctor: which clients have the server, read from their config files (nothing is started). */
export function mcpStatus(): { id: ClientId; name: string; state: 'absent' | 'same' | 'different' }[] {
  const c = mcpCommand();
  return clients().map((client) => {
    try {
      return { id: client.id, name: client.name, state: client.state(c) };
    } catch {
      return { id: client.id, name: client.name, state: 'absent' as const };
    }
  });
}

export const parseClients = (value: string | undefined): ClientId[] | undefined => {
  if (!value) return undefined;
  const wanted = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = wanted.filter((w) => !(CLIENT_IDS as string[]).includes(w));
  if (bad.length) throw new Error(`unknown client ${bad.join(', ')} (one of: ${CLIENT_IDS.join(', ')})`);
  return wanted as ClientId[];
};
