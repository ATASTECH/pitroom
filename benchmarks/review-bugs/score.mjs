#!/usr/bin/env node
// Scores results/runs.jsonl against manifest.json and prints a Markdown table.
//
//   node score.mjs [--repos ~/workspace/bench-repos] [--json results/scores.json]
//
// Only Critical and Important findings count; Minor ones are style notes.
//   found       a finding names the changed file AND (cites a line within 5 of the bug, or names an
//               identifier from the changed line or from the function around it)
//   exact line  a finding cites file:line within 3 of the bug
//   flagged     the review asked for fixes (Critical or Important findings, or NEEDS-FIXES)
// A run that ended in a provider error is left out; a timeout is kept and counts as a miss.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, os.homedir()));
// Packages whose planted change turned out not to be code (a docstring) are dropped. The clean
// packages are not scored: their random comments are sometimes really wrong (see README).
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8')).filter((m) => !m.invalid && m.kind === 'bug');
const runs = fs.readdirSync(path.join(here, 'results')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(here, 'results', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

const KEYWORDS = new Set(['return', 'function', 'const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'self', 'else', 'elif', 'typeof', 'nil', 'this', 'async', 'await', 'export', 'import', 'from']);
const words = (s) => [...new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []).filter((w) => !KEYWORDS.has(w)))];

// Identifiers that point at the bug: those on the changed line and the name of the function around it.
const truth = Object.fromEntries(manifest.filter((m) => m.kind === 'bug').map((m) => {
  const src = execFileSync('git', ['-C', path.join(reposDir, m.repo), 'show', `${m.commit}:${m.file}`], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n');
  let fn = '';
  for (let i = m.line - 1; i >= Math.max(0, m.line - 60) && !fn; i--) { const f = /(?:function\*?|def|func(?: \([^)]*\))?)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(src[i]) ?? /^\s*(?:export )?(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/.exec(src[i]); if (f) fn = f[1]; }
  return [m.id, { ...m, idents: words(m.after).concat(fn ? [fn] : []) }];
}));

// Reviewers format the headings differently ("CRITICAL:", "**Critical**", "## Critical (1)"), so the
// Critical and Important part is everything between the first such heading and the Minor heading.
// One finding is a top-level bullet or numbered item with the lines that continue it.
function findings(text) {
  const a = text.search(/^[\s#*_>]*(CRITICAL|Critical)\b/m);
  if (a < 0) return [];
  const rest = text.slice(a);
  const end = rest.slice(1).search(/^[\s#*_>]*(MINOR|Minor|NOTES TRIAGE|RECOMMENDATIONS|Recommendations)\b/m);
  // The first finding may sit on the heading line itself ("CRITICAL: path:12 ...").
  const body = (end < 0 ? rest : rest.slice(0, end + 1)).split('\n');
  body[0] = body[0].replace(/^[\s#*_>]*(CRITICAL|Critical)\b[^:\n]*:?/, '');
  const out = [];
  for (const l of body) { if (/^(- |\* |\d+\. )/.test(l) || !out.length) out.push(l); else out[out.length - 1] += ' ' + l; }
  // "IMPORTANT: none. MINOR: ..." on one line: nothing after MINOR counts.
  return out.map((x) => x.split(/\bMINOR\b:?/)[0]).filter((x) => x.trim() && !/^\W*(none|n\/a)\W*$/i.test(x.trim()));
}

function judge(m, run) {
  const v = run.verdict;
  const f = findings(run.text);
  const flagged = !!v && (v.quality === 'needs-fixes' || v.critical > 0 || v.important > 0);
  if (m.kind === 'clean') return { flagged, alarm: !!v && (v.critical > 0 || v.important > 0) };
  const t = truth[m.id], base = path.basename(m.file);
  let found = false, exact = false;
  for (const line of f) {
    if (!line.includes(base)) continue;
    const cited = [...line.matchAll(new RegExp(`${base.replace(/\./g, '\\.')}:(\\d+)`, 'g'))].map((x) => Number(x[1]));
    if (cited.some((n) => Math.abs(n - m.line) <= 3)) exact = true;
    if (cited.some((n) => Math.abs(n - m.line) <= 5) || t.idents.some((w) => line.includes(w))) found = true;
  }
  return { flagged, found: found || exact, exact };
}

const by = new Map();
for (const run of runs) {
  const m = manifest.find((x) => x.id === run.pkg);
  if (!m) continue;
  const t = by.get(run.target) ?? { target: run.target, n: 0, excluded: 0, timeouts: 0, rows: [] };
  by.set(run.target, t);
  if (run.state === 'failed' || (run.state === 'done' && !run.verdict && !run.text)) { t.excluded++; continue; }
  if (run.state !== 'done') t.timeouts++;
  t.n++;
  t.rows.push({ m, run, ...(run.state === 'done' ? judge(m, run) : m.kind === 'clean' ? { flagged: false, alarm: false } : { flagged: false, found: false, exact: false }) });
}

if (process.env.DEBUG) for (const t of by.values()) for (const r of t.rows) console.log(r.m.id, r.m.kind, r.m.difficulty ?? '', JSON.stringify({ f: r.flagged, found: r.found, exact: r.exact, alarm: r.alarm }), r.run.seconds + 's', JSON.stringify(r.run.verdict));
const cnt = (rows, f) => rows.filter(f).length;
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = [...by.values()].filter((t) => t.n >= Number(process.env.MIN_REVIEWS ?? 5)).map((t) => {
  const bugs = t.rows.filter((r) => r.m.kind === 'bug'), clean = t.rows.filter((r) => r.m.kind === 'clean');
  const easy = bugs.filter((r) => r.m.difficulty === 'easy'), hard = bugs.filter((r) => r.m.difficulty === 'hard');
  const secs = t.rows.map((r) => r.run.seconds).filter((x) => x != null);
  return {
    target: t.target, n: t.n, excluded: t.excluded, timeouts: t.timeouts, bugs: bugs.length, clean: clean.length,
    found: cnt(bugs, (r) => r.found) / (bugs.length || 1), foundEasy: cnt(easy, (r) => r.found) / (easy.length || 1), foundHard: cnt(hard, (r) => r.found) / (hard.length || 1),
    exact: cnt(bugs, (r) => r.exact) / (bugs.length || 1), flagged: cnt(bugs, (r) => r.flagged) / (bugs.length || 1),
    alarm: clean.length ? cnt(clean, (r) => r.alarm) / clean.length : null,
    medianSeconds: median(secs), meanSeconds: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null, maxSeconds: secs.length ? Math.max(...secs) : null,
    medianTokens: median(t.rows.map((r) => r.run.tokens)),
  };
}).sort((a, b) => b.found - a.found || (a.alarm ?? 1) - (b.alarm ?? 1));

const P = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
const S = (x) => (x == null ? '-' : x >= 120 ? `${Math.floor(x / 60)} min ${Math.round(x % 60)} s` : `${Math.round(x)} s`);
console.log('| Worker and model | Bug found | Easy | Hard | Exact line | Asked for fixes | Reviews | Mean time | Slowest | Median tokens |\n|---|---|---|---|---|---|---|---|---|---|');
for (const s of summary) console.log(`| ${s.target.replace(/^opencode:/, '')} | **${P(s.found)}** | ${P(s.foundEasy)} | ${P(s.foundHard)} | ${P(s.exact)} | ${P(s.flagged)} | ${s.n}${s.timeouts ? ` (${s.timeouts} timed out)` : ''}${s.excluded ? `, ${s.excluded} left out` : ''} | ${S(s.meanSeconds)} | ${S(s.maxSeconds)} | ${s.medianTokens ? Math.round(s.medianTokens / 1000) + 'k' : '-'} |`);
if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify(summary, null, 1) + '\n');
