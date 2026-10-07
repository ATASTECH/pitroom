// `pitroom eval`: questions with known answers, put to workers and scored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { answerParts, loadEval, pathsIn, scoreAnswer, summarize, truthOf } from '../dist/lib.mjs';
import { sandbox, scratchDir } from './helpers.mjs';

const q = (kind, truth, id = kind) => ({ id, task: 't', kind, truth });

test('eval: answers are scored like the multi-repo benchmark (exact line, exact count, F1 of a list)', () => {
  const def = { path: 'src/a.ts', line: 12 };
  assert.equal(scoreAnswer(q('definition'), def, 'SUMMARY: src/a.ts:12\nDETAILS: x').score, 1);
  assert.equal(scoreAnswer(q('definition'), def, 'SUMMARY: `src/a.ts:12`').score, 1, 'backticks are ignored');
  assert.equal(scoreAnswer(q('definition'), def, 'SUMMARY: src/a.ts:120').score, 0.5, 'another line of the right file');
  assert.equal(scoreAnswer(q('definition'), def, 'SUMMARY: lib/b.ts:12').score, 0);
  assert.equal(scoreAnswer(q('definition'), def, 'SUMMARY: /work/proj/src/a.ts:12', '/work/proj').score, 1, 'an absolute path under the root');

  assert.equal(scoreAnswer(q('count'), { count: 59 }, 'SUMMARY: 59\nDETAILS: counted with grep, 3 files').score, 1);
  assert.equal(scoreAnswer(q('count'), { count: 59 }, 'SUMMARY: about 40').score, 0);
  assert.equal(scoreAnswer(q('count'), { count: 1200 }, 'SUMMARY: 1,200').score, 1);
  assert.equal(scoreAnswer(q('count'), { count: 2 }, 'DETAILS: nothing').got, '(no number)');

  const set = { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] };
  const half = scoreAnswer(q('set'), set, 'SUMMARY: a.ts, b.ts');
  assert.equal(half.score, 2 / 3, 'precision 1, recall 0.5');
  assert.equal(half.got, '2/4 found, 0 extra');
  assert.equal(scoreAnswer(q('set'), set, 'SUMMARY: see below\nDETAILS: a.ts:1, b.ts:2, c.ts, d.ts, e.ts').score.toFixed(6), (8 / 9).toFixed(6), 'from DETAILS when SUMMARY names none');
  assert.equal(scoreAnswer(q('set'), { files: [] }, 'SUMMARY: none').score, 1, 'an empty list answered as none');
});

test('eval: the answer parts and the paths in them', () => {
  assert.deepEqual(answerParts('SUMMARY: 3 files\nmore\nDETAILS: a.ts:1\nOPEN ISSUES: none'), { summary: '3 files\nmore', details: 'a.ts:1' });
  assert.deepEqual(answerParts('just text'), { summary: 'just text', details: '' }, 'no labels: all of it');
  assert.deepEqual(pathsIn('src/a.ts:3, ./b/c.tsx and src\\d.py'), ['src/a.ts', 'b/c.tsx', 'src/d.py']);
});

test('eval: a questions file is checked, and a grep truth is looked up in the repository', () => {
  const dir = scratchDir('pitroom-eval-');
  const file = path.join(dir, 'q.json');
  const write = (o) => (fs.writeFileSync(file, JSON.stringify(o)), file);
  assert.throws(() => loadEval(write({})), /expected \{"questions"/);
  assert.throws(() => loadEval(write({ questions: [{ id: 'a', task: 'x', kind: 'guess', truth: 1 }] })), /kind must be one of/);
  assert.throws(() => loadEval(write({ questions: [{ id: 'a', task: 'x', kind: 'count', truth: 'many' }] })), /truth must be a whole number/);
  assert.throws(() => loadEval(write({ questions: [{ id: 'a', task: 'x', kind: 'count', truth: 1 }, { id: 'a', task: 'y', kind: 'count', truth: 2 }] })), /used twice/);
  const qs = loadEval(write({ questions: [{ task: ' how many? ', kind: 'count', truth: 2 }] }));
  assert.deepEqual(qs, [{ id: 'q1', task: 'how many?', kind: 'count', truth: 2 }]);

  const s = sandbox();
  assert.deepEqual(truthOf(q('count', { grep: 'keep' }), s.repo), { count: 1 });
  assert.deepEqual(truthOf(q('set', { grep: 'line1|keep', regex: true }), s.repo), { files: ['app.txt', 'other.txt'] });
  assert.deepEqual(truthOf(q('set', { grep: 'line1|keep', regex: true, exclude: '^other' }), s.repo), { files: ['app.txt'] });
  assert.deepEqual(truthOf(q('definition', { grep: 'line1' }), s.repo), { path: 'app.txt', line: 1 });
  assert.throws(() => truthOf(q('definition', { grep: 'nowhere-at-all' }), s.repo), /found no definition/);
  assert.throws(() => truthOf(q('count', { grep: 'x' }), undefined), /needs a git repository/);
  assert.deepEqual(truthOf(q('definition', './src/a.ts:7'), undefined), { path: 'src/a.ts', line: 7 });
});

test('eval: summarize ranks workers by score, then time', () => {
  const rows = [
    { question: 'a', kind: 'count', worker: 'w1', run: '1', state: 'done', score: 1, got: '', seconds: 9, tokens: 1000 },
    { question: 'b', kind: 'set', worker: 'w1', run: '2', state: 'done', score: 0.5, got: '', seconds: 3, tokens: 3000 },
    { question: 'a', kind: 'count', worker: 'w2', run: '3', state: 'failed', score: 0, got: '', seconds: 1 },
    { question: 'b', kind: 'set', worker: 'w2', run: '4', state: 'done', score: 1, got: '', seconds: 2 },
  ];
  const [first, second] = summarize(rows);
  assert.equal(first.worker, 'w1');
  assert.equal(first.score, 0.75);
  assert.deepEqual(first.byKind, { count: 1, set: 0.5 });
  assert.equal(first.medianSeconds, 9);
  assert.equal(second.failed, 1);
});

test('eval: `pitroom eval` puts every question to every worker as read runs of one group and scores them', () => {
  const s = sandbox();
  const file = path.join(s.base, 'questions.json');
  fs.writeFileSync(file, JSON.stringify({
    questions: [
      { id: 'count-keep', task: 'How many files contain keep? The SUMMARY line must be only the number.', kind: 'count', truth: { grep: 'keep' } },
      { id: 'list', task: 'List the files that contain line1 or keep.', kind: 'set', truth: ['app.txt', 'other.txt'] },
    ],
  }));
  const r = s.run(['eval', file, '-W', 'opencode:mock/good-model', '-W', 'opencode:mock/other', '--json', '-g', 'ev1'], { MOCK_ACTIONS: 'answer:SUMMARY: 1 file: app.txt\nDETAILS: app.txt:1' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.group, 'ev1');
  assert.deepEqual(out.truths['count-keep'], { count: 1 });
  assert.equal(out.rows.length, 4, '2 questions × 2 workers');
  const count = out.rows.find((x) => x.question === 'count-keep' && x.worker === 'opencode:mock/other');
  assert.equal(count.score, 1);
  const list = out.rows.find((x) => x.question === 'list');
  assert.equal(list.got, '1/2 found, 0 extra');
  assert.equal(list.score, 2 / 3);
  assert.deepEqual(out.summary.map((x) => x.score.toFixed(6)), [(5 / 6).toFixed(6), (5 / 6).toFixed(6)]);
  const calls = s.calls().filter((c) => c.argv[0] === 'run');
  assert.equal(calls.length, 4);
  assert.ok(calls.some((c) => c.argv.includes('mock/other')), 'each worker ran');
  const metas = out.rows.map((x) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', x.run, 'meta.json'), 'utf8')));
  assert.ok(metas.every((m) => m.mode === 'read' && m.group === 'ev1' && m.auditRate === 0 && m.fallback.length === 0), 'read runs, one group, no audit, no fallback');

  const text = s.run(['eval', file], { MOCK_ACTIONS: 'answer:SUMMARY: 1' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\| Worker \| Score \| Definition \| Count \| List \|/);
  assert.match(text.stdout, /100%  count-keep/);
  assert.equal(s.run(['eval']).status, 2);
  assert.equal(s.run(['eval', file, '-w']).status, 2);
});
