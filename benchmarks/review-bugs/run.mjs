#!/usr/bin/env node
// Reviews every package with every target and appends one JSON line per run to
// results/runs.jsonl. Resumable: a (target, package, repeat) that is already in the file is skipped.
//
//   node run.mjs --targets opencode:opencode/muse-spark-1.3-contributor-free,codex:gpt-6-sol \
//     --pool 12 --reps 1 [--only p03,p05] [--limit 10]
//
// Runs use --no-fallback, so a model that fails stays failed instead of being replaced.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, os.homedir()));
const targets = (args.targets ?? '').split(',').filter(Boolean);
if (!targets.length) throw new Error('--targets is required');
const pool = Number(args.pool ?? 12);
const reps = Number(args.reps ?? 1);
const only = args.only?.split(',');
const timeout = args.timeout ?? '8m';
const out = path.join(here, 'results', args.out ?? 'runs.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8')).filter((m) => !only || only.includes(m.id));

const execFileAsync = promisify(execFile);
const pitroom = async (a) => (await execFileAsync('pitroom', a, { encoding: 'utf8', maxBuffer: 1 << 26 })).stdout;
const key = (t, id, rep) => `${t}|${id}|${rep}`;
// A run that failed (provider error) is not done: it is tried again on the next start.
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.state !== 'failed').map((r) => key(r.target, r.pkg, r.rep)) : []);

// Round-robin over targets so no provider gets all the load at once; a fixed shuffle keeps runs reproducible.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const jobs = [];
for (let rep = 1; rep <= reps; rep++) for (const m of manifest) for (const t of targets) if (!done.has(key(t, m.id, rep))) jobs.push({ t, m, rep });
jobs.sort(() => rnd() - 0.5);
const todo = args.limit ? jobs.slice(0, Number(args.limit)) : jobs;
console.log(`${todo.length} runs (${done.size} already done), pool ${pool}`);

async function one({ t, m, rep }) {
  let rec = null, text = '', error = null;
  try {
    const first = await pitroom(['review', '--range', `${m.base}..${m.commit}`, '-d', path.join(reposDir, m.repo), '-W', t, '--no-fallback', '-t', timeout, '--json']);
    rec = JSON.parse(first);
  } catch (e) {
    error = String(e.stderr || e.message).slice(0, 300);
    try { rec = JSON.parse(e.stdout); } catch { /* no record: keep the message */ }
  }
  if (rec) try { text = await pitroom(['show', rec.id]); } catch { /* no text */ }
  const sec = rec?.endedAt && rec?.startedAt ? Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000) : null;
  fs.appendFileSync(out, JSON.stringify({
    target: t, model: rec?.resolvedModel ?? null, pkg: m.id, rep, run: rec?.id ?? null, state: rec?.state ?? 'failed', seconds: sec,
    steps: rec?.usage?.steps ?? null, tokens: rec?.usage?.total ?? null, verdict: rec?.verdict ?? null, refs: rec?.refs ?? null,
    text: text.slice(0, 12000), error: rec?.state === 'done' ? null : (error ?? text.split('\n').slice(0, 4).join(' ')).slice(0, 300),
  }) + '\n');
}

let next = 0, finished = 0;
await Promise.all(Array.from({ length: Math.min(pool, todo.length) }, async () => {
  while (next < todo.length) { await one(todo[next++]); if (++finished % 10 === 0) console.log(`${finished}/${todo.length}`); }
}));
console.log('done');
