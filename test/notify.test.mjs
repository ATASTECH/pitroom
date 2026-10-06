// A desktop notification when a background run has ended (config `notify`). The tests use `notifyCommand`, a command of
// the user's own, which writes what it was given to a file: the built-in notifiers (osascript, notify-send) need a desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { posixOnly, sandbox } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = /run (\d{8}-\d{6}-[0-9a-f]{4}) in background/;

function setup(extra = {}) {
  const s = sandbox();
  const log = path.join(s.base, 'notices.log');
  const env = {
    PITROOM_NOTIFY: '1',
    PITROOM_NOTIFY_AFTER: '0',
    PITROOM_NOTIFY_COMMAND: `printf '%s|%s|%s\\n' "$PITROOM_NOTIFY_TITLE" "$PITROOM_NOTIFY_BODY" "$PITROOM_NOTIFY_STATE" >> '${log}'`,
    ...extra,
  };
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  /** Waits until n notices are there (the notifier is a detached process: it lands a moment after the run). */
  const notices = async (n) => {
    for (let i = 0; i < 100 && lines().length < n; i++) await sleep(100);
    return lines();
  };
  return { s, env, lines, notices, log };
}

test('notify: a background run that ended says so, once, with its state and task', { skip: posixOnly }, async () => {
  const { s, env, notices } = setup();
  const r = s.run(['run', '--bg', 'where is app.txt?'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = RUN.exec(r.stdout)[1];
  assert.equal(s.run(['wait', id, '--timeout', '30'], env).status, 0);
  const got = await notices(1);
  assert.equal(got.length, 1);
  const [title, body, state] = got[0].split('|');
  assert.match(title, /^Pitroom ✔ research done$/);
  assert.match(body, /where is app\.txt\?/);
  assert.match(body, /\d+s/, 'with the time it took');
  assert.equal(state, 'done');
  await sleep(600);
  assert.equal((await notices(1)).length, 1, 'not announced twice');
});

test('notify: off by default; a foreground run, a short one and an audit are not announced', { skip: posixOnly }, async () => {
  // off (the config default): nothing, though a command is set
  const off = setup({ PITROOM_NOTIFY: '0' });
  const a = off.s.run(['run', '--bg', 'q1'], off.env);
  assert.equal(off.s.run(['wait', RUN.exec(a.stdout)[1], '--timeout', '30'], off.env).status, 0);
  // on, but the user was waiting at the terminal
  const fg = setup();
  assert.equal(fg.s.run(['run', 'q2'], fg.env).status, 0);
  // on, background, but quicker than notifyAfter
  const quick = setup({ PITROOM_NOTIFY_AFTER: '600' });
  const b = quick.s.run(['run', '--bg', 'q3'], quick.env);
  assert.equal(quick.s.run(['wait', RUN.exec(b.stdout)[1], '--timeout', '30'], quick.env).status, 0);
  await sleep(1200);
  assert.deepEqual([off.lines(), fg.lines(), quick.lines()], [[], [], []]);
});

test('notify: a quick run that failed is announced all the same; a crew is judged as a whole', { skip: posixOnly }, async () => {
  // quicker than notifyAfter, but it failed: worth knowing
  const bad = setup({ PITROOM_NOTIFY_AFTER: '600', MOCK_ACTIONS: 'fail:boom' });
  const r = bad.s.run(['run', '--bg', '--no-fallback', 'fails fast'], bad.env);
  bad.s.run(['wait', RUN.exec(r.stdout)[1], '--timeout', '30'], bad.env);
  assert.match((await bad.notices(1))[0], /^Pitroom ✘ research failed\|/);
  // a crew that all went well but quickly: not announced; the same crew with a failure in it: announced with the breakdown
  const ok = setup({ PITROOM_NOTIFY_AFTER: '600', MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  ok.s.run(['crew', '-g', 'quick', 'a task', 'b task'], ok.env);
  assert.equal(ok.s.run(['wait', '-g', 'quick', '--timeout', '60'], ok.env).status, 0);
  await sleep(1200);
  assert.deepEqual(ok.lines(), [], 'quick and well: nothing');
  const mixed = setup({ PITROOM_NOTIFY_AFTER: '600', MOCK_ACTIONS: 'fail:boom' });
  mixed.s.run(['crew', '-g', 'bad', '--no-fallback', 'a task', 'b task'], mixed.env);
  mixed.s.run(['wait', '-g', 'bad', '--timeout', '60'], mixed.env);
  const got = await mixed.notices(1);
  assert.match(got[0], /^Pitroom ⚠ group bad\|2 runs ended: 0 done, 2 failed\|/);
});

test('notify: a failed run is announced as failed', { skip: posixOnly }, async () => {
  const { s, env, notices } = setup({ MOCK_ACTIONS: 'fail:boom' });
  const r = s.run(['run', '--bg', '--no-fallback', 'will fail'], env);
  s.run(['wait', RUN.exec(r.stdout)[1], '--timeout', '30'], env);
  const [title, , state] = (await notices(1))[0].split('|');
  assert.match(title, /^Pitroom ✘ research failed$/);
  assert.equal(state, 'failed');
});

test('notify: a crew says so once, when its last run ends', { skip: posixOnly }, async () => {
  const { s, env, notices } = setup({ MOCK_ACTIONS: 'sleep:1;answer:SUMMARY: ok' });
  const r = s.run(['crew', '-g', 'trio', 'first task', 'second task', 'third task'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.run(['wait', '-g', 'trio', '--timeout', '60'], env).status, 0);
  const got = await notices(1);
  await sleep(1200);
  const all = await notices(1);
  assert.equal(all.length, 1, `one notice for three runs: ${JSON.stringify(all)}`);
  assert.match(all[0], /^Pitroom ✔ group trio\|3 runs ended: 3 done\|/);
  assert.equal(got.length, 1);
});

test('notify: the text reaches the command through the environment only, never as part of its command line', { skip: posixOnly }, async () => {
  const { s, env, notices } = setup();
  const planted = path.join(s.base, 'pwned');
  const r = s.run(['run', '--bg', `x"; touch '${planted}'; echo "`], env);
  s.run(['wait', RUN.exec(r.stdout)[1], '--timeout', '30'], env);
  const got = await notices(1);
  assert.equal(got.length, 1);
  assert.ok(got[0].includes('touch'), 'the text is in the notice, as text');
  await sleep(500);
  assert.ok(!fs.existsSync(planted), 'and was not run');
});

test('notify: the built-in notifier gets the text as separate arguments (notify-send after `--`, markup escaped)', { skip: !['darwin', 'linux'].includes(process.platform) && 'built-in notifiers: macOS and Linux' }, async () => {
  const { s, env, log } = setup();
  const dir = path.join(s.base, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  const tool = process.platform === 'darwin' ? 'osascript' : 'notify-send';
  // a stand-in for the system's notifier: one line per argument it received
  fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nfor a in "$@"; do printf '[%s]\\n' "$a" | head -1; done >> '${log}'\n`, { mode: 0o755 });
  const task = '--help <b>bold</b> & more';
  const r = s.run(['run', '--bg', '--', task], { // after `--`: the CLI too would take --help for an option
     ...env, PITROOM_NOTIFY_COMMAND: '', PATH: `${dir}${path.delimiter}${s.env.PATH}` });
  assert.equal(s.run(['wait', RUN.exec(r.stdout)[1], '--timeout', '30'], env).status, 0);
  let lines = [];
  for (let i = 0; i < 100 && lines.length < 3; i++) {
    lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    await sleep(100);
  }
  if (process.platform === 'linux') {
    assert.equal(lines[0], '[--]', 'a task text that looks like an option is not one');
    assert.equal(lines[1], '[Pitroom ✔ research done]');
    assert.match(lines[2], /--help &lt;b&gt;bold&lt;\/b&gt; &amp; more/, 'markup is escaped');
  } else {
    assert.equal(lines[0], '[-e]');
    assert.match(lines[1], /^\[on run argv/);
    assert.equal(lines.at(-2), '[Pitroom ✔ research done]');
    assert.match(lines.at(-1), /--help <b>bold<\/b> & more/, 'osascript gets the text as an argument, not inside its script');
  }
});
