// `pitroom install --mcp`: registers `pitroom mcp` in the MCP clients found, without touching what else they hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { posixOnly, root, sandbox } from './helpers.mjs';

const FAKE = path.join(root, 'test', 'fixtures', 'mcp', 'fake-client.mjs');

/** A home directory with the clients we choose, and the env that makes pitroom look there. */
function machine(s, { cursor = true, desktop = true, clis = ['claude', 'codex', 'gemini'] } = {}) {
  const home = path.join(s.base, 'h');
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(s.base, 'fake.log');
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), GEMINI_CLI_HOME: '', FAKE_MCP_LOG: log };
  delete env.GEMINI_CLI_HOME;
  const desktopDir = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'Claude') : path.join(home, '.config', 'Claude');
  if (cursor) fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  if (desktop) fs.mkdirSync(desktopDir, { recursive: true });
  const bin = path.join(s.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const c of ['claude', 'codex', 'gemini']) {
    const f = path.join(bin, c);
    if (clis.includes(c)) {
      fs.copyFileSync(FAKE, f);
      fs.chmodSync(f, 0o755);
    }
    env[`PITROOM_${c.toUpperCase()}_BIN`] = f; // a missing file: not installed
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { home, env, desktopFile: path.join(desktopDir, 'claude_desktop_config.json'), cursorFile: path.join(home, '.cursor', 'mcp.json'), calls };
}
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('install --mcp --dry-run says what it would do and writes nothing', () => {
  const s = sandbox();
  const m = machine(s);
  const r = s.run(['install', '--mcp', '--dry-run'], m.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'Claude Desktop']) assert.match(r.stdout, new RegExp(`→ ${name}: would register .* mcp`));
  assert.ok(!fs.existsSync(m.cursorFile) && !fs.existsSync(m.desktopFile), 'no file written');
  assert.deepEqual(m.calls().filter((c) => c.args[0] === 'mcp'), [], 'no client command run');
  assert.equal(s.run(['install', '--dry-run']).status, 2, '--dry-run goes with --mcp');
});

test('install --mcp registers in every client found, keeps what they hold, and a second run changes nothing', () => {
  const s = sandbox();
  const m = machine(s);
  fs.writeFileSync(m.cursorFile, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  const r = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'Claude Desktop']) assert.match(r.stdout, new RegExp(`✔ ${name}: registered in`));
  assert.match(r.stdout, /restart those clients/);

  // the JSON clients: our entry, an absolute command, the rest untouched, a backup of the original
  const cursor = json(m.cursorFile);
  assert.deepEqual(cursor.mcpServers.other, { command: 'x' });
  assert.equal(cursor.theme, 'dark');
  assert.ok(path.isAbsolute(cursor.mcpServers.pitroom.command), 'GUI apps have no PATH: an absolute command');
  assert.deepEqual(cursor.mcpServers.pitroom.args.slice(-1), ['mcp']);
  assert.deepEqual(json(`${m.cursorFile}.bak-pitroom`).mcpServers, { other: { command: 'x' } });
  assert.deepEqual(json(m.desktopFile).mcpServers.pitroom, cursor.mcpServers.pitroom);

  // the CLI clients are changed by their own command, at user scope
  const adds = m.calls().filter((c) => c.args[1] === 'add');
  const add = (n) => adds.find((c) => c.name === n).args;
  assert.deepEqual(add('claude').slice(0, 5), ['mcp', 'add', '--scope', 'user', 'pitroom']);
  assert.equal(add('claude')[5], '--');
  assert.deepEqual(add('codex').slice(0, 3), ['mcp', 'add', 'pitroom']);
  assert.deepEqual(add('gemini').slice(0, 5), ['mcp', 'add', '--scope', 'user', 'pitroom']);
  assert.equal(adds.length, 3);

  const again = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal((again.stdout.match(/· .*: already registered/g) ?? []).length, 5, again.stdout);
  assert.equal(m.calls().filter((c) => c.args[1] === 'add').length, 3, 'no new add');
  assert.doesNotMatch(again.stdout, /restart those clients/);

  // a client that runs another command for pitroom is brought up to date
  const edited = json(m.cursorFile);
  edited.mcpServers.pitroom.command = '/old/place/pitroom';
  fs.writeFileSync(m.cursorFile, JSON.stringify(edited));
  const fixed = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.match(fixed.stdout, /✔ Cursor: updated in/, 'a refresh reads differently from a first registration');
  assert.notEqual(json(m.cursorFile).mcpServers.pitroom.command, '/old/place/pitroom');
});

test('install --mcp --client limits it, a client that is not there is skipped, a config that is not JSON is left alone', () => {
  const s = sandbox();
  const m = machine(s, { desktop: false, clis: ['codex'] });
  const only = s.run(['install', '--mcp', '--no-skills', '--client', 'cursor'], m.env);
  assert.equal(only.status, 0, only.stdout + only.stderr);
  assert.match(only.stdout, /✔ Cursor: registered/);
  assert.doesNotMatch(only.stdout, /Codex|Gemini|Claude/);
  assert.equal(s.run(['install', '--mcp', '--client', 'vim'], m.env).status, 2, 'an unknown client is a usage error');

  const all = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.match(all.stdout, /· Claude Desktop: not found/);
  assert.match(all.stdout, /· Claude Code: not installed/);
  assert.match(all.stdout, /✔ Codex: registered/);

  const s2 = sandbox();
  const m2 = machine(s2, { desktop: false, clis: [] });
  fs.writeFileSync(m2.cursorFile, '{ not json');
  const r = s2.run(['install', '--mcp', '--no-skills'], m2.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✘ Cursor: .*is not valid JSON: left alone/);
  assert.equal(fs.readFileSync(m2.cursorFile, 'utf8'), '{ not json', 'the file is as it was');
});

test('doctor shows where pitroom mcp is registered, and uninstall removes only what install added', () => {
  const s = sandbox();
  const m = machine(s);
  fs.writeFileSync(m.cursorFile, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  assert.match(s.run(['doctor'], m.env).stdout, /pitroom mcp is not registered in any client: `pitroom install --mcp`/);
  assert.equal(s.run(['install', '--mcp', '--no-skills'], m.env).status, 0);
  assert.match(s.run(['doctor'], m.env).stdout, /pitroom mcp is registered in: Claude Code, Codex, Gemini CLI, Cursor, Claude Desktop/);

  const out = s.run(['uninstall'], m.env).stdout;
  for (const name of ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'Claude Desktop']) assert.match(out, new RegExp(`✔ ${name}: removed from`));
  assert.deepEqual(json(m.cursorFile).mcpServers, { other: { command: 'x' } }, 'the other server stays');
  assert.match(s.run(['doctor'], m.env).stdout, /not registered in any client/);
});

test('install --mcp --force registers again, a Codex entry with another command is refreshed, and extra fields of other servers survive', () => {
  const s = sandbox();
  const m = machine(s);
  const other = { type: 'stdio', command: 'x', args: ['a'], env: { KEY: 'v' } };
  fs.writeFileSync(m.cursorFile, JSON.stringify({ mcpServers: { other } }));
  fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.codex', 'config.toml'), '[mcp_servers.pitroom]\ncommand = "/old/pitroom"\nargs = ["mcp"]\n\n[memories]\nx = 1\n');
  assert.match(s.run(['doctor'], m.env).stdout, /! Codex runs a different command for pitroom mcp/, 'a stale Codex entry is seen');
  const first = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.match(first.stdout, /✔ Codex: updated in/);
  assert.match(fs.readFileSync(path.join(m.home, '.codex', 'config.toml'), 'utf8'), /\[memories\]\nx = 1/, 'the rest of Codex\'s config is kept');
  assert.deepEqual(json(m.cursorFile).mcpServers.other, other, 'another server is untouched, fields and all');
  const adds = () => m.calls().filter((c) => c.args[1] === 'add').length;
  const before = adds();
  assert.equal(s.run(['install', '--mcp', '--no-skills'], m.env).status, 0);
  assert.equal(adds(), before, 'nothing to do');
  const forced = s.run(['install', '--mcp', '--no-skills', '--force'], m.env);
  assert.match(forced.stdout, /✔ Cursor: updated in/);
  assert.equal(adds(), before + 3, 'the three CLI clients were registered again');
});

test('install --mcp does not register a file at the launcher path that is not a Pitroom launcher', { skip: posixOnly }, () => {
  const s = sandbox();
  const m = machine(s, { desktop: false, clis: [] });
  fs.mkdirSync(path.join(m.home, '.local', 'bin'), { recursive: true });
  const foreign = path.join(m.home, '.local', 'bin', 'pitroom');
  fs.writeFileSync(foreign, '#!/bin/sh\necho not pitroom\n', { mode: 0o755 });
  const r = s.run(['install', '--mcp', '--no-skills'], m.env);
  assert.match(r.stdout, /exists and is not Pitroom's launcher; kept/);
  assert.notEqual(json(m.cursorFile).mcpServers.pitroom.command, foreign, 'the foreign file is not what Cursor is told to run');
});

test('uninstall: a client whose command is gone cannot drop its entry, which is a failure (exit 1); with nothing registered it says nothing more', () => {
  const s = sandbox();
  const quiet = machine(s, { cursor: false, desktop: false, clis: [] });
  const none = s.run(['uninstall'], quiet.env);
  assert.equal(none.status, 0);
  assert.doesNotMatch(none.stdout, /Claude Code|Cursor|Codex|Gemini/);
  fs.writeFileSync(path.join(quiet.home, '.claude.json'), JSON.stringify({ mcpServers: { pitroom: { command: '/x/pitroom', args: ['mcp'] } } }));
  const stuck = s.run(['uninstall'], quiet.env);
  assert.equal(stuck.status, 1);
  assert.match(stuck.stdout, /✘ Claude Code: its command does not run: remove the pitroom entry from its config by hand/);
});

test('install: --no-skills and --dry-run need --mcp, and a failing client command is a line, not a crash', { skip: posixOnly }, () => {
  const s = sandbox();
  const m = machine(s, { cursor: false, desktop: false, clis: ['claude'] });
  assert.equal(s.run(['install', '--no-skills'], m.env).status, 2);
  // a claude that refuses: fail with its first line (here: a stub that exits 1 and prints a reason)
  const refuse = path.join(s.base, 'bin', 'claude');
  fs.writeFileSync(refuse, '#!/bin/sh\n[ "$1" = "--version" ] && echo ok && exit 0\necho "refused: managed settings"\nexit 1\n', { mode: 0o755 });
  const r = s.run(['install', '--mcp', '--no-skills', '--client', 'claude-code'], m.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✘ Claude Code: refused: managed settings/);
  assert.doesNotMatch(r.stdout, /no MCP client found/, 'a failure is not "no client"');
});
