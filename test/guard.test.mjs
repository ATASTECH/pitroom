import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.mjs';
import { guardEnv } from '../dist/lib.mjs';

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
