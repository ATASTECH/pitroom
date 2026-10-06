// `pitroom doctor`: the checks no other test asserts yet (setup lines, config
// warnings, the git guard, audits, an unknown worker, skills and the launcher,
// exit status, the live probe). Doctor runs against a fake home so it never
// reads the real machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { posixOnly, sandbox } from './helpers.mjs';

/** A home with nothing installed, and the env that makes doctor look there. */
function fakeHome(s, name = 'home') {
  const dir = path.join(s.base, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    CODEX_HOME: path.join(dir, '.codex'),
  };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('doctor setup: version line, git, and the config path with and without a file', () => {
  for (const c of [
    { name: 'no config file', config: undefined, suffix: ' \\(not present, defaults in use\\)' },
    { name: 'config file present', config: {}, suffix: '' },
  ]) {
    const s = sandbox();
    if (c.config !== undefined) s.config(c.config);
    const out = s.run(['doctor'], fakeHome(s)).stdout;
    assert.match(out, new RegExp(`✔ pitroom \\d+\\.\\d+\\.\\d+ · node \\S+ · state in ${esc(s.env.PITROOM_HOME)}`), `${c.name}: setup line`);
    assert.match(out, /✔ git available/, c.name);
    assert.match(out, new RegExp(`✔ config: ${esc(s.env.PITROOM_CONFIG)}${c.suffix}$`, 'm'), `${c.name}: config path`);
  }
});

test('doctor echoes config warnings as warnings', () => {
  for (const [config, warning] of [
    [{ maxParallel: 'lots' }, '"maxParallel" must be number; ignored'],
    [{ timeout: 5 }, '"timeout" must be string; ignored'],
  ]) {
    const s = sandbox();
    s.config(config);
    const out = s.run(['doctor'], fakeHome(s)).stdout;
    assert.match(out, new RegExp(`! [^\\n]*${esc(warning)}`), JSON.stringify(config));
  }
});

test('doctor git guard shim is ready', () => {
  const s = sandbox();
  assert.match(s.run(['doctor'], fakeHome(s)).stdout, /✔ git guard shim ready/);
});

test('doctor audit: re-check share with two workers, warning with one', () => {
  for (const [config, want] of [
    [{ audit: 0.1, fallback: ['opencode:mock/other'] }, /✔ audit: 10% of read runs are re-checked by opencode:mock\/other/],
    [{ audit: 0.1 }, /! audit is on \(10%\) but no other worker could do it/],
  ]) {
    const s = sandbox();
    s.config(config);
    assert.match(s.run(['doctor'], fakeHome(s)).stdout, want, JSON.stringify(config));
  }
});

test('an unknown backend in the config worker is a failure (exit 1)', () => {
  const s = sandbox();
  s.config({ worker: 'nosuch-backend-xyz' });
  const r = s.run(['doctor'], fakeHome(s));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /✘ OpenCode model "nosuch-backend-xyz" is not in `opencode models`/);
});

test('doctor exits 0 with only warnings, 1 with any failure', () => {
  const s = sandbox();
  const home = fakeHome(s);
  const ok = s.run(['doctor'], home);
  assert.match(ok.stdout, /! no fallback workers/, 'warnings but no failure here');
  assert.match(ok.stdout, /✘ 0 problems/);
  assert.equal(ok.status, 0, ok.stdout);
  const bad = s.run(['doctor'], { ...home, MOCK_DEFAULT_MODEL: 'gone/model' });
  assert.match(bad.stdout, /✘ [1-9]\d* problems?/);
  assert.equal(bad.status, 1, bad.stdout);
});

test('doctor skills: missing skills point at install; installed skills check out', () => {
  const s = sandbox();
  const home = fakeHome(s);
  const missing = s.run(['doctor'], home).stdout;
  assert.match(missing, /! no Pitroom skills in .*; run `pitroom install`/);
  assert.match(missing, /pitroom install\s+link the skills and the pitroom command/);
  assert.equal(s.run(['install'], home).status, 0);
  const out = s.run(['doctor'], home).stdout;
  assert.match(out, /✔ skills in .*using-pitroom/);
  assert.doesNotMatch(out, /no Pitroom skills/);
  assert.doesNotMatch(out, /link the skills/);
  if (process.platform !== 'win32') assert.match(out, /✔ launcher .* → pitroom \d+\.\d+\.\d+/);
});

test('doctor --probe runs a live round trip through the mock worker', () => {
  const s = sandbox();
  const r = s.run(['doctor', '--probe'], { ...fakeHome(s), MOCK_ACTIONS: 'answer:PONG' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Live probe$/m);
  assert.match(r.stdout, /✔ live probe \(opencode \(default model\)\) answered in \d+\.\d+s/);
});
