#!/usr/bin/env node
// Tries a worker CLI the way Pitroom uses it, on this machine, and prints what held: for checking a worker on a
// platform it has not been tried on (Antigravity on Linux and Windows). Everything happens in a new git repository in
// the temp folder, with a Pitroom state folder of its own, so your projects, history and savings are not touched; the
// worker CLI uses your own sign-in.
//
//   node scripts/check-worker.mjs antigravity[:model] [--cli path/to/pitroom.mjs] [--only NAME] [--keep]
//
// Paste the report it prints (or the JSON file it names) where you were asked to.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined; // run the checks whose name has this
const target = argv.find((a) => !a.startsWith('--') && !['--cli', '--only'].includes(argv[argv.indexOf(a) - 1]));
if (!target) {
  console.error('usage: node scripts/check-worker.mjs <worker[:model]> [--cli path/to/pitroom.mjs] [--keep]');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const local = path.join(here, '..', 'dist', 'pitroom.mjs');
const cliArg = argv.includes('--cli') ? argv[argv.indexOf('--cli') + 1] : undefined;
const cli = cliArg ?? (fs.existsSync(local) ? local : undefined);
const backend = target.split(':')[0];

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-check-'));
const repo = path.join(base, 'repo');
const outside = path.join(base, 'outside');
fs.mkdirSync(repo);
fs.mkdirSync(outside);
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'check@example.com');
git('config', 'user.name', 'check');
fs.writeFileSync(path.join(repo, 'config.txt'), 'MAGIC=7319\nSECOND=blue-heron\n');
fs.writeFileSync(path.join(repo, 'notes.txt'), 'first line\n');
git('add', '.');
git('commit', '-qm', 'start');
const head = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(outside, 'word.txt'), 'The word is lantern-81.\n');

const env = {
  ...process.env,
  PITROOM_HOME: path.join(base, 'state'),
  PITROOM_WORKER: target,
  PITROOM_FALLBACK: '',
  PITROOM_AUDIT: '0', // an audit would be a second worker's run
  PITROOM_CACHE_DAYS: '0',
};
const pitroom = (args, timeout = 15 * 60_000) => {
  const [cmd, pre] = cli ? [process.execPath, [cli]] : ['pitroom', []];
  const r = spawnSync(cmd, [...pre, ...args], { cwd: repo, env, encoding: 'utf8', timeout, shell: !cli && process.platform === 'win32' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
};
const RUN = /\d{8}-\d{6}-[0-9a-f]{4}/;
const show = (id) => {
  const r = pitroom(['show', id, '--json'], 60_000);
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('{')));
  } catch {
    return undefined;
  }
};
const run = (args) => {
  const r = pitroom(['run', '--no-fallback', ...args]);
  const id = RUN.exec(r.out)?.[0];
  const meta = id ? show(id) : undefined;
  const answer = id ? pitroom(['show', id, '--full'], 60_000).out : r.out;
  return { ...r, id, meta, answer };
};
const events = (id) => {
  try {
    return fs.readFileSync(path.join(env.PITROOM_HOME, 'runs', id, 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
};

const results = [];
const check = (name, fn) => {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  let res;
  try {
    res = fn();
  } catch (e) {
    res = { ok: false, detail: `threw: ${e.message}` };
  }
  results.push({ name, ...res, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${res.ok === true ? 'PASS' : res.ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${res.detail ? `: ${res.detail}` : ''}`);
};
const brief = (r) => (r.meta ? `${r.meta.state}${r.meta.error ? ` (${r.meta.error.slice(0, 160)})` : ''}` : `no run (${(r.error ?? r.out).slice(0, 160)})`);

console.log(`checking ${target} on ${process.platform} ${os.release()} with Node ${process.version}; work folder ${base}\n`);

check('doctor --probe: the worker is installed, signed in and answers', () => {
  const r = pitroom(['doctor', '--probe'], 5 * 60_000);
  const probe = r.out.split('\n').find((l) => /live probe/.test(l)) ?? '';
  const version = r.out.split('\n').find((l) => new RegExp(`\\b${backend}\\b.*\\d+\\.\\d+`, 'i').test(l)) ?? '';
  return { ok: /answered/.test(probe), detail: `${probe.trim()} | ${version.trim()}`.slice(0, 300) };
});

let first;
check('read: answers a question about the project, and writes nothing', () => {
  first = run(['What number does config.txt set MAGIC to? Answer with the number.']);
  const violation = (first.meta?.warnings ?? []).find((w) => /READ-ONLY VIOLATION/.test(w));
  return { ok: first.meta?.state === 'done' && /7319/.test(first.answer) && !violation, detail: violation ?? brief(first) };
});

check('follow-up (--continue): the same session goes on', () => {
  if (!first?.id || first.meta?.state !== 'done') return { ok: 'skip', detail: 'the read run did not finish' };
  const r = run(['--continue', first.id, 'And what does the same file set SECOND to?']);
  return { ok: r.meta?.state === 'done' && /blue-heron/.test(r.answer), detail: brief(r) };
});

check('read outside the project: a file the task names by its full path', () => {
  const r = run([`What word is written in ${path.join(outside, 'word.txt')}?`]);
  const ok = r.meta?.state === 'done' && /lantern-81/.test(r.answer);
  // Pitroom grants Antigravity no reads outside the workspace on Windows (see docs/backends.md)
  if (!ok && backend === 'antigravity' && process.platform === 'win32') return { ok: 'skip', detail: `not granted on Windows, as documented: ${brief(r)}` };
  return { ok, detail: brief(r) };
});

check('shell: runs a command and reports its output', () => {
  const r = run(['Run the shell command `echo pitroom-shell-ok` and report exactly what it printed.']);
  return { ok: r.meta?.state === 'done' && /pitroom-shell-ok/.test(r.answer), detail: brief(r) };
});

check('isolated change (-i): edits a copy, the patch has the change, your tree does not', () => {
  const r = run(['-i', "Append one line, 'checked by pitroom', to notes.txt. Change nothing else."]);
  const patch = r.id ? pitroom(['show', r.id, '--patch'], 60_000).out : '';
  const mine = fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8');
  const ok = r.meta?.state === 'done' && /\+checked by pitroom/.test(patch) && mine === 'first line\n' && git('rev-parse', 'HEAD') === head;
  return { ok, detail: `${brief(r)}; files ${JSON.stringify((r.meta?.changes ?? []).map((c) => c.path))}; your notes.txt ${mine === 'first line\n' ? 'untouched' : 'CHANGED'}` };
});

check('git guard: a commit the worker tries does not happen', () => {
  const r = run(['-i', 'Create a file named extra.txt with the text x, then run `git add extra.txt` and `git commit -m extra`, and report what git printed.']);
  const said = `${r.answer}\n${r.id ? events(r.id) : ''}`;
  // who said no: Pitroom's git shim or ref hook, or the worker CLI's own rules
  const by = /blocked for workers|ref updates .* are blocked/.test(said) ? 'the git guard' : /denied|not allowed|permission|refus/i.test(said) ? "the worker's own rules" : 'nothing that said so';
  // the isolated copy has no commit of its own (its HEAD is unborn, or the start commit): a commit there gives it one
  let copyHead = '';
  try {
    copyHead = r.meta?.worktree ? execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: r.meta.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() : '';
  } catch {
    copyHead = '';
  }
  const committed = !!copyHead && copyHead !== head;
  return { ok: !committed && git('rev-parse', 'HEAD') === head && by !== 'nothing that said so', detail: `${committed ? 'A COMMIT WAS MADE in the copy' : 'no commit'}; refused by ${by}; ${brief(r)}` };
});

check('an unknown model fails as "model not available", not as a crash', () => {
  const r = run(['-W', `${backend}:no-such-model-pitroom-check`, 'Say hi.']);
  return { ok: r.meta?.state === 'failed' && r.meta?.failureKind === 'model-unavailable', detail: `${brief(r)}; kind ${r.meta?.failureKind}` };
});

const report = { target, platform: process.platform, release: os.release(), arch: process.arch, node: process.version, at: new Date().toISOString(), results };
const file = path.join(os.tmpdir(), `pitroom-check-${backend}-${process.platform}.json`);
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${results.length - failed} of ${results.length} held${failed ? `, ${failed} did not` : ''}. Report: ${file}`);
if (!argv.includes('--keep')) fs.rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
