#!/usr/bin/env node
// Scores results/*.jsonl against `git grep` on each repository and prints a Markdown table.
//
//   node score.mjs --repos ~/workspace/bench-repos [--json results/scores.json]
//
// definition  1 for the exact path:line, 0.5 for the right file on another line
// count       1 only for the exact number
// set         F1 of the listed paths against the real list (precision and recall both count)
// A run that did not finish scores 0 and is counted as a failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, process.env.HOME));
const { questions, repos } = JSON.parse(fs.readFileSync(path.join(here, 'questions.json'), 'utf8'));

const grep = (repo, flags, pattern, dir) => {
  try { return execFileSync('git', ['-C', path.join(reposDir, repo), 'grep', ...flags, '-e', pattern, '--', dir], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; }
};

function truthOf(q) {
  const t = q.truth;
  const head = execFileSync('git', ['-C', path.join(reposDir, q.repo), 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== repos[q.repo].commit) throw new Error(`${q.repo} is at ${head}, the questions were written for ${repos[q.repo].commit}`);
  const mode = t.regex ? '-E' : '-F';
  if (q.kind === 'definition') {
    const [hit] = grep(q.repo, ['-n', mode], t.pattern, t.dir).map((l) => /^(.*?):(\d+):/.exec(l)).filter(Boolean);
    if (!hit) throw new Error(`no definition for ${q.id}`);
    return { path: hit[1], line: Number(hit[2]) };
  }
  const files = grep(q.repo, ['-l', mode, ...(t.word ? ['-w'] : [])], t.pattern, t.dir).filter((f) => !t.excludeRe || !new RegExp(t.excludeRe).test(f));
  return q.kind === 'count' ? { count: files.length } : { files };
}

const pathsIn = (s) => [...new Set((s.match(/[A-Za-z0-9_.@\-/]+\.[A-Za-z0-9]{1,5}/g) ?? []).map((p) => p.replace(/^\.?\//, '').replace(/:\d+$/, '')))];

const quota = (row) => row.state !== 'done' && /rate.?limit/i.test(row.error ?? '');

function score(q, truth, row) {
  if (row.state !== 'done') return { s: 0, got: `(${row.state})` };
  if (!row.summary.trim()) return { s: 0, got: '(no answer in the requested format)' };
  const sum = row.summary.replace(/`/g, '');
  if (q.kind === 'definition') {
    if (sum.includes(`${truth.path}:${truth.line}`)) return { s: 1, got: sum };
    return { s: sum.includes(truth.path) ? 0.5 : 0, got: sum };
  }
  if (q.kind === 'count') {
    const n = /\d[\d,]*/.exec(sum);
    const got = n ? Number(n[0].replace(/,/g, '')) : null;
    return { s: got === truth.count ? 1 : 0, got };
  }
  let got = pathsIn(sum);
  if (!got.length) got = pathsIn(row.details.replace(/`/g, ''));
  const hit = got.filter((p) => truth.files.includes(p)).length;
  const p = got.length ? hit / got.length : 0, r = truth.files.length ? hit / truth.files.length : 0;
  return { s: p + r ? (2 * p * r) / (p + r) : 0, got: `${hit}/${truth.files.length} found, ${got.length - hit} extra` };
}

const rows = fs.readdirSync(path.join(here, 'results')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(here, 'results', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const truths = Object.fromEntries(questions.map((q) => [q.id, truthOf(q)]));
const byTarget = new Map();
for (const row of rows) {
  const q = questions.find((x) => x.id === row.question);
  if (!q) continue;
  const t0 = byTarget.get(row.target) ?? { target: row.target, model: row.model, runs: [], unmeasured: 0 };
  if (quota(row)) { t0.unmeasured++; byTarget.set(row.target, t0); continue; }
  const res = score(q, truths[q.id], row);
  const t = t0;
  t.runs.push({ q: q.id, kind: q.kind, ...res, state: row.state, seconds: row.seconds, tokens: row.tokens, cost: row.cost, refs: row.refs });
  byTarget.set(row.target, t);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = [...byTarget.values()].map((t) => ({
  target: t.target, model: t.model, n: t.runs.length, unmeasured: t.unmeasured, failed: t.runs.filter((r) => r.state !== 'done').length,
  accuracy: t.runs.length ? mean(t.runs.map((r) => r.s)) : null,
  byKind: Object.fromEntries(['definition', 'count', 'set'].map((k) => [k, t.runs.some((r) => r.kind === k) ? mean(t.runs.filter((r) => r.kind === k).map((r) => r.s)) : null])),
  medianSeconds: median(t.runs.map((r) => r.seconds)), medianTokens: median(t.runs.map((r) => r.tokens)),
  cost: t.runs.reduce((a, r) => a + (r.cost ?? 0), 0), runs: t.runs,
})).sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1) || (a.medianSeconds ?? 1e9) - (b.medianSeconds ?? 1e9));

const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
console.log('| Worker and model | Score | Definition | Count | List | Scored runs | Failed | Not measured | Median time | Median tokens |\n|---|---|---|---|---|---|---|---|---|---|');
for (const s of summary) {
  console.log(`| ${s.target.replace(/^opencode:/, '')} | **${pct(s.accuracy)}** | ${pct(s.byKind.definition)} | ${pct(s.byKind.count)} | ${pct(s.byKind.set)} | ${s.n} | ${s.failed} | ${s.unmeasured ? s.unmeasured + ' (quota)' : '-'} | ${s.medianSeconds ?? '-'} s | ${s.medianTokens ? Math.round(s.medianTokens / 1000) + 'k' : '-'} |`);
}
if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify({ truths, summary }, null, 1) + '\n');
