// rankWorkers: the chain in the order of the workers' records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rankChain, scoreOf } from '../dist/lib.mjs';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const t = (model) => ({ backend: 'opencode', model });
const rec = (runs, ok, audited = 0, agreed = 0) => ({ runs, ok, audited, agreed });

test('rank: a score needs 5 runs; 3 audits or more weigh in', () => {
  assert.equal(scoreOf(undefined), undefined);
  assert.equal(scoreOf(rec(4, 4)), undefined, 'too few runs');
  assert.equal(scoreOf(rec(10, 8)), 0.8);
  assert.equal(scoreOf(rec(10, 8, 2, 0)), 0.8, 'two audits say too little');
  assert.equal(scoreOf(rec(10, 10, 4, 2)), 0.5);
});

test('rank: workers with a record trade places, best first; the others keep theirs; small gaps change nothing', () => {
  const a = t('a'), b = t('b'), c = t('c'), d = t('d');
  const records = { a: rec(10, 5), b: rec(1, 1), c: rec(10, 10), d: rec(20, 15) };
  const r = rankChain([a, b, c, d], (x) => records[x.model]);
  assert.deepEqual(r.chain.map((x) => x.model), ['c', 'b', 'd', 'a'], 'b has no record and stays second');
  assert.match(r.note, /ranked by record \("rankWorkers"\): opencode:c \(100%\) goes before opencode:a \(50%\)/);
  const close = rankChain([a, c], (x) => ({ a: rec(100, 96), c: rec(100, 99) })[x.model]);
  assert.deepEqual(close.chain.map((x) => x.model), ['a', 'c'], '96% and 99% are the same step');
  assert.equal(close.note, undefined);
  assert.deepEqual(rankChain([a], () => rec(9, 9)).chain, [a]);
});

test('rank: with rankWorkers on, a worker that keeps failing goes after one that does not; -W is never reordered', () => {
  const s = sandbox();
  const conf = { worker: 'opencode:mock/good-model', fallback: ['opencode:mock/other'] };
  s.config(conf);
  for (let i = 0; i < 5; i++) {
    assert.equal(s.run(['run', '-W', 'opencode:mock/other', `question ${i}`], { MOCK_EXPORT_MODEL: 'mock/other' }).status, 0);
    assert.equal(s.run(['run', '-W', 'opencode:mock/good-model', '--no-fallback', `failing ${i}`], { MOCK_FAIL_MODELS: 'mock/good-model' }).status, 1);
  }
  const plain = s.run(['run', 'off by default']);
  const meta = (r) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', RUN_ID.exec(r.stdout)[0], 'meta.json'), 'utf8'));
  assert.equal(meta(plain).worker.model, 'mock/good-model');

  s.config({ ...conf, rankWorkers: true });
  const ranked = s.run(['run', 'which worker now?'], { MOCK_EXPORT_MODEL: 'mock/other' });
  assert.equal(ranked.status, 0, ranked.stderr);
  const m = meta(ranked);
  assert.equal(m.worker.model, 'mock/other');
  assert.deepEqual(m.fallback.map((x) => x.model), ['mock/good-model']);
  assert.match(ranked.stdout, /ranked by record \("rankWorkers"\): opencode:mock\/other \(100%\) goes before opencode:mock\/good-model \(\d+%\)/);
  const named = s.run(['run', '-W', 'opencode:mock/good-model', 'named one']);
  assert.equal(meta(named).worker.model, 'mock/good-model', 'a worker you name is the one that runs');
});
