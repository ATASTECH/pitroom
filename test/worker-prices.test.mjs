// `workerPrices`: USD per 1M tokens of a worker model, for the CLIs that report no cost (Codex, Gemini). Without a price a
// run's cost is "n/a" and counts as free in the savings; with one it is estimated, and said to be.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { costAt, parsePriceSpec, workerCostOf } from '../dist/lib.mjs';
import { root, sandbox } from './helpers.mjs';

const GEMINI_MOCK = path.join(root, 'test', 'fixtures', 'gemini', 'mock', 'gemini.mjs');
const RUN = /\d{8}-\d{6}-[0-9a-f]{4}/;
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
/** One Gemini run (the mock: tokens only, no cost) under a config; the model it reports is gemini-2.5-flash, the one asked for gemini-3.8-flash. */
function ask(s, config) {
  s.config({ worker: 'gemini:gemini-3.8-flash', ...config });
  // --fresh: the same question on the same code would otherwise be answered from the cache, with the earlier run
  const r = s.run(['run', '--fresh', 'where is app.txt?'], { PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'test-key' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { out: r.stdout, id: RUN.exec(r.stdout)[0] };
}

test('workerPrices: "in,out[,cachedIn]" is parsed, anything else is not a price', () => {
  assert.deepEqual(parsePriceSpec('2,10,0.5', 'k'), { name: 'k', input: 2, output: 10, cachedInput: 0.5 });
  assert.equal(parsePriceSpec('2,10', 'k').cachedInput, 0.2, 'the cached price defaults to a tenth of the input price');
  for (const bad of ['', 'abc', '2', '1,2,3,4', '-1,5', '1,x', 5, undefined, null]) assert.equal(parsePriceSpec(bad), undefined, String(bad));
});

test('workerPrices: the cost is what the tokens cost at the price; a reported cost wins over an estimate', () => {
  const usage = { input: 1_000_000, output: 100_000, reasoning: 50_000, cacheRead: 2_000_000 };
  assert.equal(costAt(usage, { input: 2, output: 10, cachedInput: 0.5 }), 2 + 1.5 + 1, '1M in + 150k out/reasoning + 2M cached');
  assert.equal(workerCostOf({ ...usage, cost: 0.1, costEstimate: 9 }), 0.1);
  assert.equal(workerCostOf({ ...usage, costEstimate: 9 }), 9);
  assert.equal(workerCostOf({ ...usage }), undefined);
  assert.equal(workerCostOf(undefined), undefined);
});

test('workerPrices: no price, no estimate: the receipt says n/a, and doctor says the savings are overstated', () => {
  const s = sandbox();
  const { out, id } = ask(s, {});
  assert.match(out, /worker cost n\/a/);
  assert.equal(meta(s, id).usage.costEstimate, undefined);
  const ledger = fs.readFileSync(path.join(s.base, 'home', 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([ledger[0].workerCost, ledger[0].costEstimated], [0, undefined]);
  const doctor = s.run(['doctor'], { PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'test-key' }).stdout;
  assert.match(doctor, /! gemini:gemini-3\.8-flash reports no cost, so its runs count as free in the savings: give its price in the config, "workerPrices": \{"gemini:gemini-3\.8-flash": "<in>,<out>\[,<cachedIn>\]"\} \(USD per 1M tokens\)/);
});

test('workerPrices: with a price the cost is estimated, said to be, kept in the ledger and taken off the savings', () => {
  const s = sandbox();
  const plain = ask(s, {});
  const priced = ask(s, { workerPrices: { 'gemini:gemini-2.5-flash': '2,10,0.5' } }); // the model that ran
  const u = meta(s, priced.id).usage;
  const expected = (u.input * 2 + u.cacheRead * 0.5 + (u.output + u.reasoning) * 10) / 1e6;
  assert.ok(expected > 0 && u.costEstimate > 0);
  assert.ok(Math.abs(u.costEstimate - expected) < 1e-12, `${u.costEstimate} vs ${expected}`);
  assert.equal(u.cost, undefined, 'the estimate is kept apart from a reported cost');
  assert.match(priced.out, new RegExp(`worker cost ~\\$[\\d.]+ \\(estimated from your workerPrices\\)`));
  assert.ok(meta(s, priced.id).savedUsd < meta(s, plain.id).savedUsd, 'a worker that is not free saves less');
  const ledger = fs.readFileSync(path.join(s.base, 'home', 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const last = ledger.at(-1);
  assert.equal(last.workerCost, u.costEstimate);
  assert.equal(last.costEstimated, true);
  // the same price under the model that was asked for, and under the backend alone, is found too
  for (const key of ['gemini:gemini-3.8-flash', 'gemini']) {
    const t = sandbox();
    const r = ask(t, { workerPrices: { [key]: '2,10,0.5' } });
    assert.ok(meta(t, r.id).usage.costEstimate > 0, key);
  }
  // an unusable price is ignored, not an error
  const bad = sandbox();
  const b = ask(bad, { workerPrices: { 'gemini:gemini-2.5-flash': 'cheap' } });
  assert.equal(meta(bad, b.id).usage.costEstimate, undefined);
  assert.match(b.out, /worker cost n\/a/);
});

test('workerPrices: doctor stops warning once the price is given', () => {
  const s = sandbox();
  s.config({ worker: 'gemini:gemini-3.8-flash', workerPrices: { gemini: '1,5' } });
  const doctor = s.run(['doctor'], { PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'test-key' }).stdout;
  assert.doesNotMatch(doctor, /reports no cost/);
});

test('workerPrices: a target that names no model gets the backend alone as the suggested key', () => {
  const s = sandbox();
  s.config({ worker: 'gemini' });
  const doctor = s.run(['doctor'], { PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'test-key' }).stdout;
  assert.match(doctor, /! gemini reports no cost, so its runs count as free in the savings: give its price in the config, "workerPrices": \{"gemini": /);
});
