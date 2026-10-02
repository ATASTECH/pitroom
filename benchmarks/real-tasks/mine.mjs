#!/usr/bin/env node
// Lists candidate tasks in a repository's history: small commits that change source AND tests.
// The commit message is the task text; the commit's test changes are the hidden judge.
//
//   node mine.mjs --repo ~/workspace/pitroom --src '^src/' --test '^test/.*\.mjs$' [--max-src 120] [--limit 60]
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const repo = path.resolve((args.repo ?? '.').replace(/^~/, os.homedir()));
const srcRe = new RegExp(args.src ?? '^src/'), testRe = new RegExp(args.test ?? '^test/');
const maxSrc = Number(args['max-src'] ?? 120), minSrc = Number(args['min-src'] ?? 6), limit = Number(args.limit ?? 80);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });

const out = [];
for (const sha of git('log', '--no-merges', '--format=%H', `-${limit}`).split('\n').filter(Boolean)) {
  const files = git('show', '--numstat', '--format=', sha).split('\n').filter(Boolean).map((l) => { const [a, d, f] = l.split('\t'); return { f, n: Number(a) + Number(d) || 0 }; });
  const src = files.filter((x) => srcRe.test(x.f)), test = files.filter((x) => testRe.test(x.f));
  const srcLines = src.reduce((a, x) => a + x.n, 0), testLines = test.reduce((a, x) => a + x.n, 0);
  if (!src.length || !test.length || srcLines > maxSrc || srcLines < minSrc || files.length - src.length - test.length > 3) continue;
  out.push({ sha: sha.slice(0, 9), srcFiles: src.length, srcLines, testFiles: test.map((x) => x.f), testLines, subject: git('log', '-1', '--format=%s', sha).trim() });
}
for (const o of out) console.log(`${o.sha} src ${o.srcFiles} files/${o.srcLines} lines, tests ${o.testFiles.length} files/${o.testLines} lines  ${o.subject.slice(0, 80)}`);
console.error(`${out.length} candidates`);
