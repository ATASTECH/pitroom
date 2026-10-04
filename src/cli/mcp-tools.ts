// The tools `pitroom mcp` offers. Each one runs the matching `pitroom` command (see mcp-support.ts), so they cannot
// drift from the CLI and every rule of the CLI applies unchanged.
import { DEFAULT_WAIT, MAX_TASKS, MAX_WAIT, type Tool, ToolError, bool, oneOf, plain, since, startAndWait, startCrew, str, strs, waitFor, waitSeconds, workerFlags } from './mcp-support.js';

const WORKER_PROPS = {
  worker: { type: 'string', description: 'Worker target "backend[:model]", e.g. "opencode", "codex", "claude:haiku", "gemini:gemini-3.8-flash". Default: the configured worker.' },
  model: { type: 'string', description: 'Model for the preferred worker.' },
  tier: { type: 'string', description: 'A worker tier from the config: cheap, standard, capable (an explicit worker wins).' },
  effort: { type: 'string', description: 'Reasoning effort for the worker: low, medium, high, xhigh.' },
  dir: { type: 'string', description: 'Project directory (default: the directory the server was started in).' },
  files: { type: 'array', items: { type: 'string' }, description: 'Files to attach (paths).' },
  verify: { type: 'string', description: 'A command run after the worker finishes (e.g. "npm test"); a failing one is reported.' },
  link: { type: 'array', items: { type: 'string' }, description: 'Ignored directories to link into an isolated copy so tests can run (e.g. ["node_modules"]).' },
  web: { type: 'boolean', description: 'Let the worker use web tools.' },
  group: { type: 'string', description: 'A name to group related runs under.' },
};
const WAIT_PROP = { waitSeconds: { type: 'number', description: `How long to wait for the result before returning "still running" (default ${DEFAULT_WAIT}, at most ${MAX_WAIT}).` } };
const RUN_ID = { type: 'string', description: 'A run id as printed by a run, or "last".' };
const SINCE = { type: 'string', description: 'A window: 7d, 30d, … or all.' };

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: Tool[] = [
  {
    name: 'pitroom_run',
    title: 'Run a worker',
    description:
      'Hand a bounded task to a cheaper worker agent. mode "read" (default) is read-only research that returns an answer whose file:line references are verified; "isolate" lets the worker edit a private copy and returns the exact diff (review it, then pitroom_apply or pitroom_discard); "write" edits the working tree in place and is undoable with pitroom_revert. Returns the worker\'s answer and a receipt, or "still running" with the run id. Progress is reported while it waits; cancelling the call stops the run.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the worker should do, with the context it needs.' },
        mode: { type: 'string', enum: ['read', 'isolate', 'write'], description: 'read (default), isolate, or write.' },
        continue: { type: 'string', description: 'A finished run to follow up in the same worker session (the task is then the follow-up).' },
        inPlace: { type: 'boolean', description: 'Read mode only: read the directory itself instead of a clean snapshot without secret-looking files.' },
        audit: { type: 'boolean', description: 'Read mode only: have another worker re-check the answer afterwards.' },
        ...WORKER_PROPS,
        ...WAIT_PROP,
      },
      required: ['task'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const task = str(a, 'task', true)!;
      const mode = oneOf(a, 'mode', ['read', 'isolate', 'write'], 'read');
      const flags = mode === 'isolate' ? ['-i'] : mode === 'write' ? ['-w'] : [];
      const follow = str(a, 'continue');
      if (follow) flags.push('--continue', follow);
      if (mode === 'read') {
        if (bool(a, 'inPlace')) flags.push('--in-place');
        if (bool(a, 'audit')) flags.push('--audit');
      }
      return startAndWait(['run', ...flags, ...workerFlags(a)], waitSeconds(a), ctx, task);
    },
  },
  {
    name: 'pitroom_crew',
    title: 'Run workers in parallel',
    description:
      'Start several independent tasks at once as one group of workers (read, or isolate: each edits its own copy) and wait for the group. Returns every report, or "still running" with the group name for pitroom_wait. Only for tasks that do not depend on each other. Cancelling the call stops the group.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_TASKS, description: 'One self-contained task per worker.' },
        mode: { type: 'string', enum: ['read', 'isolate'], description: 'read (default) or isolate.' },
        ...WORKER_PROPS,
        ...WAIT_PROP,
      },
      required: ['tasks'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(a, ctx) {
      const tasks = strs(a, 'tasks').filter((t) => t.trim());
      if (!tasks.length) throw new ToolError('"tasks" needs at least one task');
      if (tasks.length > MAX_TASKS) throw new ToolError(`at most ${MAX_TASKS} tasks at once: start the rest when these are done`);
      const mode = oneOf(a, 'mode', ['read', 'isolate'], 'read');
      return startCrew([...(mode === 'isolate' ? ['-i'] : []), ...workerFlags(a)], tasks, waitSeconds(a), ctx);
    },
  },
  {
    name: 'pitroom_wait',
    title: 'Wait for runs',
    description: 'Wait for runs started earlier (a run that came back "still running") and return their reports.',
    inputSchema: {
      type: 'object',
      properties: { runs: { type: 'array', items: { type: 'string' }, description: 'Run ids.' }, group: { type: 'string', description: 'Or a group name.' }, ...WAIT_PROP },
    },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const runs = strs(a, 'runs');
      const group = str(a, 'group');
      if (!runs.length && !group) throw new ToolError('give "runs" or "group"');
      return waitFor(runs, waitSeconds(a), ctx, runs.length ? undefined : group);
    },
  },
  {
    name: 'pitroom_status',
    title: 'Run status',
    description: 'The state and live progress of a run (default: the latest), or of a group.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string', description: 'A group name.' } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const group = str(a, 'group');
      const run = str(a, 'run');
      if (group && run) throw new ToolError('give "run" or "group", not both');
      return plain(['status', ...(group ? ['-g', group] : run ? [run] : [])], ctx);
    },
  },
  {
    name: 'pitroom_list',
    title: 'List runs',
    description: 'The latest runs with their state, worker and task; with running only the active ones, or one group\'s.',
    inputSchema: { type: 'object', properties: { running: { type: 'boolean', description: 'Only runs that are queued or running.' }, group: { type: 'string', description: 'A group name.' } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const group = str(a, 'group');
      return plain(['ls', ...(bool(a, 'running') ? ['--running'] : []), ...(group ? ['-g', group] : [])], ctx);
    },
  },
  {
    name: 'pitroom_show',
    title: 'Show a run',
    description: 'A finished run\'s report again; with patch the exact diff of an isolated change, with full the untruncated answer.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, patch: { type: 'boolean' }, full: { type: 'boolean' } }, required: ['run'] },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const run = str(a, 'run', true)!;
      return plain(['show', run, ...(bool(a, 'patch') ? ['--patch'] : bool(a, 'full') ? ['--full'] : [])], ctx);
    },
  },
  {
    name: 'pitroom_history',
    title: 'Search past runs',
    description: 'Finished runs from the history, searchable: full-text over the task, the answer and the steps. Use it to find an earlier answer before asking a worker again.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Words to search for.' },
        state: { type: 'string', description: 'done, problem, failed, …' },
        model: { type: 'string', description: 'Only runs of this model.' },
        since: SINCE,
        limit: { type: 'number', description: 'How many runs (default 20).' },
      },
    },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const limit = a.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ToolError('"limit" must be a whole number from 1 to 200');
      const text = str(a, 'text');
      const state = str(a, 'state');
      const model = str(a, 'model');
      return plain(['history', ...since(a), ...(state ? ['--state', state] : []), ...(model ? ['--model', model] : []), ...(limit ? ['--limit', String(limit)] : []), ...(text ? ['--', text] : [])], ctx);
    },
  },
  {
    name: 'pitroom_stats',
    title: 'Worker statistics',
    description: 'Runs, success rate, average time and tokens per worker and model, and how often their answers were confirmed by audits. Use it to pick a worker.',
    inputSchema: { type: 'object', properties: { since: SINCE } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      return plain(['history', 'stats', ...since(a)], ctx);
    },
  },
  {
    name: 'pitroom_savings',
    title: 'What the workers saved',
    description: 'The tokens and money workers took over from you, per model, from the receipts of the runs.',
    inputSchema: { type: 'object', properties: { since: SINCE, models: { type: 'boolean', description: 'Break it down per model.' } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      return plain(['savings', ...since(a), ...(bool(a, 'models') ? ['--models'] : [])], ctx);
    },
  },
  {
    name: 'pitroom_models',
    title: 'Worker models',
    description: 'The models a worker backend offers, with effort levels, the costs set in the config and recent usage. Use it to choose a model for pitroom_run.',
    inputSchema: { type: 'object', properties: { worker: { type: 'string', description: 'A backend: opencode, codex, claude, gemini. Default: the configured one.' }, all: { type: 'boolean', description: 'Include models that are hidden by default.' } } },
    annotations: READ_ONLY,
    async call(a, ctx) {
      const worker = str(a, 'worker');
      return plain(['models', ...(worker ? [worker] : []), ...(bool(a, 'all') ? ['--all'] : [])], ctx);
    },
  },
  {
    name: 'pitroom_cooldown',
    title: 'Rate-limited models',
    description: 'The models that said "rate limited" and are being skipped for now (runs go to the next worker). With clear they are tried again immediately.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'Forget the cooldowns.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      return plain(['cooldown', ...(bool(a, 'clear') ? ['--clear'] : [])], ctx);
    },
  },
  {
    name: 'pitroom_doctor',
    title: 'Check the setup',
    description: 'Checks the setup without spending tokens: the workers found and their logins, the config, the skills, where the MCP server is registered. Use it when a run fails to start.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
    async call(_a, ctx) {
      return plain(['doctor'], ctx, 120_000);
    },
  },
  {
    name: 'pitroom_review',
    title: 'Review a change',
    description: 'A read-only reviewer (by default another worker than the implementer) judges one run\'s change, or a range of commits ("main..HEAD"). Returns findings with severities and a SPEC / QUALITY verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { ...RUN_ID, description: 'The run whose change to review (an isolated or in-place change).' },
        range: { type: 'string', description: 'Or a commit range "A..B".' },
        plan: { type: 'string', description: 'With range: the plan file the commits implement.' },
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
    description: 'Another worker re-checks a finished read run\'s answer against the project and says AGREE, PARTIAL or DISAGREE with the claims it disputes.',
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
    description: 'Land an isolated run\'s patch on the user\'s working tree (checked first; refused if it no longer applies cleanly), or every patch of a group in order. A patch that deletes files is refused unless allowDelete is true: only pass it after checking the deletions are what the user asked for.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' }, allowDelete: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      const group = str(a, 'group');
      const run = str(a, 'run');
      if (!run && !group) throw new ToolError('give "run" or "group"');
      if (run && group) throw new ToolError('give "run" or "group", not both');
      return plain(['apply', ...(group && !run ? ['-g', group] : [run!]), ...(bool(a, 'allowDelete') ? ['--allow-delete'] : [])], ctx, 120_000);
    },
  },
  {
    name: 'pitroom_discard',
    title: 'Discard an isolated change',
    description: 'Drop an isolated run\'s private copy (its patch is kept).',
    inputSchema: { type: 'object', properties: { run: RUN_ID }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      return plain(['discard', str(a, 'run', true)!], ctx);
    },
  },
  {
    name: 'pitroom_revert',
    title: 'Undo an in-place change',
    description: 'Undo what a mode "write" run changed in the working tree (checked first; refused when the files changed since).',
    inputSchema: { type: 'object', properties: { run: RUN_ID }, required: ['run'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(a, ctx) {
      return plain(['revert', str(a, 'run', true)!], ctx, 120_000);
    },
  },
  {
    name: 'pitroom_stop',
    title: 'Stop runs',
    description: 'Stop a running or queued run, or every run of a group.',
    inputSchema: { type: 'object', properties: { run: RUN_ID, group: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(a, ctx) {
      const run = str(a, 'run');
      const group = str(a, 'group');
      if (!run && !group) throw new ToolError('give "run" or "group"');
      if (run && group) throw new ToolError('give "run" or "group", not both');
      return plain(['stop', ...(run ? [run] : ['-g', group!])], ctx);
    },
  },
];
