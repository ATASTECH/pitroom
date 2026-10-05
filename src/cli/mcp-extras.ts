// What `pitroom mcp` offers besides tools: the runs as resources (a client can attach a report or a patch to a
// conversation), and a few prompts (the way to use Pitroom for research, a change, a review, parallel work).
import fs from 'node:fs';
import path from 'node:path';
import { packageRoot, skillNames } from '../core/install.js';
import { type Json, type Ctx, clip, pit } from './mcp-support.js';
import { freshMeta, listRunIds } from '../core/store.js';

/** A protocol error with its JSON-RPC code. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

// ── resources ─────────────────────────────────────────────────────────────────────────────────────

const RUN = /^pitroom:\/\/run\/(\d{8}-\d{6}-[0-9a-f]{4})(\/patch)?$/;
const LISTED = 30;

/** The run id a resource URI names, or undefined. */
export const runOfUri = (uri: string): string | undefined => RUN.exec(uri)?.[1];

const oneLine = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export function listResources(): { resources: Json[] } {
  const resources: Json[] = [];
  for (const id of listRunIds().slice(-LISTED).reverse()) {
    try {
      const m = freshMeta(id);
      const what = `${m.state} · ${m.mode} · ${m.worker.backend}${m.worker.model ? `:${m.worker.model.split('/').pop()}` : ''}`;
      resources.push({ uri: `pitroom://run/${id}`, name: `run ${id}`, title: oneLine(m.task, 70), description: `${what}: the report`, mimeType: 'text/plain' });
      if (m.changes?.length) resources.push({ uri: `pitroom://run/${id}/patch`, name: `patch ${id}`, title: `Patch of ${oneLine(m.task, 60)}`, description: `${what}: the exact diff, ${m.changes.length} file(s)`, mimeType: 'text/x-diff' });
    } catch {
      // a run directory that cannot be read now: left out
    }
  }
  return { resources };
}

export const resourceTemplates = (): { resourceTemplates: Json[] } => ({
  resourceTemplates: [
    { uriTemplate: 'pitroom://run/{id}', name: 'run-report', title: 'A run\'s report', description: 'The report of a run: answer, receipt, verified references.', mimeType: 'text/plain' },
    { uriTemplate: 'pitroom://run/{id}/patch', name: 'run-patch', title: 'A run\'s patch', description: 'The exact diff an isolated or in-place run made.', mimeType: 'text/x-diff' },
  ],
});

export async function readResource(uri: string, ctx: Ctx): Promise<{ contents: Json[] }> {
  const m = RUN.exec(uri);
  if (!m) throw new RpcError(-32002, `unknown resource: ${uri}`);
  const patch = m[2] !== undefined;
  const r = await pit(['show', m[1]!, patch ? '--patch' : '--full'], 60_000, ctx.signal);
  // exit 3 is the CLI's "no such run"; anything else (a timeout, a failing disk) is an error of ours, not a missing resource
  if (r.code !== 0) throw new RpcError(r.code === 3 || r.code === 2 ? -32002 : -32603, r.err || r.out || `run ${m[1]} cannot be read`);
  return { contents: [{ uri, mimeType: patch ? 'text/x-diff' : 'text/plain', text: clip(r.out) }] };
}

// ── prompts ───────────────────────────────────────────────────────────────────────────────────────

interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  text(a: Record<string, string>): string;
}

const PROMPTS: Prompt[] = [
  {
    name: 'research',
    title: 'Research with a worker',
    description: 'Find, map or explain code through a read-only worker, and verify what comes back.',
    arguments: [{ name: 'question', description: 'What to find out about the project.', required: true }],
    text: (a) =>
      `Use the pitroom_run tool (mode "read") to find out: ${a.question}\n\n` +
      'Give the worker the full question and any file it should start from. When it answers, check one or two of the cited file:line references yourself before relying on the answer, and say plainly what is verified and what is not. If it comes back "still running", call pitroom_wait with the run id.',
  },
  {
    name: 'implement',
    title: 'Get a change made',
    description: 'A worker makes a change in an isolated copy; you review the exact diff and apply it only when it is right.',
    arguments: [{ name: 'task', description: 'The change to make, with the context a worker needs.', required: true }],
    text: (a) =>
      `Get this change made by a worker: ${a.task}\n\n` +
      'Call pitroom_run with mode "isolate" (add "verify" with the project\'s test command if there is one). Read the diff with pitroom_show (patch: true), then have it judged with pitroom_review. ' +
      'If the diff does what was asked and the review has no critical findings, call pitroom_apply; otherwise pitroom_run with "continue" to ask for the fix, or pitroom_discard. Do not apply a change you have not read.',
  },
  {
    name: 'review',
    title: 'Review changes with another model',
    description: 'A read-only reviewer from another model judges a commit range or the latest change.',
    arguments: [{ name: 'range', description: 'A commit range such as main..HEAD. Default: the latest run\'s change.' }],
    text: (a) =>
      (a.range ? `Have the commits ${a.range} reviewed: call pitroom_review with range "${a.range}".` : 'Have the latest change reviewed: call pitroom_review with run "last".') +
      '\n\nWeigh each finding against the code before acting on it: a reviewer can be wrong. Fix what is real, and say which findings you dropped and why.',
  },
  {
    name: 'crew',
    title: 'Split work across workers',
    description: 'Independent tasks run in parallel as one group of workers.',
    arguments: [{ name: 'tasks', description: 'The tasks, one per line.', required: true }],
    text: (a) =>
      `Run these independent tasks in parallel: call pitroom_run with "tasks" (one worker each):\n\n${a.tasks}\n\n` +
      'Make each task self-contained. Use mode "isolate" if they change files, then read every patch (pitroom_show, patch: true) and apply them with pitroom_apply (group). Only split work that does not depend on each other.',
  },
];

/** How the skills' CLI commands map to this server's tools, put before a skill served as a prompt. */
const TOOL_MAP =
  'Through this MCP server the `pitroom` commands below are tools: `pitroom run` is pitroom_run (`-i` is mode "isolate", `-w` mode "write", `--continue` is continue, `--verify` is verify), ' +
  '`pitroom crew` is pitroom_run with tasks, `pitroom wait` pitroom_wait, `pitroom show`/`status` pitroom_show, `pitroom review` pitroom_review, `pitroom audit` pitroom_audit, ' +
  '`pitroom apply`/`discard`/`revert`/`stop` the tools of those names, `pitroom history`/`ls`/`models`/`doctor` pitroom_info. With a shell the commands work as well.';

/** Pitroom's skills, each served as a prompt of the same name: the same guidance for clients that have no skills. */
let skills: Prompt[] | undefined;
function skillPrompts(): Prompt[] {
  if (skills) return skills;
  const found: Prompt[] = [];
  const root = packageRoot();
  for (const name of skillNames(root)) {
    try {
      const text = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      const body = (front ? text.slice(front[0].length) : text).trim();
      const description = /^description:\s*(.+)$/m.exec(front?.[1] ?? '')?.[1]?.trim() ?? `The ${name} skill.`;
      const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name;
      found.push({
        name,
        title,
        // the first sentence: prompts/list is read whole by some clients, so it stays short
        description: `Skill: ${description.split(/(?<=\.)\s/)[0]}`,
        arguments: [{ name: 'task', description: 'What you are about to do (optional).' }],
        text: (a) => `${TOOL_MAP}\n\n${body}${a.task ? `\n\n---\n\nThe task: ${a.task}` : ''}`,
      });
    } catch {
      // a skill that cannot be read is left out
    }
  }
  skills = found.filter((p) => !PROMPTS.some((b) => b.name === p.name)); // a built-in prompt keeps its name
  return skills;
}

const allPrompts = (): Prompt[] => [...PROMPTS, ...skillPrompts()];

export const listPrompts = (): { prompts: Json[] } => ({ prompts: allPrompts().map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });

export function getPrompt(name: unknown, given: unknown): Json {
  const p = allPrompts().find((x) => x.name === name);
  if (!p) throw new RpcError(-32602, `unknown prompt: ${String(name)}`);
  const args: Record<string, string> = {};
  const raw = given && typeof given === 'object' && !Array.isArray(given) ? (given as Json) : {};
  for (const a of p.arguments) {
    const v = raw[a.name];
    if (typeof v === 'string' && v.trim()) args[a.name] = v.trim();
    else if (a.required) throw new RpcError(-32602, `missing argument: ${a.name}`);
  }
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] };
}
