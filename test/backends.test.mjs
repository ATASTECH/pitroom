// Adapter contract: every registered worker backend must pass these, using
// event streams recorded from its real CLI in test/fixtures/<id>/.
// Adding a backend = implement it, record fixtures, and this suite covers it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allBackends, getBackend, parseTarget } from '../dist/lib.mjs';

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
    assert.ok(['permission-rules', 'os-sandbox', 'tool-allowlist', 'approval-mode'].includes(b.capabilities.readOnly));
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
      if (b.capabilities.reportsCost) assert.equal(typeof run.usage.cost, 'number');
      assert.equal(b.failure(run, '', 0), undefined, 'a clean run is not a failure');
      // Streams are read while still being written: a torn last line must not throw.
      assert.doesNotThrow(() => b.parse(raw.slice(0, Math.floor(raw.length / 2))));
    });
  }

  for (const [name, want] of Object.entries(expected.failures)) {
    test(`${b.id}: classifies recorded failure ${name}`, () => {
      const stdout = fs.readFileSync(path.join(dir, 'failures', `${name}.stdout.jsonl`), 'utf8');
      const stderr = fs.readFileSync(path.join(dir, 'failures', `${name}.stderr.log`), 'utf8');
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

test('targets: planned workers are recognised with a clear message', () => {
  assert.deepEqual(parseTarget('gemini:gemini-3-flash', 'opencode'), { backend: 'gemini', model: 'gemini-3-flash' });
  assert.throws(() => getBackend('gemini'), /"gemini" worker is not supported yet/);
  assert.throws(() => getBackend('nope'), /unknown worker "nope"/);
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
