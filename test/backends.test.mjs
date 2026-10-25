// Adapter contract: every registered worker backend must pass these, using
// event streams recorded from its real CLI in test/fixtures/<id>/.
// Adding a backend = implement it, record fixtures, and this suite covers it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_COMMANDS, allBackends, getBackend, linkInto, parseTarget, writeIfChanged } from '../dist/lib.mjs';

// Adapters may keep private files under Pitroom's home: tests must not write to the real one.
process.env.PITROOM_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-backends-'));

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Flags/values that would switch off a CLI's own safety. Pitroom must never emit them.
const BYPASS = [
  '--auto',
  '--yolo',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  'bypassPermissions',
];

const request = (over = {}) => ({
  mode: 'read',
  prompt: 'PROMPT-SENTINEL',
  cwd: '/tmp/project',
  files: [],
  web: false,
  title: 'contract',
  ...over,
});

const flat = (inv) => JSON.stringify([inv.command, ...inv.args, ...Object.values(inv.env)]);

for (const b of allBackends()) {
  const dir = path.join(FIXTURES, b.id);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

  test(`${b.id}: declares valid capabilities`, () => {
    assert.ok(['permission-rules', 'os-sandbox', 'tool-allowlist', 'approval-mode', 'snapshot'].includes(b.capabilities.readOnly));
    assert.ok(['by-id', 'none'].includes(b.capabilities.resume));
    assert.equal(typeof b.capabilities.reportsCost, 'boolean');
    assert.equal(typeof b.capabilities.attachFiles, 'boolean');
    assert.match(b.id, /^[a-z][a-z0-9-]*$/);
  });

  test(`${b.id}: never emits permission-bypass flags`, () => {
    for (const mode of ['read', 'write', 'isolate']) {
      const s = flat(b.invocation(request({ mode, web: true })));
      for (const bad of BYPASS) assert.ok(!s.includes(bad), `${mode} invocation contains ${bad}`);
    }
  });

  test(`${b.id}: read-only and editing runs are configured differently`, () => {
    assert.notEqual(flat(b.invocation(request({ mode: 'read' }))), flat(b.invocation(request({ mode: 'write' }))));
  });

  test(`${b.id}: prompt travels in argv (stdin is always closed by the core)`, () => {
    assert.ok(b.invocation(request()).args.includes('PROMPT-SENTINEL'));
  });

  test(`${b.id}: model, session and files appear only when given`, () => {
    const bare = flat(b.invocation(request()));
    for (const s of ['MODEL-X', 'SES-X', '/tmp/ATTACHED']) assert.ok(!bare.includes(s));
    const full = flat(b.invocation(request({ model: 'MODEL-X', sessionId: 'SES-X', files: b.capabilities.attachFiles ? ['/tmp/ATTACHED'] : [] })));
    assert.ok(full.includes('MODEL-X'));
    if (b.capabilities.resume === 'by-id') assert.ok(full.includes('SES-X'));
    if (b.capabilities.attachFiles) assert.ok(full.includes('/tmp/ATTACHED'));
  });

  for (const [file, want] of Object.entries(expected.events)) {
    test(`${b.id}: parses recorded stream ${file}`, () => {
      const raw = fs.readFileSync(path.join(dir, 'events', file), 'utf8');
      const run = b.parse(raw);
      assert.equal(run.sessionId, want.sessionId);
      assert.equal(run.usage.steps, want.steps);
      assert.equal(run.usage.total, want.total);
      assert.ok(run.finalText.startsWith(want.finalTextStartsWith), run.finalText.slice(0, 80));
      if ('denied' in want) assert.equal(run.usage.denied, want.denied, 'refused tool calls counted');
      if ('edits' in want) assert.equal(run.edits.length, want.edits, 'completed edits detected');
      assert.ok(Array.isArray(run.timeline), 'a step-by-step timeline');
      if (run.usage.toolCalls > 0) assert.ok(run.timeline.some((s) => s.kind !== 'say' && s.text), 'tool calls appear in it');
      assert.ok(run.timeline.every((s) => s.text.length <= 600), 'step texts are short');
      if (b.capabilities.reportsCost) assert.equal(typeof run.usage.cost, 'number');
      assert.equal(b.failure(run, '', 0), undefined, 'a clean run is not a failure');
      // Streams are read while still being written: a torn last line must not throw.
      assert.doesNotThrow(() => b.parse(raw.slice(0, Math.floor(raw.length / 2))));
    });
  }

  for (const [name, want] of Object.entries(expected.failures)) {
    // The stderr half is a *.log file, which .gitignore keeps out of git: a fresh clone
    // (or a worker's isolated copy) has no such file, so the case is skipped there.
    const stderrFile = path.join(dir, 'failures', `${name}.stderr.log`);
    const skip = !fs.existsSync(stderrFile) && `${name}.stderr.log is not in this checkout (gitignored)`;
    test(`${b.id}: classifies recorded failure ${name}`, { skip }, () => {
      const stdout = fs.readFileSync(path.join(dir, 'failures', `${name}.stdout.jsonl`), 'utf8');
      const stderr = fs.readFileSync(stderrFile, 'utf8');
      const f = b.failure(b.parse(stdout), stderr, want.exitCode);
      assert.equal(f?.kind, want.kind);
      assert.ok(f.message.includes(want.messageIncludes), f.message);
    });
  }
}

test('targets: backend[:model], bare models and models containing ":"', () => {
  assert.deepEqual(parseTarget('opencode', 'opencode'), { backend: 'opencode' });
  assert.deepEqual(parseTarget('opencode:opencode/space-bunny-free', 'opencode'), { backend: 'opencode', model: 'opencode/space-bunny-free' });
  assert.deepEqual(parseTarget('opencode/space-bunny-free', 'opencode'), { backend: 'opencode', model: 'opencode/space-bunny-free' });
  assert.deepEqual(parseTarget('ollama/qwen3:8b', 'opencode'), { backend: 'opencode', model: 'ollama/qwen3:8b' });
  assert.deepEqual(parseTarget('opencode:ollama/qwen3:8b', 'opencode'), { backend: 'opencode', model: 'ollama/qwen3:8b' });
  assert.deepEqual(parseTarget(' opencode: ', 'opencode'), { backend: 'opencode' });
  assert.throws(() => parseTarget('  ', 'opencode'), /empty worker target/);
});

test('targets: gemini is a worker; an unknown one gets a clear message', () => {
  assert.deepEqual(parseTarget('gemini:gemini-3-flash', 'opencode'), { backend: 'gemini', model: 'gemini-3-flash' });
  assert.equal(getBackend('gemini').id, 'gemini');
  assert.throws(() => getBackend('nope'), /unknown worker "nope"/);
  assert.throws(() => getBackend('hermes'), /the "hermes" worker is not supported yet/, 'a considered worker gets a clear answer');
});

test('opencode: every run uses a private --standalone server and no removed v1 flags', async () => {
  const b = getBackend('opencode');
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    // Without --standalone, v2 attaches to the shared background service and the
    // injected permission profiles and git guard would not apply.
    assert.ok(inv.args.includes('--standalone'), mode);
    assert.ok(!inv.args.includes('--dir'), 'removed in v2');
    assert.equal(inv.args.at(-1), 'PROMPT-SENTINEL', 'message goes last');
    assert.equal(inv.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    const perm = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT).agent[mode === 'read' ? 'pitroom-read' : 'pitroom-write'].permission;
    assert.deepEqual(perm.shell, perm.bash, 'v2 "shell" gets the same rules as v1 "bash"');
    assert.equal(perm.execute, 'deny', 'v2 namespaced tools (browser, opencode API) are off');
  }
});

test('codex: OS sandbox per mode (also on resume), user config ignored, effort from #variant', () => {
  const b = getBackend('codex');
  const arg = (inv, key) => inv.args.find((a) => a.startsWith(`${key}=`));
  for (const [mode, sandbox] of [['read', 'read-only'], ['write', 'workspace-write'], ['isolate', 'workspace-write']]) {
    for (const sessionId of [undefined, 'SES-1']) {
      const inv = b.invocation(request({ mode, sessionId }));
      assert.equal(arg(inv, 'sandbox_mode'), `sandbox_mode="${sandbox}"`, `${mode} ${sessionId ?? 'new'}`);
      assert.equal(arg(inv, 'approval_policy'), 'approval_policy="never"');
      assert.ok(inv.args.includes('--ignore-user-config'), 'user MCP servers and profiles stay out');
      assert.ok(!inv.args.includes('-s') && !inv.args.includes('-C'), 'resume accepts neither');
    }
  }
  const inv = b.invocation(request({ model: 'gpt-5.6-sol#low' }));
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(arg(inv, 'model_reasoning_effort'), 'model_reasoning_effort="low"');
  assert.equal(inv.args.at(-1), 'PROMPT-SENTINEL');
});

test('claude: "model#level" becomes --model and --effort', () => {
  const b = getBackend('claude');
  const inv = b.invocation(request({ model: 'sonnet#high' }));
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'sonnet');
  assert.equal(inv.args[inv.args.indexOf('--effort') + 1], 'high');
  const only = b.invocation(request({ model: '#low' }));
  assert.equal(only.args.includes('--model'), false, 'an effort alone pins no model');
  assert.equal(only.args[only.args.indexOf('--effort') + 1], 'low');
  assert.equal(b.invocation(request({})).args.includes('--effort'), false);
});

test('claude: locked down in every mode; read gets only read tools; secrets denied', () => {
  const b = getBackend('claude');
  const after = (inv, flag) => inv.args[inv.args.indexOf(flag) + 1];
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    for (const f of ['-p', '--safe-mode', '--restricted', '--strict-mcp-config']) assert.ok(inv.args.includes(f), `${mode}: ${f}`);
    assert.equal(after(inv, '--permission-mode'), 'dontAsk');
    assert.deepEqual(inv.args.slice(-2), ['--', 'PROMPT-SENTINEL'], 'prompt after --, never swallowed by a list option');
    assert.match(after(inv, '--settings'), /Read\(\*\*\/\.env\)/);
  }
  const read = b.invocation(request({ mode: 'read' }));
  assert.equal(after(read, '--tools'), 'Read,Grep,Glob');
  assert.equal(after(read, '--allowedTools'), 'Read,Grep,Glob');
  assert.ok(!read.args.includes('--disallowedTools'));
  const write = b.invocation(request({ mode: 'write' }));
  assert.equal(after(write, '--tools'), 'Read,Grep,Glob,Edit,Write,Bash');
  assert.ok(write.args.includes('Bash(git commit:*)') && write.args.includes('Bash(git push:*)'));
  assert.match(after(b.invocation(request({ mode: 'read', web: true })), '--tools'), /WebFetch,WebSearch/);
});

test('claude: an auth failure did no work, so the fallback chain may move on', () => {
  const b = getBackend('claude');
  const dir = path.join(FIXTURES, 'claude', 'failures');
  const run = b.parse(fs.readFileSync(path.join(dir, 'auth-expired.stdout.jsonl'), 'utf8'));
  assert.equal(run.usage.steps, 0);
  assert.equal(run.model, 'claude-opus-5[1m]');
  assert.equal(b.failure(run, '', 1).kind, 'auth');
});

test('gemini: read is the CLI\'s plan mode; write and isolate auto-approve edits and allow vetted shell', () => {
  const b = getBackend('gemini');
  const after = (inv, flag) => inv.args[inv.args.indexOf(flag) + 1];
  const policies = (inv) => inv.args.flatMap((a, i) => (a === '--policy' ? [path.basename(inv.args[i + 1])] : []));
  const read = b.invocation(request({ mode: 'read' }));
  assert.equal(after(read, '--approval-mode'), 'plan');
  assert.deepEqual(policies(read), ['base.toml', 'no-web.toml'], 'secrets and MCP refused, no web unless asked');
  for (const mode of ['write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    assert.equal(after(inv, '--approval-mode'), 'auto_edit', mode);
    assert.deepEqual(policies(inv), ['base.toml', 'no-web.toml', 'shell.toml'], mode);
  }
  assert.deepEqual(policies(b.invocation(request({ mode: 'read', web: true }))), ['base.toml'], 'a web run drops the no-web rule');
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    assert.equal(after(inv, '-e'), 'none', 'no extensions');
    assert.equal(inv.env.GEMINI_CLI_HOME, path.join(process.env.PITROOM_HOME, 'gemini-home'), 'workers run in a private Gemini home');
    assert.ok(!inv.args.includes('--skip-trust'), 'folder trust is opt-in');
    assert.ok(!inv.args.includes('yolo') && !inv.args.some((a) => /yolo/i.test(a)));
  }
});

test('gemini: the shipped settings and rules close off hooks, MCP and unsafe shell', () => {
  const dir = path.resolve(FIXTURES, '..', '..', 'policies', 'gemini');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'worker-settings.json'), 'utf8'));
  assert.equal(settings.hooksConfig.enabled, false, 'the user\'s hooks would run on every worker');
  // An empty allow list means "no restriction" in Gemini CLI; a name no server has blocks them all.
  assert.ok(settings.mcp.allowed.length > 0, 'MCP allow list is not empty');
  assert.equal(settings.security.disableYoloMode, true);
  assert.equal(settings.general.enableAutoUpdate, false);
  const shell = fs.readFileSync(path.join(dir, 'shell.toml'), 'utf8');
  for (const cmd of ['git commit', 'git push', 'rm -rf', 'sudo', 'pitroom', 'gemini']) assert.ok(shell.includes(`"${cmd}"`), cmd);
  // Gemini CLI 0.62 requires toolName in every rule, MCP rules included.
  assert.match(fs.readFileSync(path.join(dir, 'base.toml'), 'utf8'), /toolName = "\*"\nmcpName = "\*"\ndecision = "deny"/);
  assert.match(fs.readFileSync(path.join(dir, 'no-web.toml'), 'utf8'), /google_web_search/);
  // The secret-file rule matches the JSON of the tool's arguments: relative and absolute paths alike.
  const base = fs.readFileSync(path.join(dir, 'base.toml'), 'utf8');
  const secret = new RegExp(base.match(/toolName = "read_file"[\s\S]*?argsPattern = '(.*)'/)[1]);
  const hit = (p) => secret.test(JSON.stringify({ file_path: p }));
  for (const p of ['.env', '/a/.env', 'prod.env', '/x/.env.local', 'server.pem', '/k/server.pem', 'id_rsa', '/h/.ssh/id_ed25519.pub']) assert.ok(hit(p), `${p} is refused`);
  for (const p of ['environment.ts', '/src/environment.ts', 'env.md', 'app.txt', '/a/pemfile.md']) assert.ok(!hit(p), `${p} stays readable`);
});

test('gemini: the private home carries the user\'s sign-in method, switches hooks off, and trust is opt-in', () => {
  const b = getBackend('gemini');
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-gemuser-'));
  fs.mkdirSync(path.join(userHome, '.gemini'));
  fs.writeFileSync(path.join(userHome, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, hooksConfig: { enabled: true }, model: { name: 'x' } }));
  fs.writeFileSync(path.join(userHome, '.gemini', 'trustedFolders.json'), '{}');
  fs.writeFileSync(path.join(userHome, '.gemini', 'oauth_creds.json'), '{}');
  const saved = { home: process.env.GEMINI_CLI_HOME, trust: process.env.PITROOM_GEMINI_TRUST, ph: process.env.PITROOM_HOME };
  process.env.GEMINI_CLI_HOME = userHome;
  process.env.PITROOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-gemhome-'));
  try {
    const inv = b.invocation(request({}));
    const written = JSON.parse(fs.readFileSync(path.join(inv.env.GEMINI_CLI_HOME, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(written.security.auth.selectedType, 'gemini-api-key', 'the sign-in method is carried over');
    assert.equal(written.hooksConfig.enabled, false, 'the user\'s hooks are not');
    assert.equal(written.model, undefined, 'nor the rest of their settings');
    assert.ok(fs.existsSync(path.join(inv.env.GEMINI_CLI_HOME, '.gemini', 'oauth_creds.json')), 'sign-in files are linked');
    assert.equal(inv.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH, path.join(userHome, '.gemini', 'trustedFolders.json'), 'folders trusted in Gemini stay trusted');
    process.env.PITROOM_GEMINI_TRUST = '1';
    assert.ok(b.invocation(request({})).args.includes('--skip-trust'));
    const f = b.failure(b.parse(''), 'Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`', 1);
    assert.match(f.message, /PITROOM_GEMINI_TRUST=1/);
  } finally {
    for (const [k, v] of [['GEMINI_CLI_HOME', saved.home], ['PITROOM_GEMINI_TRUST', saved.trust], ['PITROOM_HOME', saved.ph]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('gemini: "model#level" drops the level (no effort option); a prompt starting with "-" stays a value', () => {
  const b = getBackend('gemini');
  const inv = b.invocation(request({ model: 'gemini-3.8-flash#high' }));
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(b.invocation(request({})).args.includes('--model'), false);
  const dash = b.invocation(request({ prompt: '--help me' }));
  assert.equal(dash.args[dash.args.indexOf('--prompt') + 1], ' --help me');
});

test('gemini: the stream is merged into steps and an answer; hook noise and warnings are ignored', () => {
  const b = getBackend('gemini');
  const stream = [
    'Created execution plan for SessionEnd: 2 hook(s) to execute in parallel', // a user's hook printing into stdout
    '{"type":"init","timestamp":"t","session_id":"S1","model":"gemini-3.8-flash"}',
    '{"type":"message","timestamp":"t","role":"assistant","content":"Look","delta":true}',
    '{"type":"message","timestamp":"t","role":"assistant","content":"ing.","delta":true}',
    '{"type":"tool_use","timestamp":"t","tool_name":"glob","tool_id":"g1","parameters":{"pattern":"**/*.ts"}}',
    '{"type":"error","timestamp":"t","severity":"warning","message":"loop detected"}',
    '{"type":"tool_result","timestamp":"t","tool_id":"g1","status":"success"}',
    '{"type":"message","timestamp":"t","role":"assistant","content":"Done: ","delta":true}',
    '{"type":"message","timestamp":"t","role":"assistant","content":"two files.","delta":true}',
    '{"type":"result","timestamp":"t","status":"success","stats":{"total_tokens":100,"input_tokens":80,"output_tokens":20,"cached":30,"input":50,"tool_calls":1,"models":{}}}',
  ].join('\n');
  const run = b.parse(stream);
  assert.equal(run.model, 'gemini-3.8-flash');
  assert.equal(run.finalText, 'Done: two files.', 'only the answer after the last tool call');
  assert.equal(run.error, undefined, 'a warning is not an error');
  assert.equal(run.usage.steps, 2);
  assert.deepEqual([run.usage.input, run.usage.cacheRead, run.usage.output, run.usage.total], [50, 30, 20, 100]);
  assert.deepEqual(run.timeline.map((s) => s.kind), ['say', 'tool', 'say']);
  assert.equal(run.timeline[1].ok, true);
  assert.equal(run.tools.glob, 1);
});

test('gemini: a refused tool counts as denied; an error result is the failure message', () => {
  const b = getBackend('gemini');
  const denied = b.parse(fs.readFileSync(path.join(FIXTURES, 'gemini', 'events', 'write-edit.jsonl'), 'utf8'));
  assert.equal(denied.usage.denied, 1);
  assert.deepEqual(denied.edits, ['/work/math.js', '/work/test/divide.test.js']);
  assert.ok(denied.timeline.some((s) => s.kind === 'shell' && s.ok === false));
  const quota = b.parse(fs.readFileSync(path.join(FIXTURES, 'gemini', 'failures', 'quota.stdout.jsonl'), 'utf8'));
  assert.match(quota.error, /exhausted your capacity/);
  assert.equal(quota.finalText, '');
  assert.equal(b.failure(quota, '', 1).kind, 'rate-limited');
});

test('opencode: "Endpoint is unavailable" (HTTP 400) is a rate limit: the model cools down and the next worker runs', () => {
  const b = getBackend('opencode');
  const run = { ...b.parse(''), error: 'Endpoint is unavailable [provider.invalid-request, HTTP 400]' };
  assert.equal(b.failure(run, '', 1).kind, 'rate-limited');
});

test('gemini: a follow-up resumes by the session id (never an index or "latest", which are unsafe beside parallel workers)', () => {
  const b = getBackend('gemini');
  assert.equal(b.capabilities.resume, 'by-id');
  const argv = (over) => b.invocation(request(over)).args;
  const withId = argv({ sessionId: '1413e6ff-f8d1-4e12-98e0-8b4f374d207b' });
  assert.equal(withId[withId.indexOf('--resume') + 1], '1413e6ff-f8d1-4e12-98e0-8b4f374d207b');
  assert.equal(withId.filter((a) => a === '--resume').length, 1);
  assert.ok(!argv({}).includes('--resume'), 'a first run does not resume anything');
  assert.ok(!['latest', '-r'].some((a) => withId.includes(a)), 'no "latest" and no short flag');
});

test('qwen: safe mode in every mode; read is plan mode; tools that act outside the task are excluded; the prompt comes first', () => {
  const b = getBackend('qwen');
  const after = (inv, flag) => inv.args[inv.args.indexOf(flag) + 1];
  const excluded = (inv) => {
    const i = inv.args.indexOf('--exclude-tools');
    const rest = inv.args.slice(i + 1);
    return rest.slice(0, rest.findIndex((a) => a.startsWith('--')) === -1 ? rest.length : rest.findIndex((a) => a.startsWith('--')));
  };
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    assert.ok(inv.args.includes('--safe-mode'), `${mode}: no user hooks, skills, MCP or memory extraction`);
    assert.equal(after(inv, '--output-format'), 'stream-json');
    assert.ok(inv.args.indexOf('PROMPT-SENTINEL') < inv.args.indexOf('--safe-mode'), 'the prompt before every list option');
    for (const tool of ['enter_worktree', 'manage_memory', 'agent', 'cron_create', 'web_fetch']) assert.ok(excluded(inv).includes(tool), `${mode}: ${tool} excluded`);
    assert.ok(fs.existsSync(inv.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH), 'the worker defaults ship with the package');
    assert.ok(!inv.args.includes('-y') && after(inv, '--approval-mode') !== 'yolo' && after(inv, '--approval-mode') !== 'auto');
  }
  const read = b.invocation(request({ mode: 'read' }));
  assert.equal(after(read, '--approval-mode'), 'plan');
  assert.ok(!read.args.includes('--allowed-tools'), 'no shell in read mode');
  const write = b.invocation(request({ mode: 'write' }));
  assert.equal(after(write, '--approval-mode'), 'default', 'not auto-edit, which approves an edit anywhere on disk');
  const allowed = write.args.slice(write.args.indexOf('--allowed-tools') + 1);
  assert.deepEqual(allowed.slice(0, 4), ['Edit(./**)', 'write_file(./**)', 'notebook_edit(./**)', 'run_shell_command'], 'edits only inside the working directory');
  assert.ok(excluded(write).includes('run_shell_command(git commit)') && excluded(write).includes('run_shell_command(rm -rf)'));
  assert.ok(!excluded(b.invocation(request({ web: true }))).includes('web_fetch'), '--web lets it fetch');
  assert.equal(b.invocation(request({ prompt: '-x looks like a flag' })).args.find((a) => a.includes('looks like')), ' -x looks like a flag');
  const model = b.invocation(request({ model: 'qwen3-coder-plus#high', sessionId: 'SES-1' }));
  assert.equal(after(model, '--model'), 'qwen3-coder-plus', 'an effort level has no Qwen Code equivalent');
  assert.equal(after(model, '--resume'), 'SES-1');
  const defaults = JSON.parse(fs.readFileSync(read.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, 'utf8'));
  assert.equal(defaults.model.generationConfig.maxRetries, 0, 'no 10 × 60 s waits on a quota error');
});

test('qwen: an API error is not work done, so the fallback chain may move on', () => {
  const b = getBackend('qwen');
  const run = b.parse(fs.readFileSync(path.join(FIXTURES, 'qwen', 'failures', 'quota-exceeded.stdout.jsonl'), 'utf8'));
  assert.equal(run.usage.steps, 0);
  assert.equal(run.finalText, '');
  assert.equal(b.failure(run, '', 1).kind, 'rate-limited');
});

test('kilo: OpenCode\'s profiles through KILO_CONFIG_CONTENT, a private state folder (no daemon to attach to), never --auto', () => {
  const b = getBackend('kilo');
  const after = (inv, flag) => inv.args[inv.args.indexOf(flag) + 1];
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    assert.equal(after(inv, '--agent'), mode === 'read' ? 'pitroom-read' : 'pitroom-write');
    assert.equal(after(inv, '--format'), 'json');
    assert.equal(after(inv, '--log-level'), 'ERROR', 'Kilo takes the level in capitals only');
    assert.equal(inv.args.at(-1), 'PROMPT-SENTINEL');
    assert.ok(!inv.args.includes('--auto') && !inv.args.includes('--attach'));
    assert.match(inv.env.XDG_STATE_HOME, /kilo-state$/, 'a running kilo daemon would ignore the injected config');
    const config = JSON.parse(inv.env.KILO_CONFIG_CONTENT);
    assert.equal(config.autoupdate, false);
    const perm = config.agent[mode === 'read' ? 'pitroom-read' : 'pitroom-write'].permission;
    if (mode === 'read') assert.equal(perm.edit, 'deny');
    assert.equal(perm.bash['git commit*'] ?? perm.bash['*'], 'deny');
    assert.ok(Object.keys(perm.external_directory).some((k) => k.includes(`${path.sep}kilo${path.sep}`)), 'Kilo\'s own scratch folders, not OpenCode\'s');
  }
  assert.equal(JSON.parse(b.invocation(request({ web: true })).env.KILO_CONFIG_CONTENT).agent['pitroom-read'].permission.webfetch, 'allow');
});

test('antigravity: read is agy\'s plan mode, write and isolate accept edits; sandbox in every mode; never --continue or skip-permissions', () => {
  const b = getBackend('antigravity');
  const after = (inv, flag) => inv.args[inv.args.indexOf(flag) + 1];
  for (const mode of ['read', 'write', 'isolate']) {
    const inv = b.invocation(request({ mode }));
    assert.equal(after(inv, '-p'), 'PROMPT-SENTINEL');
    assert.equal(after(inv, '--output-format'), 'stream-json');
    assert.equal(after(inv, '--mode'), mode === 'read' ? 'plan' : 'accept-edits');
    assert.ok(inv.args.includes('--sandbox'), `${mode}: shell commands in agy's terminal sandbox`);
    assert.ok(after(inv, '--print-timeout'), 'agy\'s 5 minute default would cut long runs short');
    assert.ok(!inv.args.includes('-c') && !inv.args.includes('--continue'), 'the latest conversation is unsafe beside parallel workers');
    // agy reads its settings only from ~/.gemini/antigravity-cli: a home of Pitroom's own, one per workspace
    assert.match(inv.env.HOME, /antigravity-home[\\/][0-9a-f]{16}$/);
    assert.ok(!('ANTIGRAVITY_APP_DATA_DIR' in inv.env), 'agy ignores it');
  }
  const a = b.invocation(request({ cwd: '/tmp/project-a' })).env.HOME;
  assert.equal(b.invocation(request({ cwd: '/tmp/project-a', mode: 'write' })).env.HOME, a, 'a follow-up in another mode finds its conversation');
  assert.notEqual(b.invocation(request({ cwd: '/tmp/project-b' })).env.HOME, a);
  const followUp = b.invocation(request({ model: 'gemini-3.8-flash#low', sessionId: 'SES-1' }));
  assert.equal(after(followUp, '--conversation'), 'SES-1');
  assert.equal(after(followUp, '--model'), 'gemini-3.8-flash');
  assert.equal(after(followUp, '--effort'), 'low');
  assert.ok(!b.invocation(request()).args.includes('--effort'));
  assert.equal(after(b.invocation(request({ prompt: '-x looks like a flag' })), '-p'), ' -x looks like a flag');
});

/**
 * agy's command matching as agy 1.3.5 was seen to do it: it splits the command line into simple commands and takes
 * off wrappers such as `env -i` itself (checked against the real CLI, not here); a rule is then a prefix compared
 * word by word, and a `regex:` rule compares each command word with one pattern word, the whole word.
 */
function agyDenies(rules, command) {
  const words = command.trim().split(/\s+/);
  return rules.some((rule) => {
    const target = /^command\((.*)\)$/.exec(rule)?.[1];
    if (target === undefined) return false;
    const regex = target.startsWith('regex:');
    const want = (regex ? target.slice(6) : target).split(' ');
    return want.length <= words.length && want.every((w, i) => (regex ? new RegExp(`^(?:${w})$`).test(words[i]) : w === words[i]));
  });
}

test('antigravity: the private settings deny secrets, history-changing git, other agents, MCP and the web, and keep file tools in the workspace', () => {
  const b = getBackend('antigravity');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-workspace-'));
  for (const f of ['.env', 'sub/.env.local', 'server.pem', 'README.md', 'src/env.ts']) {
    fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
    fs.writeFileSync(path.join(workspace, f), 'x');
  }
  const home = b.invocation(request({ cwd: workspace })).env.HOME;
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.equal(settings.toolPermission, 'proceed-in-sandbox', 'commands run sandboxed, never unsandboxed without asking');
  assert.equal(settings.enableTerminalSandbox, true);
  assert.equal(settings.permissions.allow[0], 'command(*)', 'without a grant a headless agy refuses every command');
  const allow = settings.permissions.allow.slice(1);
  assert.ok(allow.every((r) => /^write_file\(.*brain\)$/.test(r) || r.startsWith('read_file(')), 'only its own plan folder is writable outside the workspace');
  assert.ok(!allow.some((r) => r.startsWith('write_file(') && !r.endsWith('brain)')), 'a read run may not write its workspace');
  // an edit may (agy 1.4 asks even with --mode accept-edits, and a headless run cannot ask)
  const edits = JSON.parse(fs.readFileSync(path.join(b.invocation(request({ cwd: workspace, mode: 'isolate' })).env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  const own = (p) => p.replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/');
  assert.ok(edits.permissions.allow.includes(`write_file(${own(workspace)})`), edits.permissions.allow.join('\n'));
  assert.ok(edits.permissions.deny.includes(`read_file(${own(path.join(workspace, '.env'))})`), 'its secrets stay closed, for writes too');
  assert.ok(allow.filter((r) => r.startsWith('read_file(')).every((r) => path.isAbsolute(r.slice(10, -1))), 'toolchains on PATH, read-only');
  assert.equal(b.capabilities.readOnly, 'snapshot', 'agy has no read-only mode for -p runs: read runs read a snapshot');
  const deny = settings.permissions.deny;
  // read_file rules are absolute paths (a relative one breaks agy's sandbox, a regex is not read)
  const reads = deny.filter((r) => r.startsWith('read_file(')).map((r) => r.slice(10, -1));
  assert.ok(reads.every((p) => path.isAbsolute(p)), reads.join('\n'));
  // as agy compares paths: on Windows without the drive letter, with slashes
  const asAgy = (f) => path.join(workspace, f).replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/');
  for (const f of ['.env', 'sub/.env.local', 'server.pem']) assert.ok(reads.includes(asAgy(f)), f);
  for (const f of ['README.md', 'src/env.ts']) assert.ok(!reads.includes(asAgy(f)), f);
  // agy splits a pattern at spaces and drops backslashes
  assert.ok(deny.every((r) => !r.includes('\\')), 'no backslash in a rule');
  const forbidden = [
    'git commit -am x', 'git push', 'rm -rf /', 'sudo ls', 'agy -p hi', 'pitroom run x', 'claude -p x', 'npm publish',
    // by path, with git's global options, and every spelling of a recursive delete
    '/usr/bin/git commit', '/usr/bin/git status', '/usr/local/bin/claude -p x', '/bin/rm -rf x',
    'git -C /other/repo status', 'git -c core.x=y commit', 'git --no-pager push', 'git -P commit -m x', 'git --no-pager -P push',
    'rm -r -f src', 'rm -Rf src', 'rm --recursive --force src', 'rm src -rf', 'rm -r src', 'rm -f a b c src -r', 'rm a --recursive',
    // a command hidden in a string, or run by find
    'bash -c "git push"', 'sh -lc x', '/bin/sh -c x', 'eval "$CMD"',
    'find . -name src -exec rm -rf {} +', 'find . -type d -name x -execdir /bin/rm -r {} ;', 'find . -exec git add {} +', 'find . -name "*.tmp" -delete', 'find . -exec sudo ls ;',
    'xargs rm -rf', 'xargs -0 rm -rf', 'xargs -I {} rm -rf {}', 'xargs -I {} git add {}', 'xargs sudo ls', '/usr/bin/xargs -0 /bin/rm -r',
  ];
  // a line with `{}` in it is matched whole (agy does not split it): forbidden commands anywhere in it
  const whole = deny.filter((r) => r.startsWith('command(regex:')).map((r) => new RegExp(`^(?:${r.slice(14, -1)})$`));
  for (const c of ['echo src | xargs -I {} rm -rf {}', 'ls && find . -name src -exec rm -rf {} +', 'ls | xargs -I {} git add {}', 'echo {} && git commit -m x', 'echo {}; rm -rf src']) {
    assert.ok(whole.some((re) => re.test(c)), c);
  }
  assert.ok(!whole.some((re) => re.test('echo app.txt | xargs -I {} cat {}')));
  for (const c of forbidden) assert.ok(agyDenies(deny, c), c);
  for (const c of ['git status', 'git diff', 'npm test', 'node --test', 'gitk', 'grep -rn "git commit" .', 'echo commit', 'ls skill/', 'rm notes-r.txt', 'rm a.txt', 'ls -R', 'git --no-pager diff', 'find . -name x', 'bash script.sh', 'xargs -0 wc -l', 'xargs -I {} cat {}']) {
    assert.ok(!agyDenies(deny, c), c);
  }
  for (const r of ['mcp(*)', 'read_url(*)', 'execute_url(*)']) assert.ok(deny.includes(r), r);
});

test('antigravity: the parser keeps an answer after a retried error, and steps without an index are counted once', () => {
  const b = getBackend('antigravity');
  const lines = (...events) => events.map((e) => JSON.stringify(e)).join('\n');
  const retried = b.parse(lines(
    { type: 'init', conversation_id: 'C1' },
    { type: 'error', message: 'API error (attempt 1): 503 overloaded' },
    { type: 'result', status: 'SUCCESS', response: 'SUMMARY: done', error: {} },
  ));
  assert.equal(retried.error, undefined);
  assert.equal(retried.finalText, 'SUMMARY: done');
  assert.equal(b.failure(retried, '', 0), undefined);
  const unrecovered = b.parse(lines({ type: 'init', conversation_id: 'C2' }, { type: 'error', message: 'RESOURCE_EXHAUSTED (code 429)' }, { type: 'result', status: 'SUCCESS', response: '' }));
  assert.equal(b.failure(unrecovered, '', 0)?.kind, 'rate-limited', 'an error with no answer after it is the run\'s');
  const tool = (state, extra = {}) => ({ type: 'step_update', step_update: { state, step_type: 'tool', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/p/a.js' }, ...extra } } });
  const say = (state, text_delta) => ({ type: 'step_update', step_update: { state, step_type: 'agent_response', text_delta } });
  const noIndex = b.parse(lines(tool('ACTIVE'), tool('DONE', { output: 'x' }), tool('ACTIVE'), tool('DONE'), say('ACTIVE', 'SUMMARY: '), say('DONE', 'two reads')));
  assert.equal(noIndex.usage.toolCalls, 2);
  assert.equal(noIndex.timeline.filter((t) => t.kind === 'tool').length, 2);
  assert.equal(noIndex.finalText, 'SUMMARY: two reads');
  // a repeated DONE update adds its tokens once; an error object without a message still names its code
  const step = { type: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 5000, total_tokens: 5000 } } };
  assert.equal(b.parse(lines(step, step)).usage.total, 5000);
  const coded = b.parse(lines({ type: 'result', status: 'ERROR', error: { code: 'RESOURCE_EXHAUSTED' } }));
  assert.equal(b.failure(coded, '', 1)?.kind, 'rate-limited');
  const refused = b.parse(lines({ type: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/p/a' }, error: { code: 'PERMISSION_DENIED' } } } }));
  assert.equal(refused.edits.length, 0);
  assert.equal(refused.usage.denied, 1);
});

test('antigravity: what the task names outside the workspace is readable, minus its secrets; the project\'s paths point at the copy', () => {
  const b = getBackend('antigravity');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-src-'));
  fs.mkdirSync(path.join(outside, 'lib'));
  fs.writeFileSync(path.join(outside, 'lib', 'a.ts'), 'x');
  fs.writeFileSync(path.join(outside, '.env'), 'SECRET=x');
  // secrets deeper than any walk limit, and in folders other scans skip
  fs.mkdirSync(path.join(outside, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'a', 'b', 'c', 'd', 'e', '.env.local'), 'x');
  fs.mkdirSync(path.join(outside, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'node_modules', 'pkg', 'server.key'), 'x');
  const settingsFor = (prompt, over = {}) => {
    const inv = b.invocation(request({ cwd: workspace, prompt, ...over }));
    return { inv, s: JSON.parse(fs.readFileSync(path.join(inv.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) };
  };
  const asAgy = (p) => fs.realpathSync(p).replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/');
  if (process.platform === 'win32') {
    // agy compares Windows paths without the drive letter: a grant would open the same path on every drive
    assert.ok(!settingsFor(`PROMPT-SENTINEL read ${outside}`).s.permissions.allow.some((r) => r.includes('agy-src-')));
    return;
  }
  const { s } = settingsFor(`PROMPT-SENTINEL copy the components from ${outside}/lib, and also "${path.join(outside, 'lib', 'a.ts')}".`);
  assert.ok(s.permissions.allow.includes(`read_file(${asAgy(path.join(outside, 'lib'))})`), s.permissions.allow.join('\n'));
  assert.ok(s.permissions.allow.includes(`read_file(${asAgy(path.join(outside, 'lib', 'a.ts'))})`));
  assert.ok(!s.permissions.allow.some((r) => r.startsWith('write_file(') && r.includes('agy-src-')), 'read-only');
  // too wide, missing, a secret, the user's home, or a folder holding the workspace: never granted
  const wide = settingsFor(`PROMPT-SENTINEL look in / and ${os.homedir()} and ${path.dirname(workspace)} and /no/such/dir and ${path.join(outside, '.env')}`).s;
  const bad = [asAgy(os.homedir()), asAgy(path.dirname(workspace))].map((p) => `read_file(${p})`);
  assert.deepEqual(wide.permissions.allow.filter((r) => r.includes('agy-src-') || r === 'read_file(/)' || bad.includes(r)), []);
  // the secrets of a granted folder stay denied
  const granted = settingsFor(`PROMPT-SENTINEL read ${outside}`).s;
  assert.ok(granted.permissions.allow.includes(`read_file(${asAgy(outside)})`));
  for (const f of ['.env', 'a/b/c/d/e/.env.local', 'node_modules/pkg/server.key']) {
    assert.ok(granted.permissions.deny.includes(`read_file(${asAgy(path.join(outside, f))})`), f);
  }
  // a folder with a link out of it is not granted, whatever the link is called; one to a secret is named for it
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-linked-'));
  fs.writeFileSync(path.join(linked, 'a.ts'), 'x');
  fs.symlinkSync(path.join(outside, '.env'), path.join(linked, 'notes.txt'));
  assert.ok(!settingsFor(`PROMPT-SENTINEL read ${linked}`).s.permissions.allow.some((r) => r.includes('agy-linked-')));
  assert.ok(!settingsFor(`PROMPT-SENTINEL read ${path.join(linked, 'notes.txt')}`).s.permissions.allow.some((r) => r.includes('.env')), 'a link to a secret is the secret');
  // a link that leads nowhere cannot be checked either
  const dangling = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dangling-'));
  fs.symlinkSync(path.join(dangling, 'missing'), path.join(dangling, 'later'));
  assert.ok(!settingsFor(`PROMPT-SENTINEL read ${dangling}`).s.permissions.allow.some((r) => r.includes('agy-dangling-')));
  // macOS file names ignore case: ~/LIBRARY is ~/Library, and is compared as such
  if (process.platform === 'darwin' && fs.existsSync(path.join(os.homedir(), 'Library', 'Preferences'))) {
    const upper = settingsFor(`PROMPT-SENTINEL read ${path.join(os.homedir(), 'LIBRARY', 'Preferences')}`).s;
    assert.ok(!upper.permissions.allow.some((r) => /library[\\/]preferences/i.test(r)), upper.permissions.allow.join('\n'));
  }
  // in a snapshot or an isolated copy, the project's paths are the copy's; a longer name is another folder
  const { inv } = settingsFor('PROMPT-SENTINEL fix /work/proj/src/a.ts, not /work/proj-old/b.ts; see /work/proj.', { project: { root: '/work/proj', copy: '/state/copy' } });
  const prompt = inv.args[inv.args.indexOf('-p') + 1];
  assert.match(prompt, /fix \/state\/copy\/src\/a\.ts, not \/work\/proj-old\/b\.ts; see \/state\/copy\./);
});

test('antigravity: agy 1.3.5\'s stream: a refused call ends in state ERROR, an unanswered turn is a failure, a cut-short run counts its steps\' tokens', () => {
  const b = getBackend('antigravity');
  const fixture = (f) => fs.readFileSync(path.join(FIXTURES, 'antigravity', f), 'utf8');
  // a command refused by a deny rule: the step ends in ERROR, the edit is not counted, the answer says so
  const denied = b.parse(fixture('events/denied-command.jsonl'));
  assert.equal(denied.timeline.find((s) => s.kind === 'shell')?.ok, false);
  assert.match(denied.finalText, /git commit/);
  // a command refused for want of a grant ends the turn without an answer: agy says SUCCESS and exits 0
  const discarded = b.parse(fixture('failures/turn-discarded.stdout.jsonl'));
  assert.equal(discarded.finalText, '');
  assert.equal(discarded.usage.denied, 1, 'result.denied_actions');
  // killed before its result: the session and the finished steps' tokens are still known
  const cut = b.parse(fixture('failures/cut-short.stdout.jsonl'));
  assert.ok(cut.sessionId && cut.usage.total > 0, JSON.stringify(cut.usage));
  assert.equal(cut.model, 'gemini-3.8-flash-medium', 'init.model');
  // an unknown conversation id: agy starts a new one and says so only on stderr
  assert.match(b.warnings(denied, 'warning: conversation "SES-1" not found\n').join(''), /did not find the earlier conversation \(SES-1\)/);
  assert.deepEqual(b.warnings(denied, ''), []);
});

test('deny list: one list for every worker; Gemini\'s rule file and OpenCode\'s profiles name every other agent too', () => {
  const toml = fs.readFileSync(path.join(FIXTURES, '..', '..', 'policies', 'gemini', 'shell.toml'), 'utf8');
  const prefixes = [...toml.split('commandPrefix = [')[1].split(']')[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(prefixes, FORBIDDEN_COMMANDS);
  const claude = getBackend('claude').invocation(request({ mode: 'write' })).args;
  const qwen = getBackend('qwen').invocation(request({ mode: 'write' })).args;
  for (const c of FORBIDDEN_COMMANDS) {
    assert.ok(claude.includes(`Bash(${c}:*)`), `claude: ${c}`);
    assert.ok(qwen.includes(`run_shell_command(${c})`), `qwen: ${c}`);
  }
  const bash = JSON.parse(getBackend('opencode').invocation(request({ mode: 'write' })).env.OPENCODE_CONFIG_CONTENT).agent['pitroom-write'].permission.bash;
  for (const agent of ['opencode', 'kilo', 'kilocode', 'agy', 'pitroom']) assert.ok(Object.keys(bash).some((k) => k.startsWith(agent) && bash[k] === 'deny'), `opencode: ${agent}`);
});

test('private homes: settings are replaced whole, a dangling sign-in link is repaired, a file the CLI wrote is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-home-'));
  const file = path.join(dir, 'h', 'settings.json');
  writeIfChanged(file, 'one\n');
  writeIfChanged(file, 'two\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temporary file left behind');
  const user = path.join(dir, 'user');
  fs.mkdirSync(user);
  const token = path.join(user, 'token');
  fs.symlinkSync(path.join(dir, 'gone', 'token'), path.join(dir, 'h', 'token')); // dangling, from a moved folder
  fs.writeFileSync(token, 'T\n');
  linkInto(path.join(dir, 'h'), token);
  assert.equal(fs.readlinkSync(path.join(dir, 'h', 'token')), token);
  assert.equal(fs.readFileSync(path.join(dir, 'h', 'token'), 'utf8'), 'T\n');
  fs.rmSync(path.join(dir, 'h', 'token'));
  fs.writeFileSync(path.join(dir, 'h', 'token'), 'refreshed by the CLI\n');
  linkInto(path.join(dir, 'h'), token);
  assert.equal(fs.readFileSync(path.join(dir, 'h', 'token'), 'utf8'), 'refreshed by the CLI\n');
});
