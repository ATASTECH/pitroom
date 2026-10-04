// The tools `pitroom mcp` offers. Each one runs the matching `pitroom` command (see mcp-support.ts), so they cannot
// drift from the CLI and every rule of the CLI applies unchanged. Their definitions sit in the client's context for
// the whole session, so they are kept few and short: parallel work is `pitroom_run` with `tasks`, and everything
// that only reports (runs, history, statistics, savings, models, cooldowns, config, doctor) is one `pitroom_info`.
import { DEFAULT_WAIT, MAX_TASKS, MAX_WAIT, type Json, type Tool, ToolError, bool, oneOf, plain, since, startAndWait, startCrew, str, strs, waitFor, waitSeconds, workerFlags } from './mcp-support.js';

const WORKER_PROPS = {
  worker: { type: 'string', description: 'Worker "backend[:model]", e.g. "opencode", "claude:haiku". Default: configured.' },
  model: { type: 'string' },
  tier: { type: 'string', description: 'cheap, standard or capable (from the config).' },
  effort: { type: 'string', description: 'low, medium, high, xhigh.' },
  dir: { type: 'string', description: 'Project directory (default: the server\'s).' },
  files: { type: 'array', items: { type: 'string' }, description: 'Files to attach.' },
  verify: { type: 'string', description: 'Command run afterwards, e.g. "npm test".' },
  link: { type: 'array', items: { type: 'string' }, description: 'Ignored dirs to link into an isolated copy, e.g. ["node_modules"].' },
  web: { type: 'boolean', description: 'Allow web tools.' },
  group: { type: 'string', description: 'Group name for related runs.' },
};
const WAIT_PROP = { waitSeconds: { type: 'number', description: `Wait this long before returning "still running" (default ${DEFAULT_WAIT}, max ${MAX_WAIT}).` } };
const RUN_ID = { type: 'string', description: 'Run id, or "last".' };

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

/** What `pitroom_info` can report, and which of its options each topic takes. */
const TOPICS: Record<string, string[]> = {
  runs: ['running', 'group'],
  history: ['text', 'state', 'model', 'since', 'limit'],
  stats: ['since'],
  savings: ['since', 'perModel'],
  models: ['worker', 'all'],
  cooldown: [],
  config: [],
  doctor: [],
};

function infoArgs(topic: string, a: Json): { args: string[]; timeoutMs?: number } {
  const allowed = TOPICS[topic]!;
  const stray = Object.keys(a).filter((k) => k !== 'topic' && a[k] !== undefined && a[k] !== null && !allowed.includes(k));
  if (stray.length) throw new ToolError(`${stray.map((k) => `"${k}"`).join(', ')} does not go with topic "${topic}"${allowed.length ? ` (it takes ${allowed.join(', ')})` : ''}`);
  const group = str(a, 'group');
  const worker = str(a, 'worker');
  switch (topic) {
    case 'runs':
      return { args: ['ls', ...(bool(a, 'running') ? ['--running'] : []), ...(group ? ['-g', group] : [])] };
    case 'history': {
      const limit = a.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ToolError('"limit" must be a whole number from 1 to 200');
      const text = str(a, 'text');
      const state = str(a, 'state');
      const model = str(a, 'model');
      return { args: ['history', ...since(a), ...(state ? ['--state', state] : []), ...(model ? ['--model', model] : []), ...(limit ? ['--limit', String(limit)] : []), ...(text ? ['--', text] : [])] };
    }
    case 'stats':
      return { args: ['history', 'stats', ...since(a)] };
    case 'savings':
      return { args: ['savings', ...since(a), ...(bool(a, 'perModel') ? ['--models'] : [])] };
    case 'models':
      return { args: ['models', ...(worker ? [worker] : []), ...(bool(a, 'all') ? ['--all'] : [])] };
    case 'doctor':
      return { args: ['doctor'], timeoutMs: 120_000 };
    default:
      return { args: [topic] }; // cooldown, config
  }
}

export const TOOLS: Tool[] = [
  {
    name: 'pitroom_run',
    title: 'Run a worker',
    description:
      'Hand a bounded task to a cheaper worker agent. mode "read" (default): read-only research, an answer with verified file:line references. "isolate": the worker edits a private copy and you get the exact diff (then pitroom_review, pitroom_apply or pitroom_discard). "write": edits the working tree (undo: pitroom_revert). Give "tasks" instead of "task" to run independent tasks in parallel (read or isolate). Returns the report(s) and a receipt, or "still running" for pitroom_wait. Cancelling the call stops the run.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, with the context the worker needs.' },
        tasks: { type: 'array', items: { type: 'string' }, maxItems: MAX_TASKS, description: 'Or several independent tasks, one worker each.' },
        mode: { type: 'string', enum: ['read', 'isolate', 'write'] },
        continue: { type: 'string', description: 'A finished run to follow up in the same worker session.' },
        inPlace: { type: 'boolean', description: 'Read: read the directory itself, not a snapshot without secret-looking files.' },
        audit: { type: 'boolean', description: 'Read: have another worker re-check the answer.' },
        ...WORKER_PROPS,
        ...WAIT_PROP,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const task = str(a, 'task');
      const tasks = strs(a, 'tasks').filter((t) => t.trim());
      if (!task && !tasks.length) throw new ToolError('give "task" (or "tasks" for parallel work)');
      if (task && tasks.length) throw new ToolError('give "task" or "tasks", not both');
      const mode = oneOf(a, 'mode', ['read', 'isolate', 'write'], 'read');
      const flags = mode === 'isolate' ? ['-i'] : mode === 'write' ? ['-w'] : [];
      if (mode === 'read') {
        if (bool(a, 'inPlace')) flags.push('--in-place');
        if (bool(a, 'audit')) flags.push('--audit');
      }
      const follow = str(a, 'continue');
      if (tasks.length) {
        if (tasks.length > MAX_TASKS) throw new ToolError(`at most ${MAX_TASKS} tasks at once: start the rest when these are done`);
        if (mode === 'write') throw new ToolError('parallel workers never write in place: use mode "isolate" (each gets its own copy)');
        if (follow) throw new ToolError('"continue" follows up one run: give "task"');
        return startCrew([...flags, ...workerFlags(a)], tasks, waitSeconds(a), ctx);
      }
      if (follow) flags.push('--continue', follow);
      return startAndWait(['run', ...flags, ...workerFlags(a)], waitSeconds(a), ctx, task);
    },
  },
  {
    name: 'pitroom_wait',
    title: 'Wait for runs',
    description: 'Wait for runs that came back "still running" and return their reports.',
    inputSchema: { type: 'object', properties: { runs: { type: 'array', items: { type: 'string' } }, group: { type: 'string' }, ...WAIT_PROP } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const runs = strs(a, 'runs');
      const group = str(a, 'group');
      if (!runs.length && !group) throw new ToolError('give "runs" or "group"');
      return waitFor(runs, waitSeconds(a), ctx, runs.length ? undefined : group);
    },
  },
  {
    name: 'pitroom_show',
    title: 'Show a run',
    description: 'A run\'s report (live progress while it runs); patch: the exact diff; full: the untruncated answer.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, patch: { type: 'boolean' }, full: { type: 'boolean' } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const run = str(a, 'run') ?? 'last';
      return plain(['show', run, ...(bool(a, 'patch') ? ['--patch'] : bool(a, 'full') ? ['--full'] : [])], ctx);
    },
  },
  {
    name: 'pitroom_info',
    title: 'Pitroom information',
    description:
      'Reports, changing nothing. topic: runs (latest runs; running, group), history (search earlier answers before asking again; text, state, model, since, limit), stats (success rate, time, tokens, audits per worker; since), savings (since, perModel), models (a backend\'s models and costs; worker, all), cooldown (rate-limited models being skipped), config, doctor (setup check).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: Object.keys(TOPICS) },
        text: { type: 'string' },
        state: { type: 'string' },
        model: { type: 'string' },
        since: { type: 'string', description: '7d, 30d, … or all.' },
        limit: { type: 'number' },
        running: { type: 'boolean' },
        group: { type: 'string' },
        worker: { type: 'string' },
        all: { type: 'boolean' },
        perModel: { type: 'boolean' },
      },
      required: ['topic'],
    },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const topic = oneOf(a, 'topic', Object.keys(TOPICS), 'runs');
      if (a.topic === undefined) throw new ToolError(`"topic" is required: one of ${Object.keys(TOPICS).join(', ')}`);
      const { args, timeoutMs } = infoArgs(topic, a);
      return plain(args, ctx, timeoutMs);
    },
  },
  {
    name: 'pitroom_review',
    title: 'Review a change',
    description: 'A read-only reviewer (another worker by default) judges a run\'s change or a commit range ("main..HEAD"): findings with severities and a SPEC / QUALITY verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        run: RUN_ID,
        range: { type: 'string', description: 'Or a commit range "A..B".' },
        plan: { type: 'string', description: 'With range: the plan file it implements.' },
        worker: WORKER_PROPS.worker,
        tier: WORKER_PROPS.tier,
        dir: WORKER_PROPS.dir,
        group: WORKER_PROPS.group,
        ...WAIT_PROP,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const run = str(a, 'run');
      const range = str(a, 'range');
      if (!run === !range) throw new ToolError('give exactly one of "run" or "range"');
      const plan = str(a, 'plan');
      const flags = workerFlags(a, ['worker', 'tier', 'dir', 'group']);
      return startAndWait(['review', ...(range ? ['--range', range, ...(plan ? ['--plan', plan] : [])] : [run!]), ...flags], waitSeconds(a), ctx);
    },
  },
  {
    name: 'pitroom_audit',
    title: 'Audit an answer',
    description: 'Another worker re-checks a read run\'s answer: AGREE, PARTIAL or DISAGREE, with the disputed claims.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, worker: WORKER_PROPS.worker, ...WAIT_PROP }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const run = str(a, 'run', true)!;
      const worker = str(a, 'worker');
      return startAndWait(['audit', run, ...(worker ? ['-W', worker] : [])], waitSeconds(a), ctx);
    },
  },
  {
    name: 'pitroom_apply',
    title: 'Apply an isolated change',
    description: 'Land an isolated run\'s patch (or a group\'s, in order) on the working tree; checked first. A patch deleting files needs allowDelete: pass it only after checking the deletions were asked for.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' }, allowDelete: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      const group = str(a, 'group');
      const run = str(a, 'run');
      if (!run && !group) throw new ToolError('give "run" or "group"');
      if (run && group) throw new ToolError('give "run" or "group", not both');
      return plain(['apply', ...(group ? ['-g', group] : [run!]), ...(bool(a, 'allowDelete') ? ['--allow-delete'] : [])], ctx, 120_000);
    },
  },
  {
    name: 'pitroom_discard',
    title: 'Discard an isolated change',
    description: 'Drop an isolated run\'s private copy (the patch is kept).',
    inputSchema: { type: 'object', properties: { run: RUN_ID }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      return plain(['discard', str(a, 'run', true)!], ctx);
    },
  },
  {
    name: 'pitroom_revert',
    title: 'Undo an in-place change',
    description: 'Undo a mode "write" run\'s changes (refused if the files changed since).',
    inputSchema: { type: 'object', properties: { run: RUN_ID }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      return plain(['revert', str(a, 'run', true)!], ctx, 120_000);
    },
  },
  {
    name: 'pitroom_stop',
    title: 'Stop runs',
    description: 'Stop a running or queued run, or a group; cooldowns: try rate-limited models again now.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' }, cooldowns: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      const run = str(a, 'run');
      const group = str(a, 'group');
      if (bool(a, 'cooldowns')) {
        if (run || group) throw new ToolError('"cooldowns" goes alone');
        return plain(['cooldown', '--clear'], ctx);
      }
      if (!run && !group) throw new ToolError('give "run" or "group" (or "cooldowns": true)');
      if (run && group) throw new ToolError('give "run" or "group", not both');
      return plain(['stop', ...(run ? [run] : ['-g', group!])], ctx);
    },
  },
];
