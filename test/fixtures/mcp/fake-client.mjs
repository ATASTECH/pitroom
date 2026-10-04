#!/usr/bin/env node
// A fake `claude`, `codex` or `gemini` for the install --mcp tests (it is told which by its file name): it answers
// --version and does `mcp add` / `mcp remove` the way the real ones change their config files under $HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const name = path.basename(process.argv[1]).replace(/\.mjs$/, '');
const args = process.argv.slice(2);
if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify({ name, args })}\n`);
if (args[0] === '--version') {
  console.log(`${name} 1.0 (fake)`);
  process.exit(0);
}
if (args[0] !== 'mcp' || !['add', 'remove'].includes(args[1])) process.exit(2);

const home = os.homedir();
const files = {
  claude: path.join(home, '.claude.json'),
  gemini: path.join(process.env.GEMINI_CLI_HOME ?? home, '.gemini', 'settings.json'),
  codex: path.join(home, '.codex', 'config.toml'),
};
const file = files[name];
fs.mkdirSync(path.dirname(file), { recursive: true });
const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

if (name === 'codex') {
  // [mcp_servers.pitroom] blocks, like Codex's own
  const without = read().replace(/\n?\[mcp_servers\.pitroom\][^\[]*/g, '');
  if (args[1] === 'add') {
    const dash = args.indexOf('--');
    const [command, ...rest] = args.slice(dash + 1);
    fs.writeFileSync(file, `${without}\n[mcp_servers.pitroom]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(rest)}\n`);
  } else {
    fs.writeFileSync(file, without);
  }
} else {
  const config = read() ? JSON.parse(read()) : {};
  config.mcpServers ??= {};
  if (args[1] === 'add') {
    const dash = args.indexOf('--');
    const [command, ...rest] = dash >= 0 ? args.slice(dash + 1) : args.slice(args.indexOf('pitroom') + 1);
    config.mcpServers.pitroom = { type: 'stdio', command, args: rest, env: {} };
  } else {
    delete config.mcpServers.pitroom;
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
