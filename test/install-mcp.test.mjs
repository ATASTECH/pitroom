// `pitroom install --mcp`: registers `pitroom mcp` in the MCP clients found, without touching what else they hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { root, sandbox } from './helpers.mjs';

const FAKE = path.join(root, 'test', 'fixtures', 'mcp', 'fake-client.mjs');

/** A home directory with the clients we choose, and the env that makes pitroom look there. */
function machine(s, { cursor = true, desktop = true, clis = ['claude', 'codex', 'gemini'] } = {}) {
  const home = path.join(s.base, 'h');
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(s.base, 'fake.log');
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GEMINI_CLI_HOME: '', FAKE_MCP_LOG: log };
  delete env.GEMINI_CLI_HOME;
  const desktopDir = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude');
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
  assert.match(fixed.stdout, /✔ Cursor: registered in/);
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
