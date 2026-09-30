#!/usr/bin/env node
// SessionStart hook: puts the `using-pitroom` skill into the primary agent's
// context, so it considers delegating before it starts reading and editing, and
// tells it the exact command to run even if `pitroom` is not on PATH.
// Dependency-free and fast: it only reads one file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inside a Pitroom worker there is nothing to delegate to.
if (process.env.PITROOM_ACTIVE === '1') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let skill = '';
try {
  skill = fs.readFileSync(path.join(root, 'skills', 'using-pitroom', 'SKILL.md'), 'utf8');
} catch {
  process.exit(0); // broken install: stay silent rather than break the session
}
const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
// Fallback when `pitroom` is not on PATH: the installed launcher (it picks a Node 18+),
// else this Node if it is new enough, else plain `node`.
const cli = path.join(root, 'dist', 'pitroom.mjs');
const launcher = path.join(os.homedir(), '.local', 'bin', 'pitroom');
const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
const fallback = fs.existsSync(launcher) ? `"${launcher}"` : `"${nodeOk ? process.execPath : 'node'}" "${cli}"`;
const command = fs.existsSync(cli) || fs.existsSync(launcher) ? `\`pitroom\`, or if that is not on PATH: \`${fallback}\`` : '`pitroom`';

const context = `<pitroom>
You have Pitroom: a development workflow as skills, and cheap worker agents that read, search, implement and review for you. Run it as ${command}.
It is optional: use it when it helps or when the user asks for it, otherwise work as you normally would. Below is the 'using-pitroom' skill, a menu of what it offers; load a pitroom-* skill with your Skill tool when you choose to use it.

${body}
</pitroom>`;

// Cursor reads additional_context; Claude Code reads hookSpecificOutput. Emit only one,
// because Claude Code would otherwise inject the text twice.
const out = process.env.CURSOR_PLUGIN_ROOT
  ? { additional_context: context }
  : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
process.stdout.write(`${JSON.stringify(out)}\n`);
