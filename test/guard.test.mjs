import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, scratchDir } from './helpers.mjs';
import { guardEnv, scoopTarget } from '../dist/lib.mjs';

// The runner may itself run under a worker guard (layer-2 GIT_CONFIG_* env plus
// a shim dir first on PATH), which would block sandbox()'s own git setup and
// make findRealGit resolve to another shim. Strip those so the sandbox and
// guardEnv start from the real git (no-ops in a clean environment).
for (const k of Object.keys(process.env)) {
  if (k === 'GIT_CONFIG_COUNT' || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) delete process.env[k];
}
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !d.includes(`pitroom${path.sep}shim`) && !d.includes('pitroom/shim')).join(path.delimiter);
}

// Plain `git` resolves to git.exe on Windows (CreateProcess ignores .cmd); a shell finds the shim's git.cmd first, as a worker's shell would.
const gitIn = (args, opts) => spawnSync('git', args, { ...opts, shell: process.platform === 'win32' });

function setup() {
  const s = sandbox();
  process.env.PITROOM_HOME = path.join(s.base, 'home');
  const env = guardEnv({ ...process.env, ...s.env });
  const run = (args, extra = {}) =>
    gitIn(args, { cwd: s.repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const snap = () =>
    [s.git('rev-parse', 'HEAD'), s.git('branch', '--list'), s.git('config', '--list'),
      fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8')].join('\n');
  const blocked = (args) => {
    const before = snap();
    const r = run(args);
    assert.equal(r.status, 1, `${args.join(' ')} should exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /blocked for workers/, args.join(' '));
    assert.equal(snap(), before, `${args.join(' ')} must not change the repo`);
  };
  const allowed = (args) => {
    const r = run(args);
    assert.equal(r.status, 0, `${args.join(' ')} should pass, got ${r.status}: ${r.stderr}`);
  };
  return { s, env, run, blocked, allowed };
}

test('unconditional blocks', () => {
  const { blocked } = setup();
  for (const a of [
    ['pull'], ['merge'], ['rebase'], ['switch'], ['cherry-pick'], ['revert'], ['am'],
    ['worktree', 'list'], ['update-ref', '-d', 'refs/heads/nope'], ['update-index', '--refresh'],
    ['clean', '-n'], ['restore', 'other.txt'], ['rm', 'other.txt'], ['mv', 'a', 'b'],
    ['gc'], ['prune'], ['notes', 'list'], ['read-tree', 'HEAD'],
    ['commit-tree', 'HEAD'], ['write-tree'], ['bisect', 'start'],
  ]) blocked(a);
});

test('branch and tag rules', () => {
  const { blocked, allowed } = setup();
  for (const a of [
    ['branch', '-m', 'x'], ['branch', '-M', 'x'], ['branch', '-c', 'x'],
    ['branch', '-f', 'x'], ['branch', '--set-upstream-to', 'o/m'], ['branch', 'newname'],
  ]) blocked(a);
  for (const a of [['branch', '-a'], ['branch', '-l'], ['branch', '--contains', 'HEAD']]) allowed(a);
  for (const a of [['tag', 'v1'], ['tag', '-d', 'v1'], ['tag', '-f', 'v1'], ['tag', '-a', 'v1', '-m', 'x']]) blocked(a);
  allowed(['tag', '-l']);
});

test('config, remote and fetch rules', () => {
  const { s, run, blocked, allowed } = setup();
  for (const a of [
    ['config', 'user.name', 'x'], ['config', '--unset', 'user.name'], ['config', '--add', 'a.b', 'c'],
  ]) blocked(a);
  allowed(['config', 'user.name']);
  for (const a of [
    ['remote', 'add', 'o', 'u'], ['remote', 'remove', 'o'], ['remote', 'rename', 'a', 'b'],
    ['remote', 'set-url', 'origin', 'u'],
  ]) blocked(a);
  allowed(['remote', '-v']);
  blocked(['fetch', 'origin', 'a:b']);
  const r = run(['fetch']);
  assert.doesNotMatch(r.stderr, /blocked for workers/, 'plain fetch passes the shim');
});

test('apply, reflog, symbolic-ref and submodule rules', () => {
  const { blocked, allowed } = setup();
  for (const a of [
    ['apply', '--index', 'p.patch'], ['apply', '--cached', 'p.patch'], ['apply', '--3way', 'p.patch'],
    ['reflog', 'expire', '--all'], ['reflog', 'delete', 'HEAD@{0}'],
    ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['symbolic-ref', '--delete', 'X'],
    ['submodule', 'update'], ['submodule', 'add', 'u'],
  ]) blocked(a);
  allowed(['symbolic-ref', 'HEAD']);
  for (const a of [['submodule', 'status'], ['submodule', 'summary']]) allowed(a);
});

test('aliases are resolved or refused', () => {
  const { s, run, blocked } = setup();
  s.git('config', 'alias.ci', 'commit');
  s.git('config', 'alias.sneaky', '!sh -c true');
  s.git('config', 'alias.a', 'b');
  s.git('config', 'alias.b', 'a');
  const before = s.git('rev-parse', 'HEAD');
  for (const a of [['ci'], ['sneaky'], ['a'], ['-c', 'alias.x=status', 'x']]) {
    const r = run(a);
    assert.equal(r.status, 1, `${a.join(' ')} should exit 1: ${r.stderr}`);
    assert.match(r.stderr, /blocked for workers/, a.join(' '));
  }
  assert.equal(s.git('rev-parse', 'HEAD'), before);
  void blocked;
});

test('global options do not hide blocked commands; reads pass', () => {
  const { blocked, allowed } = setup();
  for (const a of [
    ['-C', '.', 'reset', '--hard'], ['--git-dir=.git', 'reset', '--hard'],
    ['-c', 'user.name=t', 'push'],
  ]) blocked(a);
  for (const a of [
    ['status', '--short'], ['log', '--oneline', '-1'], ['branch', '-a'],
    ['tag', '-l'], ['config', 'user.name'], ['remote', '-v'], ['symbolic-ref', 'HEAD'],
  ]) allowed(a);
});

test('shim exits 127 without a usable real git', () => {
  const { s, env } = setup();
  for (const real of ['', '/nonexistent/pitroom-git']) {
    const r = gitIn(['status'], {
      cwd: s.repo, env: { ...env, PITROOM_REAL_GIT: real }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 127, `PITROOM_REAL_GIT=${real} should exit 127: ${r.stderr}`);
    assert.match(r.stderr, /cannot find the real git/);
  }
});

test('guardEnv keeps git from waiting for a person, on every platform: no prompt, editor, sequence editor or pager', () => {
  const env = guardEnv({});
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_EDITOR, 'true');
  assert.equal(env.GIT_SEQUENCE_EDITOR, 'true');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
});

test('layer 2 alone: with the shim bypassed (the real git by absolute path), ref updates and pushes are still refused', () => {
  const { s } = setup();
  const env = guardEnv({ ...process.env, ...s.env });
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  // Take the shim directory off PATH: what is left is git's own env config, which is all that login shells and absolute paths leave.
  env[key] = env[key].split(path.delimiter).filter((d) => !d.includes(`${path.sep}shim${path.sep}`)).join(path.delimiter);
  const remote = path.join(s.base, 'remote.git');
  s.git('init', '-q', '--bare', remote);
  s.git('remote', 'add', 'origin', remote);
  const before = s.git('rev-parse', 'HEAD');
  for (const args of [['commit', '--allow-empty', '-m', 'x'], ['branch', 'sneaky'], ['tag', 'v-sneaky'], ['push', 'origin', 'HEAD']]) {
    const r = spawnSync('git', args, { cwd: s.repo, env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(r.status, 0, `${args.join(' ')} must fail: ${r.stdout}`);
    assert.match(r.stderr, args[0] === 'push' ? /pitroom-push-blocked/ : /blocked for workers/, args.join(' '));
  }
  assert.equal(s.git('rev-parse', 'HEAD'), before);
  assert.equal(s.git('branch', '--list', 'sneaky'), '');
  assert.equal(s.git('tag', '--list'), '');
  assert.equal(fs.readdirSync(path.join(remote, 'refs', 'heads')).length, 0, 'nothing reached the remote');
});

test('a Scoop shim is followed to the git it runs: its git.shim names it', () => {
  const dir = scratchDir('pitroom-scoop-');
  const real = path.join(dir, 'apps', 'git', 'current', 'cmd', 'git.exe');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  const shim = path.join(dir, 'shims', 'git.exe');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '');
  assert.equal(scoopTarget(shim), undefined, 'no git.shim: not a Scoop shim');
  fs.writeFileSync(path.join(dir, 'shims', 'git.shim'), `path = "${real}"\r\n`);
  assert.equal(scoopTarget(shim), real);
  fs.writeFileSync(path.join(dir, 'shims', 'git.shim'), `path = ${real}\nargs = --foo\n`);
  assert.equal(scoopTarget(shim), real, 'unquoted, with an args line');
  fs.writeFileSync(path.join(dir, 'shims', 'git.shim'), `path = "${path.join(dir, 'gone.exe')}"\n`);
  assert.equal(scoopTarget(shim), undefined, 'a path that does not exist');
});

const windowsOnly = process.platform === 'win32' ? false : 'Windows only (git.cmd, Scoop)';

test('Windows: behind a Scoop shim the shim is still put first, with the real git and its sh.exe', { skip: windowsOnly }, () => {
  const real = spawnSync('where', ['git.exe'], { encoding: 'utf8' }).stdout.split(/\r?\n/).find((l) => l.trim());
  assert.ok(real, 'git.exe on PATH');
  const dir = scratchDir('pitroom-scoop-');
  fs.mkdirSync(path.join(dir, 'shims'));
  fs.writeFileSync(path.join(dir, 'shims', 'git.exe'), '');
  fs.writeFileSync(path.join(dir, 'shims', 'git.shim'), `path = "${real.trim()}"\r\n`);
  process.env.PITROOM_HOME = path.join(dir, 'home');
  const saved = process.env.PATH;
  // Scoop's shims only: Git for Windows' own folders are not on PATH, so its sh.exe is found from the git the shim names
  process.env.PATH = [path.join(dir, 'shims'), ...saved.split(path.delimiter).filter((d) => !/\\Git\\/i.test(d))].join(path.delimiter);
  try {
    const env = guardEnv({ ...process.env });
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    assert.equal(env.PITROOM_REAL_GIT, real.trim().replace(/\\/g, '/'));
    assert.ok(env[key].startsWith(path.join(dir, 'home', 'shim')), env[key].slice(0, 200));
  } finally {
    process.env.PATH = saved;
  }
});

// Windows starts a batch file through `cmd.exe /c "<line>"`, which removes a `^` (`HEAD^` became `HEAD`) and fills in a
// `%name%` that names a variable (`%cd%`) before git.cmd runs; git.cmd takes the raw line instead. An unquoted `& | < >`
// is acted on by that same cmd.exe, which no batch file can undo, so it is not tried here.
test('Windows: git.cmd started by PowerShell hands the arguments over as written (^, %name% and spaces)', { skip: windowsOnly }, () => {
  const { s, env } = setup();
  // a stand-in for the real git that prints what it got, one argument per line (and has no aliases)
  const fake = path.join(s.base, 'fakegit');
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = config ] && exit 1\nfor a do printf \'[%s]\\n\' "$a"; done\n');
  const args = ['show', 'HEAD^', '--grep=a^^b', '--format=%cd%n', '50%', 'two words', '--author=%USERNAME%', '%PATH%'];
  const script = path.join(s.base, 'call.ps1');
  fs.writeFileSync(script, `& git ${args.map((a) => `'${a}'`).join(' ')}\r\nexit $LASTEXITCODE\r\n`);
  for (const shell of ['powershell', 'pwsh']) {
    if (spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status !== 0) continue;
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: s.repo, env: { ...env, PITROOM_REAL_GIT: fake.replace(/\\/g, '/') }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, `${shell}: ${r.stderr}\n${r.stdout}`);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), args.map((a) => `[${a}]`), `${shell} passed them as written`);
  }
});

test('Windows: git.cmd from a cmd /d /s /c line (Node\'s shell) still blocks and passes through', { skip: windowsOnly }, () => {
  const { blocked, allowed, run } = setup();
  blocked(['commit', '--allow-empty', '-m', 'x & y']);
  allowed(['status']);
  const r = run(['log', '-1', '--format=%s']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /init/);
});
