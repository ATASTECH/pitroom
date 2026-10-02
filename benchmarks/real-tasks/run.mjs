#!/usr/bin/env node
// Runs real tasks from Pitroom's history in two arms and judges them with the commit's own tests.
//   A  Claude Code alone (no pitroom command)
//   B  the same Claude Code with Pitroom's usage guide and the pitroom command
// Each run gets a fresh copy of the code at the parent commit, with NO history (the fix is not in it).
// The commit's test files are copied in only after the run; a run passes when they pass.
//
//   node run.mjs --validate                     check each task: tests fail before, pass after
//   node run.mjs --tasks pitroom-card-subjects --arms A,B --reps 1                 # primary agent: Claude Code (default)
//   node run.mjs --primary codex --tasks pitroom-card-subjects --arms A,B --reps 1  # primary agent: Codex (gpt-6-sol)
// With --primary codex, A is Codex alone and B is the same Codex with Pitroom's guide and the pitroom command; each run gets
// its own HOME and CODEX_HOME (only the login is copied), so no installed skill or setting leaks into arm A.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean));
const REPO = path.resolve((args.repo ?? '~/workspace/pitroom').replace(/^~/, os.homedir()));
const WORK = path.resolve((args.work ?? '~/workspace/bench-work').replace(/^~/, os.homedir()));
const PRIMARY = args.primary ?? 'claude';
const MODEL = args.model ?? (PRIMARY === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5-5');
const BUDGET = args.budget; // no cap unless --budget is given: a cap would cut an expensive run short and score it as a failure
const TIMEOUT = Number(args.timeout ?? 15) * 60_000;
const POOL = Number(args.pool ?? 2);
const NODE_BIN = path.dirname(process.execPath);
const env = { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}` };
const { tasks } = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const out = path.join(here, 'results', 'runs.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], env, ...o });
const git = (...a) => sh('git', ['-C', REPO, ...a]);

function freshCopy(dir, rev) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  sh('bash', ['-c', `git -C "${REPO}" archive ${rev} | tar -x -C "${dir}"`]);
  sh('git', ['-C', dir, 'init', '-q']);
  sh('git', ['-C', dir, 'add', '-A']);
  sh('git', ['-C', dir, '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'base']);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
}

function judge(dir, task) {
  for (const f of task.tests) fs.writeFileSync(path.join(dir, f), git('show', `${task.fix}:${f}`));
  try {
    sh('bash', ['-c', `npm run build >/dev/null 2>&1 && node --test ${task.tests.join(' ')}`], { cwd: dir, timeout: 300_000 });
    return { pass: true, tail: '' };
  } catch (e) { return { pass: false, tail: String(e.stdout || e.message).split('\n').filter((l) => /not ok|expected|actual|Error/.test(l)).slice(0, 6).join(' | ').slice(0, 400) }; }
}

if (args.validate) {
  for (const t of tasks) {
    const base = git('rev-parse', `${t.fix}^`).trim();
    const before = path.join(WORK, `validate-${t.id}-before`), after = path.join(WORK, `validate-${t.id}-after`);
    freshCopy(before, base); freshCopy(after, t.fix);
    const b = judge(before, t), a = judge(after, t);
    console.log(`${t.id}: before ${b.pass ? 'PASS (bad: task already passes)' : 'fails (good)'} | after ${a.pass ? 'passes (good)' : 'FAILS (bad)'}`);
    fs.rmSync(before, { recursive: true, force: true }); fs.rmSync(after, { recursive: true, force: true });
  }
  process.exit(0);
}

const GUIDE = `Pitroom is installed (the \`pitroom\` command). It sends bounded reading, implementing and review work to cheaper worker agents and returns a compact answer. You decide whether it helps here; small work is faster done yourself. Its usage guide follows; the other skills it names are in ${path.join(REPO, 'skills')}.\n\n${fs.readFileSync(path.join(REPO, 'skills/using-pitroom/SKILL.md'), 'utf8')}`;
const TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(cat:*)'];

async function claudeRun(dir, arm, prompt, pitroomHome) {
  const a = ['-p', '--model', MODEL, '--permission-mode', 'acceptEdits', '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--output-format', 'json', ...(BUDGET ? ['--max-budget-usd', BUDGET] : []), '--allowedTools', (arm === 'B' ? [...TOOLS, 'Bash(pitroom:*)'] : TOOLS).join(','), '--disallowedTools', arm === 'A' ? 'Bash(pitroom:*)' : 'Bash(git push:*)'];
  if (arm === 'B') a.push('--add-dir', path.join(REPO, 'skills'), '--append-system-prompt', GUIDE);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('claude', a, { cwd: dir, env: { ...env, PITROOM_HOME: pitroomHome }, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '', killed = false;
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, TIMEOUT);
    p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
    p.on('close', () => { clearTimeout(timer); let j = null; try { j = JSON.parse(so); } catch { /* no json */ } resolve({ j, killed, seconds: Math.round((Date.now() - t0) / 1000), err: se.slice(-300) }); });
    p.stdin.end(prompt);
  });
}

/** Codex as the primary agent: `codex exec` in a sandbox that can write the copy, plus (arm B) Pitroom's and OpenCode's state dirs. */
async function codexRun(dir, arm, prompt, pitroomHome) {
  const base = `${dir}.home`;
  const home = path.join(base, 'home'), codexHome = path.join(base, 'codex');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'));
  const real = (rel) => path.join(os.homedir(), rel);
  const roots = [os.tmpdir(), base];
  if (arm === 'B') {
    // OpenCode's login and settings, and Pitroom's config, are the user's own: linked in, never copied.
    for (const rel of ['.config/opencode', '.config/pitroom', '.local/share/opencode', '.local/state/opencode', '.cache/opencode']) {
      if (!fs.existsSync(real(rel))) continue;
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.symlinkSync(real(rel), path.join(home, rel));
      if (rel.startsWith('.local/') || rel.startsWith('.cache/')) roots.push(real(rel));
    }
    roots.push(pitroomHome);
  }
  const a = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-m', MODEL, '-s', 'workspace-write', '-C', dir,
    '-c', 'sandbox_workspace_write.network_access=true', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`, '-'];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('codex', a, { cwd: dir, env: { ...env, HOME: home, CODEX_HOME: codexHome, PITROOM_HOME: pitroomHome }, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '', killed = false;
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, TIMEOUT);
    p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
    p.on('close', () => {
      clearTimeout(timer);
      const usage = { input_tokens: 0, output_tokens: 0, cached: 0 };
      let result = '', turns = 0, error = null;
      for (const line of so.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'turn.completed' && e.usage) { turns++; usage.input_tokens += e.usage.input_tokens ?? 0; usage.output_tokens += (e.usage.output_tokens ?? 0) + (e.usage.reasoning_output_tokens ?? 0); usage.cached += e.usage.cached_input_tokens ?? 0; }
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') result = e.item.text ?? result;
        if (e.type === 'error' || e.type === 'turn.failed') error = JSON.stringify(e).slice(0, 300);
      }
      fs.rmSync(base, { recursive: true, force: true });
      resolve({ j: turns ? { result, is_error: !!error, total_cost_usd: null, num_turns: turns, usage, cachedTokens: usage.cached } : null, killed, seconds: Math.round((Date.now() - t0) / 1000), err: error ?? se.slice(-300) });
    });
    p.stdin.end(prompt);
  });
}

function pitroomStats(home) {
  const f = path.join(home, 'ledger.jsonl');
  if (!fs.existsSync(f)) return { workers: 0 };
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { workers: rows.length, workerTokens: rows.reduce((s, r) => s + (r.tokens ?? 0), 0), returnedTokens: rows.reduce((s, r) => s + (r.returned ?? 0), 0), models: [...new Set(rows.map((r) => `${r.backend}:${r.model ?? 'default'}`))], modes: [...new Set(rows.map((r) => r.mode))], failed: rows.filter((r) => r.state !== 'done').length };
}

async function job({ t, arm, rep }) {
  const id = `${t.id}-${arm}-${rep}`, dir = path.join(WORK, id), home = path.join(WORK, `${id}.pitroom`);
  fs.rmSync(home, { recursive: true, force: true });
  freshCopy(dir, git('rev-parse', `${t.fix}^`).trim());
  const prompt = `You are working in a copy of the Pitroom repository (a TypeScript CLI; tests run with \`npm test\`, which builds first). Implement this in src/:\n\n${t.prompt}\n\nHidden tests will check the behaviour. Run the existing tests to be sure nothing else breaks. Do not commit. Finish with one short sentence on what you changed.`;
  const r = await (PRIMARY === 'codex' ? codexRun(dir, arm, (arm === 'B' ? `${GUIDE}\n\n---\n\n` : '') + prompt, home) : claudeRun(dir, arm, prompt, home));
  const diff = sh('git', ['-C', dir, 'diff', '--numstat', '--', 'src']).split('\n').filter(Boolean).reduce((s, l) => s + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
  const verdict = judge(dir, t);
  const u = r.j?.usage ?? {};
  const row = {
    task: t.id, arm, rep, primary: PRIMARY, model: MODEL, pass: verdict.pass, failTail: verdict.tail, seconds: r.seconds, killed: r.killed, ok: r.j ? !r.j.is_error : false,
    costUsd: r.j?.total_cost_usd ?? null, turns: r.j?.num_turns ?? null, claudeTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || null,
    outputTokens: u.output_tokens ?? null, cachedTokens: r.j?.cachedTokens ?? null, srcLinesChanged: diff, pitroom: arm === 'B' ? pitroomStats(home) : null, answer: (r.j?.result ?? '').slice(0, 300), error: r.j ? null : r.err,
  };
  fs.appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(`${id}: ${row.pass ? 'PASS' : 'fail'} ${row.seconds}s $${row.costUsd ?? '?'} workers ${row.pitroom?.workers ?? '-'}`);
  if (!args.keep) fs.rmSync(dir, { recursive: true, force: true });
}

const want = args.tasks && args.tasks !== 'all' ? args.tasks.split(',') : tasks.map((t) => t.id);
const arms = (args.arms ?? 'A,B').split(','), reps = Number(args.reps ?? 1);
const jobs = [];
for (let rep = 1; rep <= reps; rep++) for (const t of tasks.filter((x) => want.includes(x.id))) for (const arm of arms) jobs.push({ t, arm, rep });
let next = 0;
await Promise.all(Array.from({ length: Math.min(POOL, jobs.length) }, async () => { while (next < jobs.length) await job(jobs[next++]); }));
