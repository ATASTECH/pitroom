// Shared test sandbox: a git repo with uncommitted user work, an isolated
// PITROOM_HOME/config, and the fake OpenCode binary.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** For a test that needs sh scripts, POSIX file modes or the git guard (the guard is not on Windows yet): `{ skip: posixOnly }`. */
export const posixOnly = process.platform === 'win32' ? 'POSIX-only (sh scripts, file modes, git guard)' : false;
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(root, 'dist', 'pitroom.mjs');
// Executed directly (no sh wrapper): a shell would silently repair a stale $PWD, which is
// exactly what OpenCode does not do.
const MOCK = path.join(root, 'test', 'fixtures', 'opencode', 'mock', 'opencode.mjs');
fs.chmodSync(MOCK, 0o755);

// Every temp directory a test makes is removed when that test file's process exits (set PITROOM_TEST_KEEP=1
// to look at them): they used to pile up in the temp folder, thousands of them after a few weeks.
const made = [];
process.on('exit', () => {
  if (process.env.PITROOM_TEST_KEEP) return;
  // a background process (Chrome, a dash server, an audit) may still be writing as the test ends: retry a few times
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
export function scratchDir(prefix) {
  // The name the file system gives it: on Windows the temp folder is otherwise spelled RUNNER~1 here and runneradmin there.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function sandbox() {
  const base = scratchDir('pitroom-test-');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'line1\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'keep\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Uncommitted user work that must survive every mode.
  fs.writeFileSync(path.join(repo, 'other.txt'), 'keep\nuser wip\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'draft\n');
  const log = path.join(base, 'mock.log');
  const env = {
    ...process.env,
    PITROOM_HOME: path.join(base, 'home'),
    PITROOM_CONFIG: path.join(base, 'config.json'),
    PITROOM_OPENCODE_BIN: MOCK,
    // an MCP call that is still running would start a dashboard that nothing stops: tests that look at it turn it on
    PITROOM_MCP_DASH: '0',
    // the mock's `#!/usr/bin/env node` must find this Node, not an older one earlier on PATH
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    MOCK_LOG: log,
  };
  delete env.PITROOM_ACTIVE;
  for (const k of ['PITROOM_WORKER', 'PITROOM_MODEL', 'PITROOM_FALLBACK', 'PITROOM_TIMEOUT', 'PITROOM_PRIMARY', 'PITROOM_PRICE', 'PITROOM_MAX_PARALLEL', 'PITROOM_CACHE_DAYS', 'PITROOM_READ_IN', 'PITROOM_AUDIT', 'PITROOM_PRICE_FEED', 'PITROOM_PRICE_FEED_URL', 'PITROOM_PRICE_FEED_HOURS', 'PITROOM_NOTIFY', 'PITROOM_NOTIFY_COMMAND', 'PITROOM_NOTIFY_AFTER']) delete env[k];
  const run = (args, extra = {}, input = undefined) =>
    // PWD as a shell would set it: some worker CLIs trust $PWD over the real cwd.
    spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...env, PWD: repo, ...extra }, input, encoding: 'utf8', timeout: 60_000 });
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const calls = () => entries().filter((e) => e.argv);
  const execs = () => entries().filter((e) => e.exec);
  const status = () => git('status', '--porcelain');
  const config = (obj) => fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(obj));
  return { base, repo, git, run, calls, execs, status, config, env };
}
