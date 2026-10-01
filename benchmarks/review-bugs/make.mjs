#!/usr/bin/env node
// Builds the review packages: one commit per package on a neutral branch of each repository.
//   bug (easy)   one planted semantic bug, nothing else
//   bug (hard)   the same kind of bug plus three comment-only edits in the same file
//   clean        three comment-only edits, no bug
// The truth (file, line, what was changed) goes to manifest.json, which the reviewers never see.
//
//   node make.mjs --repos ~/workspace/bench-repos [--bugs 4] [--clean 4]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, os.homedir()));
const PER_REPO_BUGS = Number(args.bugs ?? 4); // per difficulty
const PER_REPO_CLEAN = Number(args.clean ?? 4);

const REPOS = {
  react: { lang: 'js', ext: ['.js'], roots: ['packages/react-reconciler/src', 'packages/react-dom/src', 'packages/react/src', 'packages/scheduler/src'] },
  django: { lang: 'py', ext: ['.py'], roots: ['django/db', 'django/utils', 'django/http', 'django/core'] },
  kubernetes: { lang: 'go', ext: ['.go'], roots: ['pkg/kubelet', 'pkg/scheduler', 'pkg/proxy', 'staging/src/k8s.io/apimachinery/pkg/util'] },
  pitroom: { lang: 'ts', ext: ['.ts'], roots: ['src/core', 'src/backends'] },
};

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });

const isComment = (l) => /^\s*(\/\/|#|\*|\/\*)/.test(l);
const inString = (l, idx) => ((l.slice(0, idx).match(/["'`]/g) ?? []).length % 2) === 1;

// Each operator: given one line, return the mutated line or null.
const swap = (pairs) => (l) => { for (const [a, b] of pairs) { const i = l.indexOf(a); if (i >= 0 && !inString(l, i)) return l.slice(0, i) + b + l.slice(i + a.length); } return null; };
const OPS = {
  boundary: swap([[' <= ', ' < '], [' >= ', ' > '], [' < ', ' <= '], [' > ', ' >= ']]),
  equality: (lang) => swap(lang === 'js' || lang === 'ts' ? [[' === ', ' !== '], [' !== ', ' === ']] : [[' == ', ' != '], [' != ', ' == ']]),
  logic: (lang) => swap(lang === 'py' ? [[' and ', ' or '], [' or ', ' and ']] : [[' && ', ' || '], [' || ', ' && ']]),
  offByOne: swap([[' - 1', ' + 1'], [' + 1', ' - 1']]),
  returnFlip: (lang) => { const [t, f] = lang === 'py' ? ['True', 'False'] : ['true', 'false']; return (l) => (new RegExp(`^(\\s*return )${t}\\b`).test(l) ? l.replace(t, f) : new RegExp(`^(\\s*return )${f}\\b`).test(l) ? l.replace(f, t) : null); },
};

function candidates(lines, lang) {
  const out = [];
  lines.forEach((l, i) => {
    if (isComment(l) || !l.trim()) return;
    for (const [name, op] of Object.entries(OPS)) {
      const fn = typeof op === 'function' && op.length === 1 && name !== 'boundary' && name !== 'offByOne' ? op(lang) : op;
      const m = fn(l);
      if (m && m !== l) out.push({ i, op: name, before: l, after: m });
    }
  });
  return out;
}

function syntaxOk(lang, file, text) {
  try {
    if (lang === 'py') { const t = path.join(os.tmpdir(), `mut-${process.pid}.py`); fs.writeFileSync(t, text); execFileSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', t], { stdio: 'pipe' }); }
    if (lang === 'go') execFileSync('gofmt', ['-e'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

const NOTES = ['keep in sync with the callers', 'see the design notes', 'order matters here', 'hot path', 'callers rely on this', 'kept for compatibility'];
function addComments(lines, lang, r, avoid, n = 3) {
  const mark = lang === 'py' ? '#' : '//';
  const spots = [];
  lines.forEach((l, i) => { if (i > 2 && l.trim() && !isComment(l) && !avoid.includes(i) && (!lines[i - 1].trim() || /[{:;]\s*$/.test(lines[i - 1]))) spots.push(i); });
  const pick = shuffle(spots, r).slice(0, n).sort((a, b) => b - a);
  for (const i of pick) { const ind = /^\s*/.exec(lines[i])[0]; lines.splice(i, 0, `${ind}${mark} ${NOTES[Math.floor(r() * NOTES.length)]}`); }
  return pick.length;
}

function sourceFiles(dir, cfg) {
  return git(dir, 'ls-files', '--', ...cfg.roots).split('\n').filter((f) => cfg.ext.some((e) => f.endsWith(e)) && !/(test|spec|mock|fake|generated|zz_|\.pb\.|__tests__|testdata|fixtures)/i.test(f));
}

// New-file line number of the added line whose text is `text` (comment-only additions are skipped).
export function addedLine(dir, base, commit, text) {
  let cur = 0, found = null;
  for (const l of git(dir, 'diff', '-U0', base, commit).split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { cur = Number(h[1]); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) { if (l.slice(1).trim() === text) found = cur; cur++; }
  }
  if (found == null) throw new Error(`added line not found: ${text}`);
  return found;
}

const manifest = [];
let n = 0;
for (const [repo, cfg] of Object.entries(REPOS)) {
  const dir = path.join(reposDir, repo);
  if (!fs.existsSync(dir)) { console.log(`skip ${repo}: not cloned in ${reposDir}`); continue; }
  if (git(dir, 'status', '--porcelain').trim()) throw new Error(`${repo} has local changes`);
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const r = rng(20261001 + repo.length);
  const files = shuffle(sourceFiles(dir, cfg), r).filter((f) => { const c = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length; return c >= 60 && c <= 500; });
  const plan = [...Array(PER_REPO_BUGS).fill(['bug', 'easy']), ...Array(PER_REPO_BUGS).fill(['bug', 'hard']), ...Array(PER_REPO_CLEAN).fill(['clean', null])];
  let fi = 0;
  for (const [kind, difficulty] of shuffle(plan, r)) {
    let made = null;
    while (!made && fi < files.length) {
      const file = files[fi++];
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      let rec = { op: null, before: null, after: null, line: null };
      if (kind === 'bug') {
        const ok = shuffle(candidates(lines, cfg.lang), r).find((c) => { const t = [...lines]; t[c.i] = c.after; return syntaxOk(cfg.lang, file, t.join('\n')); });
        if (!ok) continue;
        lines[ok.i] = ok.after;
        rec = { op: ok.op, before: ok.before.trim(), after: ok.after.trim(), line: ok.i + 1 };
        if (difficulty === 'hard') { const k = addComments(lines, cfg.lang, r, [ok.i]); if (k < 3) continue; }
      } else if (addComments(lines, cfg.lang, r, [], 3) < 3) continue;
      const id = `p${String(++n).padStart(2, '0')}`;
      git(dir, 'checkout', '-q', '-B', `bench/${id}`, base);
      fs.writeFileSync(path.join(dir, file), lines.join('\n'));
      git(dir, 'add', file);
      git(dir, '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', `chore: tidy ${path.basename(file)}`);
      const commit = git(dir, 'rev-parse', 'HEAD').trim();
      // The bug's real line in the new file comes from the diff (comments inserted above it shift it).
      if (kind === 'bug') rec.line = addedLine(dir, base, commit, rec.after);
      made = { id, repo, kind, difficulty, base, commit, file, ...rec };
      manifest.push(made);
    }
    if (!made) throw new Error(`not enough suitable files in ${repo}`);
  }
  git(dir, 'checkout', '-q', '--detach', base);
  console.log(`${repo}: ${manifest.filter((m) => m.repo === repo).length} packages`);
}
fs.writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest.json: ${manifest.length} packages (${manifest.filter((m) => m.kind === 'bug').length} bugs, ${manifest.filter((m) => m.kind === 'clean').length} clean)`);
