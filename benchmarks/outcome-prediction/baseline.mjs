#!/usr/bin/env node
// Can Pitroom tell, when a run starts, whether it will fail? Simple baselines on the exported history
// (export.mjs), before anything like a learned text classifier is worth trying.
//
// The runs are split by time: the older 70% to fit, the newer 30% to test, as a predictor would be used.
// Each predictor gives a probability; reported are accuracy (at 0.5), Brier score, calibration error (ECE,
// 10 bins) and AUC (how well it ranks failing runs above the others; 0.5 is chance).
//
//   node baseline.mjs [--data data/runs.jsonl] [--write]      --write also saves results/summary.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean));
const file = path.resolve(here, args.data ?? 'data/runs.jsonl');
if (!fs.existsSync(file)) {
  console.error(`no data at ${file}: run node export.mjs first`);
  process.exit(2);
}
const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── metrics ─────────────────────────────────────────────────────────────────────────────────────

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function metrics(ps, ys) {
  const acc = mean(ps.map((p, i) => ((p >= 0.5) === ys[i] ? 1 : 0)));
  const brier = mean(ps.map((p, i) => (p - (ys[i] ? 1 : 0)) ** 2));
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const idx = ps.map((p, i) => i).filter((i) => (b === 9 ? ps[i] >= 0.9 : ps[i] >= b / 10 && ps[i] < (b + 1) / 10));
    if (idx.length) ece += (idx.length / ps.length) * Math.abs(mean(idx.map((i) => ps[i])) - mean(idx.map((i) => (ys[i] ? 1 : 0))));
  }
  // AUC as the chance that a failing run gets a higher probability than a run that did not fail (ties count half)
  const pos = ps.filter((p, i) => ys[i]);
  const neg = ps.filter((p, i) => !ys[i]);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const auc = pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
  return { acc, brier, ece, auc };
}

// ── predictors: fit on train, return p(failed) for a row ────────────────────────────────────────

const smooth = (fails, n, prior, k = 2) => (fails + k * prior) / (n + k);
const recentlyFailed = (r) => r.recentFailures > 0;

const PREDICTORS = {
  'constant (base rate)': (train) => {
    const p = mean(train.map((r) => (r.y ? 1 : 0)));
    return () => p;
  },
  'per worker': (train) => {
    const p0 = mean(train.map((r) => (r.y ? 1 : 0)));
    const by = new Map();
    for (const r of train) {
      const s = by.get(r.worker) ?? { n: 0, f: 0 };
      s.n++;
      s.f += r.y ? 1 : 0;
      by.set(r.worker, s);
    }
    return (r) => {
      const s = by.get(r.worker);
      return s ? smooth(s.f, s.n, p0) : p0;
    };
  },
  'same worker failed in the last 30 min': (train) => {
    const p0 = mean(train.map((r) => (r.y ? 1 : 0)));
    const yes = train.filter(recentlyFailed);
    const no = train.filter((r) => !recentlyFailed(r));
    const pYes = smooth(yes.filter((r) => r.y).length, yes.length, p0);
    const pNo = smooth(no.filter((r) => r.y).length, no.length, p0);
    return (r) => (recentlyFailed(r) ? pYes : pNo);
  },
  'logistic regression (all features)': (train) => {
    const workers = [...new Set(train.map((r) => r.worker))];
    const modes = [...new Set(train.map((r) => r.mode))];
    const kinds = [...new Set(train.map((r) => r.kind))];
    const raw = (r) => [
      ...workers.map((w) => (r.worker === w ? 1 : 0)),
      ...modes.map((m) => (r.mode === m ? 1 : 0)),
      ...kinds.map((k) => (r.kind === k ? 1 : 0)),
      recentlyFailed(r) ? 1 : 0,
      Math.log1p(r.recentFailures),
      Math.log1p(r.recentRuns),
      Math.log1p(r.taskChars),
      r.inGroup ? 1 : 0,
    ];
    const X = train.map(raw);
    const d = X[0].length;
    // standardise each column on the training data
    const mu = Array.from({ length: d }, (_, j) => mean(X.map((x) => x[j])));
    const sd = Array.from({ length: d }, (_, j) => Math.sqrt(mean(X.map((x) => (x[j] - mu[j]) ** 2))) || 1);
    const z = (x) => x.map((v, j) => (v - mu[j]) / sd[j]);
    const Z = X.map(z);
    const y = train.map((r) => (r.y ? 1 : 0));
    const w = new Array(d).fill(0);
    let b = Math.log((mean(y) + 1e-6) / (1 - mean(y) + 1e-6));
    const sigmoid = (t) => 1 / (1 + Math.exp(-t));
    const lr = 0.1;
    const l2 = 0.01;
    for (let it = 0; it < 3000; it++) {
      const g = new Array(d).fill(0);
      let gb = 0;
      for (let i = 0; i < Z.length; i++) {
        const err = sigmoid(b + Z[i].reduce((s, v, j) => s + v * w[j], 0)) - y[i];
        for (let j = 0; j < d; j++) g[j] += err * Z[i][j];
        gb += err;
      }
      for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / Z.length + l2 * w[j]);
      b -= lr * (gb / Z.length);
    }
    return (r) => sigmoid(b + z(raw(r)).reduce((s, v, j) => s + v * w[j], 0));
  },
};

// ── experiments ─────────────────────────────────────────────────────────────────────────────────

function evaluate(name, rows, label) {
  const data = rows.map((r) => ({ ...r, y: label(r) }));
  const cut = Math.floor(data.length * 0.7);
  const train = data.slice(0, cut);
  const test = data.slice(cut);
  const pos = (xs) => xs.filter((r) => r.y).length;
  const lines = [`### ${name}`, '', `${data.length} runs; train ${train.length} (${pos(train)} positive, ${data[0]?.startedAt.slice(0, 10)} on), test ${test.length} (${pos(test)} positive, ${test[0]?.startedAt.slice(0, 10)} on)`, ''];
  if (pos(test) < 10 || pos(train) < 10) {
    lines.push(`Too few positive cases to evaluate (at least 10 in each part are needed).`, '');
    return lines;
  }
  lines.push('| Predictor | Accuracy | Brier | ECE | AUC |', '|---|---|---|---|---|');
  for (const [pname, fit] of Object.entries(PREDICTORS)) {
    const predict = fit(train);
    const m = metrics(test.map(predict), test.map((r) => r.y));
    lines.push(`| ${pname} | ${(m.acc * 100).toFixed(1)}% | ${m.brier.toFixed(3)} | ${m.ece.toFixed(3)} | ${Number.isNaN(m.auc) ? '-' : m.auc.toFixed(3)} |`);
  }
  lines.push('');
  return lines;
}

const usable = all.filter((r) => r.origin !== 'test' && r.state !== 'stopped');
const count = (f, xs = usable) => xs.filter(f).length;
const out = [
  '# Outcome prediction: results',
  '',
  `Data: ${all.length} runs exported, ${usable.length} used (Pitroom's own test sandboxes and stopped runs left out): ${count((r) => r.origin === 'real')} from real use, ${count((r) => r.origin === 'benchmark')} from benchmarks.`,
  '',
  ...evaluate('Will the run fail? (any cause)', usable, (r) => r.failed),
  ...evaluate('Will the run fail for a reason other than a rate limit or quota?', usable.filter((r) => r.cause !== 'rate-limit'), (r) => r.failed),
  ...evaluate('Will the run fail? (real use only)', usable.filter((r) => r.origin === 'real'), (r) => r.failed),
  '### Labels about the answer itself',
  '',
  `- Finished runs whose references could be checked with the current checker: ${count((r) => r.refsTotal !== null && !r.failed)}, of which ${count((r) => r.refsInvalid > 0 && !r.failed)} had a reference that did not check out.`,
  `- Audited runs: ${count((r) => r.audit)} (agree ${count((r) => r.audit === 'agree')}, partial ${count((r) => r.audit === 'partial')}, disagree ${count((r) => r.audit === 'disagree')}, unclear ${count((r) => r.audit === 'unclear')}).`,
  '',
];
const text = out.join('\n');
console.log(text);
if (args.write === 'true') {
  fs.mkdirSync(path.join(here, 'results'), { recursive: true });
  fs.writeFileSync(path.join(here, 'results', 'summary.md'), `${text}\n`);
  console.log(`saved ${path.join('results', 'summary.md')}`);
}
