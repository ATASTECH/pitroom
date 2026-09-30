#!/usr/bin/env node
// Runs the multi-repo questions on one or more worker targets and appends one JSON line
// per run to results/raw.jsonl. Nothing is scored here (see score.mjs).
//
//   node run.mjs --repos ~/workspace/bench-repos --lanes 2 \
//     --targets opencode:opencode/big-pickle,codex:gpt-6-sol#low
//
// Each target runs every question with --no-fallback, so a model that fails is recorded as
// failed instead of being replaced by another one.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { answerParts } from './parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, process.env.HOME));
const lanes = Number(args.lanes ?? 2);
const timeout = args.timeout ?? '10m';
const targets = (args.targets ?? '').split(',').filter(Boolean);
if (!targets.length) throw new Error('--targets is required (comma separated, e.g. opencode:opencode/big-pickle)');
const out = path.join(here, 'results', args.out ?? 'raw.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });
const { questions } = JSON.parse(fs.readFileSync(path.join(here, 'questions.json'), 'utf8'));

const exec = promisify(execFile);
const pitroom = async (a) => (await exec('pitroom', a, { encoding: 'utf8', maxBuffer: 1 << 26 })).stdout;
const slug = (t) => t.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();

async function runIds(group) {
  return (await pitroom(['ls', '-g', group])).split('\n').map((l) => l.split(/\s+/)[0]).filter((x) => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(x));
}

async function runTarget(target) {
  const tag = `mr-${slug(target)}-${Date.now().toString(36)}`;
  const repos = [...new Set(questions.map((q) => q.repo))];
  for (const repo of repos) {
    const qs = questions.filter((q) => q.repo === repo);
    await pitroom(['crew', '-d', path.join(reposDir, repo), '-g', `${tag}-${repo}`, '-W', target, '--no-fallback', '-t', timeout, ...qs.map((q) => q.task)]);
  }
  for (const repo of repos) {
    for (;;) {
      try { await pitroom(['wait', '-g', `${tag}-${repo}`, '--timeout', '540', '--brief']); break; } catch (e) { if (e.code !== 75) break; }
    }
  }
  for (const repo of repos) {
    for (const id of await runIds(`${tag}-${repo}`)) {
      const rec = JSON.parse(await pitroom(['show', id, '--json']));
      const q = questions.find((x) => x.repo === repo && x.task === rec.task);
      const txt = await pitroom(['show', id]);
      const seconds = rec.endedAt && rec.startedAt ? Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000) : null;
      fs.appendFileSync(out, JSON.stringify({
        target, model: rec.resolvedModel ?? rec.worker?.model ?? null, repo, question: q?.id ?? null, run: id, state: rec.state, seconds,
        steps: rec.usage?.steps ?? null, tokens: rec.usage?.total ?? null, cost: rec.usage?.cost ?? null,
        refs: rec.refs ?? null, ...answerParts(txt), error: rec.state === 'done' ? null : txt.split('\n').slice(0, 4).join(' ').slice(0, 300),
      }) + '\n');
    }
  }
  console.log(`done: ${target}`);
}

const queue = [...targets];
await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => {
  while (queue.length) await runTarget(queue.shift());
}));
