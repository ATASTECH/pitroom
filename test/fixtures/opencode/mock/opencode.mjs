#!/usr/bin/env node
// Fake `opencode` (v2 behaviour) for tests, executed directly (see test/helpers.mjs). Behaviour is driven by MOCK_ACTIONS (";"-separated):
//   answer:<text>          final text answer
//   append:<file>:<text>   append a line to <file> in the worker's directory (an edit)
//   write:<file>:<text>    overwrite <file> with one line (an edit)
//   sleep:<seconds>        wait before answering
//   fail:<message>         emit an error event and exit 1
//   exec:<shell command>   run it with /bin/sh (inheriting env, like OpenCode's bash tool);
//                          the output is logged to $MOCK_LOG as {exec, code, output}
// MOCK_FAIL_MODELS=a,b     fail with "Model not found" when --model is one of these
//                          ("default" = no --model given)
// MOCK_RATE_LIMIT_MODELS=a,b  fail with a daily-quota error ("retry in 2h") when --model is one of these
// Every invocation is appended to $MOCK_LOG as JSON (argv, cwd, config, stdin type).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (process.env.MOCK_LOG) {
  let stdin = 'unknown';
  try {
    stdin = fs.fstatSync(0).isFIFO() ? 'pipe' : 'other';
  } catch {
    stdin = 'closed';
  }
  fs.appendFileSync(
    process.env.MOCK_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT, active: process.env.PITROOM_ACTIVE, stdin }) + '\n',
  );
}

const cmd = argv[0];
if (cmd === '--version') {
  console.log('opencode v2.0.0-mock');
  process.exit(0);
}
if (cmd === 'models') {
  // MOCK_MODELS_COLD: the first call prints nothing, as real OpenCode does while its service starts
  if (process.env.MOCK_MODELS_COLD && process.env.MOCK_LOG) {
    const marker = `${process.env.MOCK_LOG}.cold`;
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ''); process.exit(0); }
  }
  console.log((process.env.MOCK_MODELS ?? 'mock/good-model,mock/other').split(',').join('\n'));
  process.exit(0);
}
if (cmd === 'debug') {
  // v2: a list of config sources; the model is {providerID, model}.
  const [providerID, ...rest] = (process.env.MOCK_DEFAULT_MODEL ?? 'mock/good-model').split('/');
  console.log(JSON.stringify([{ type: 'document', path: '/home/user/.config/opencode/opencode.json', info: { model: { providerID, model: rest.join('/') } } }]));
  process.exit(0);
}
if (cmd === 'session' && argv[1] === 'export') {
  console.log(JSON.stringify({ info: {}, messages: [{ type: 'assistant', agent: 'pitroom-read', model: { providerID: 'mock', id: 'good-model' } }] }));
  process.exit(0);
}
if (cmd !== 'run') process.exit(2);

const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// Like OpenCode v2: the workspace is $PWD when set, not the process cwd.
const dir = opt('--dir') ?? process.env.PWD ?? process.cwd();
const session = opt('--session') ?? 'ses_mock123';
const emit = (type, part = {}) =>
  console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: session, part: { sessionID: session, ...part } }));

let msg = 0;
const step = (fn) => {
  msg++;
  emit('step_start', { messageID: `msg_${msg}` });
  fn(`msg_${msg}`);
  emit('step_finish', {
    messageID: `msg_${msg}`,
    // v2 reports no tokens.total
    tokens: { input: 10000, output: 400, reasoning: 100, cache: { read: 0, write: 0 } },
    cost: 0,
  });
};

const model = opt('--model') ?? 'default';
if ((process.env.MOCK_FAIL_MODELS ?? '').split(',').includes(model)) {
  console.log(JSON.stringify({ type: 'error', sessionID: session, error: { type: 'provider.model', message: `ProviderModelNotFoundError: Model not found: ${model}.` } }));
  process.exit(1);
}

if ((process.env.MOCK_RATE_LIMIT_MODELS ?? '').split(',').includes(model)) {
  console.log(JSON.stringify({ type: 'error', sessionID: session, error: { type: 'provider.rate', message: 'Rate limit exceeded: free-models-per-day. Please retry in 2h.' } }));
  process.exit(1);
}

// Split only on ";" that starts a new action, so answers and commands may contain ";".
// A task may carry its own script as [[mock:…]] (lets one crew run different tasks).
const inline = /\[\[mock:([\s\S]*?)\]\]/.exec(argv[argv.length - 1] ?? '')?.[1];
const actions = (inline ?? process.env.MOCK_ACTIONS ?? 'answer:SUMMARY: mock answer')
  .split(/;(?=(?:answer|append|write|sleep|fail|exec):)/)
  .filter(Boolean);
for (const a of actions) {
  const [kind, ...rest] = a.split(':');
  if (kind === 'sleep') await new Promise((r) => setTimeout(r, Number(rest[0]) * 1000));
  if (kind === 'fail') {
    console.log(JSON.stringify({ type: 'error', sessionID: session, error: { type: 'unknown', message: rest.join(':') } }));
    process.exit(1);
  }
  if (kind === 'append') {
    const [file, ...text] = rest;
    step((m) => {
      emit('text', { messageID: m, text: 'Let me edit the file.' });
      fs.appendFileSync(path.join(dir, file), `${text.join(':')}\n`);
      emit('tool_use', { messageID: m, tool: 'edit', state: { status: 'completed', input: { filePath: path.join(dir, file) } } });
    });
  }
  if (kind === 'write') {
    const [file, ...text] = rest;
    step((m) => {
      fs.writeFileSync(path.join(dir, file), `${text.join(':')}\n`);
      emit('tool_use', { messageID: m, tool: 'write', state: { status: 'completed', input: { path: path.join(dir, file) } } });
    });
  }
  if (kind === 'answer') step((m) => emit('text', { messageID: m, text: rest.join(':').replace(/\\n/g, '\n') }));
  if (kind === 'exec') {
    const command = rest.join(':');
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: process.env });
    fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ exec: command, code: r.status, output: `${r.stdout}${r.stderr}` }) + '\n');
    step((m) => emit('tool_use', { messageID: m, tool: 'shell', state: { status: 'completed', input: { command }, output: r.stdout } }));
  }
}
