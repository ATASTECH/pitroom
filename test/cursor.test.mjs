// The Cursor CLI worker: how it is started (its own mechanisms, in a home of its own), and end to end with a fake
// cursor-agent: a read in a snapshot of its own, an isolated edit, a follow-up in the same chat, a failure classified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

process.env.PITROOM_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-cursor-'));
const { getBackend } = await import('../dist/lib.mjs');

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor', 'mock', 'cursor-agent.mjs');
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const request = (over = {}) => ({ mode: 'read', prompt: 'PROMPT', cwd: '/tmp/project', files: [], web: false, title: 't', ...over });
const config = (inv) => JSON.parse(fs.readFileSync(path.join(inv.env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8'));

test('cursor: a read is ask mode in its sandbox; a change runs commands but the forbidden ones; both in a home of their own', () => {
  const b = getBackend('cursor');
  const read = b.invocation(request());
  assert.deepEqual(read.args.slice(-13), ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--disable-auto-update', '--workspace', '/tmp/project', '--mode', 'ask', '--', 'PROMPT']);
  assert.ok(!read.args.some((a) => /^--(force|yolo|approve-mcps|continue)$/.test(a)));
  assert.equal(read.env.CURSOR_CONFIG_DIR, path.join(read.env.HOME, '.cursor'));
  assert.ok(read.env.HOME.startsWith(path.join(process.env.PITROOM_HOME, 'cursor-home')));
  const rc = config(read);
  assert.deepEqual(rc.permissions.allow, []);
  for (const rule of ['Shell(git commit)', 'Shell(git push)', 'Shell(rm -rf)', 'Shell(cursor-agent)', 'Read(**/.env)', 'Write(**/.env)', 'WebFetch(*)']) assert.ok(rc.permissions.deny.includes(rule), rule);
  assert.deepEqual(rc.sandbox, { mode: 'enabled', networkAccess: 'user_config_only', networkAllowlist: [] });
  // the user's own credential folders, by absolute path: a read's tools may read outside the project, never these
  for (const d of ['.ssh', '.aws', '.config/gh', '.cursor', '.claude']) assert.ok(rc.permissions.deny.includes(`Read(${path.join(os.homedir(), d)}/**)`), d);
  assert.ok(rc.permissions.deny.includes('Shell(agent)'), "cursor-agent's other name");
  // the sign-in linked into the worker's home, and no hooks planted for later runs
  for (const d of ['Library/Keychains', '.config/cursor', '.cursor']) assert.ok(rc.permissions.deny.includes(`Read(${path.join(read.env.HOME, d)}/**)`), d);
  for (const rule of ['Write(**/.cursor/**)', 'Write(**/.claude/**)']) assert.ok(rc.permissions.deny.includes(rule), rule);
  assert.equal(rc.attribution.attributeCommitsToAgent, false);
  if (process.platform === 'darwin') assert.equal(fs.readlinkSync(path.join(read.env.HOME, 'Library', 'Keychains')), path.join(os.homedir(), 'Library', 'Keychains'));

  const change = b.invocation(request({ mode: 'isolate', web: true, model: 'claude-opus-5-5#high', sessionId: 'chat-9', cwd: '/tmp/other' }));
  assert.ok(!change.args.includes('--mode'));
  assert.deepEqual(change.args.slice(change.args.indexOf('--model'), change.args.indexOf('--model') + 4), ['--model', 'claude-opus-5-5-high', '--resume', 'chat-9']);
  assert.notEqual(change.env.HOME, read.env.HOME, 'a home per project and kind of run');
  const cc = config(change);
  assert.deepEqual(cc.permissions.allow, ['Shell(*)']);
  assert.ok(!cc.permissions.deny.includes('WebFetch(*)'), '--web');
  assert.equal(cc.sandbox.networkAccess, 'allow_all');
  // a run of the same kind in the same project (a follow-up, another isolated copy) finds the same home
  const again = b.invocation(request({ mode: 'isolate', web: true, cwd: '/tmp/copy-2', project: { root: '/tmp/other', copy: '/tmp/copy-2' } }));
  assert.equal(again.env.HOME, change.env.HOME);
  // every read run reads a snapshot of its own: they share one home per project, not one each
  const snapA = b.invocation(request({ cwd: '/snap/a', project: { root: '/tmp/proj', copy: '/snap/a' } }));
  const snapB = b.invocation(request({ cwd: '/snap/b', project: { root: '/tmp/proj', copy: '/snap/b' } }));
  assert.equal(snapA.env.HOME, snapB.env.HOME);
  // a read and a change in the same project do not share one: their settings differ
  assert.notEqual(b.invocation(request({ mode: 'write', cwd: '/tmp/proj' })).env.HOME, snapA.env.HOME);
  assert.deepEqual(config(snapA).permissions.allow, []);
});

test('cursor: a read reads a snapshot of its own; an isolated edit stays in its copy; a follow-up resumes the chat in the same home', () => {
  const s = sandbox();
  const env = { PITROOM_CURSOR_BIN: MOCK, MOCK_ANSWER: 'SUMMARY: app.txt holds line1' };
  const r = s.run(['run', '-W', 'cursor', 'what is in app.txt?'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SUMMARY: app\.txt holds line1/);
  assert.match(r.stdout, /Cursor CLI reads a snapshot of your project of its own/);
  const [readCall] = s.calls();
  const workspace = readCall.argv[readCall.argv.indexOf('--workspace') + 1];
  assert.notEqual(fs.realpathSync(workspace), fs.realpathSync(s.repo), 'never the project itself');
  assert.ok(readCall.argv.includes('ask'));

  const follow = s.run(['run', '--continue', RUN_ID.exec(r.stdout)[0], 'and other.txt?'], env);
  assert.equal(follow.status, 0, follow.stdout + follow.stderr);
  const followCall = s.calls()[1];
  assert.equal(followCall.argv[followCall.argv.indexOf('--resume') + 1], 'chat-mock-1');
  assert.equal(followCall.configDir, readCall.configDir, 'the chat lives in the same home');

  const edit = s.run(['run', '-i', '-W', 'cursor', 'change app.txt'], { ...env, MOCK_WRITE: 'app.txt:changed by cursor' });
  assert.equal(edit.status, 0, edit.stdout + edit.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', RUN_ID.exec(edit.stdout)[0], 'meta.json'), 'utf8'));
  assert.deepEqual(m.changes.map((c) => c.path), ['app.txt']);
  assert.equal(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), 'line1\n', 'nothing reaches the tree until apply');
  assert.deepEqual(s.calls()[2].config.permissions.allow, ['Shell(*)']);
});

test('cursor: an unknown model falls back to the next worker; a missing sign-in says what to run', () => {
  const s = sandbox();
  s.config({ worker: 'cursor:no-such-model', fallback: ['opencode:mock/good-model'] });
  const r = s.run(['run', 'what is in app.txt?'], {
    PITROOM_CURSOR_BIN: MOCK,
    MOCK_FAIL: 'Cannot use this model: no-such-model. Available models: auto, composer-2.5',
    MOCK_ACTIONS: 'answer:SUMMARY: from opencode',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SUMMARY: from opencode/);
  assert.match(r.stdout, /Cannot use this model: no-such-model\./);
  assert.doesNotMatch(r.stdout, /composer-2\.5/, 'the list of every model is cut');

  const signIn = s.run(['run', '--no-fallback', '-W', 'cursor', 'q'], { PITROOM_CURSOR_BIN: MOCK, MOCK_FAIL: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable." });
  assert.equal(signIn.status, 1);
  assert.match(signIn.stdout, /Authentication required/);
});
