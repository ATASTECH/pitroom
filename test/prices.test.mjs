// The price catalog (config `priceFeed`): fetched from a public file, kept trimmed, refreshed in the background, only a
// fallback behind the user's own prices. A local server stands in for models.dev: nothing here touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { catalogPrice, readCatalog, trim } from '../dist/lib.mjs';
import { catalog } from './fixtures/prices/catalog.mjs';
import { root, sandbox, scratchDir } from './helpers.mjs';

const GEMINI_MOCK = path.join(root, 'test', 'fixtures', 'gemini', 'mock', 'gemini.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = /\d{8}-\d{6}-[0-9a-f]{4}/;

/** The stand-in for models.dev runs as a process of its own (see its fixture): spawnSync blocks this one while a CLI waits for it. */
async function feed() {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'prices', 'feed-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(String(d).trim()));
    child.once('exit', () => reject(new Error('the feed server did not start')));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/api.json`,
    hits: async () => Number(await (await fetch(`${base}/__hits`)).text()),
    setMode: async (mode) => void (await (await fetch(`${base}/__mode/${mode}`)).text()),
    close: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }),
  };
}
const files = (s) => ({ catalog: path.join(s.base, 'home', 'prices.json'), attempt: path.join(s.base, 'home', 'prices.attempt') });
const on = (f, extra = {}) => ({ PITROOM_PRICE_FEED: '1', PITROOM_PRICE_FEED_URL: f.url, ...extra });
const until = async (check, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (check()) return true;
  return false;
};

test('prices: trim keeps provider/model with input, output and cached input, and drops what has no usable cost', () => {
  const t = trim(catalog());
  assert.deepEqual(t['openai/gpt-test'], [2, 10, 0.5]);
  assert.deepEqual(t['reseller/only-here'], [7, 8, 0.7], 'a missing cached price is a tenth of the input price');
  assert.equal(t['google/free'], undefined, 'no cost at all');
  assert.equal(t['google/tiered'], undefined, 'a cost that is not numbers');
  // numbers from a server are checked like typed ones: 1e999 is Infinity in JSON, and a price is not negative
  const odd = trim({ p: { models: { huge: { cost: { input: Infinity, output: 1 } }, neg: { cost: { input: 1, output: -2 } }, nan: { cost: { input: NaN, output: 1 } }, fine: { cost: { input: 1, output: 2, cache_read: -1 } } } } });
  assert.deepEqual(Object.keys(odd), ['p/fine'], 'a bad input or output drops the model');
  assert.deepEqual(odd['p/fine'], [1, 2, 0.1], 'a bad cached price falls back to a tenth of the input price');
  assert.deepEqual(trim(null), {});
  assert.deepEqual(trim('x'), {});
});

test('prices: pitroom prices --refresh fetches the file once and keeps the trimmed copy', async () => {
  const f = await feed();
  try {
    const s = sandbox();
    const r = s.run(['prices', '--refresh'], on(f));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /price catalog updated: 15\d priced models/);
    assert.match(r.stdout, /price feed: on/);
    const saved = JSON.parse(fs.readFileSync(files(s).catalog, 'utf8'));
    assert.equal(saved.source, f.url);
    assert.deepEqual(saved.models['google/gemini-2.5-flash'], [0.3, 2.5, 0.03]);
    assert.equal(await f.hits(), 1);
    const json = JSON.parse(s.run(['prices', '--json'], on(f)).stdout);
    assert.equal(json.enabled, true);
    assert.ok(json.models >= 150 && json.ageHours < 1);
  } finally {
    await f.close();
  }
});

test('prices: a failed or tiny answer keeps the old catalog and is not retried within the hour', async () => {
  const f = await feed();
  try {
    const s = sandbox();
    assert.equal(s.run(['prices', '--refresh'], on(f)).status, 0);
    const before = fs.readFileSync(files(s).catalog, 'utf8');
    await f.setMode('error');
    const bad = s.run(['prices', '--refresh'], on(f));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /could not refresh the price catalog: HTTP 500/);
    assert.equal(fs.readFileSync(files(s).catalog, 'utf8'), before, 'the old copy stays');
    assert.match(fs.readFileSync(files(s).attempt, 'utf8'), /HTTP 500/);
    await f.setMode('small');
    const tiny = s.run(['prices', '--refresh'], on(f));
    assert.equal(tiny.status, 1);
    assert.match(tiny.stderr, /only 1 priced models in it/);
    assert.equal(fs.readFileSync(files(s).catalog, 'utf8'), before);
    // and doctor says the last refresh failed
    assert.match(s.run(['doctor'], on(f)).stdout, /! price catalog: \d+ priced models from .*; the last refresh failed \(only 1 priced models/);
  } finally {
    await f.close();
  }
});

test('prices: after a run the catalog is fetched in the background when due, once, and never when the feed is off', async () => {
  const f = await feed();
  try {
    const off = sandbox();
    assert.equal(off.run(['run', 'q'], { PITROOM_PRICE_FEED_URL: f.url }).status, 0);
    await sleep(1500);
    assert.equal(await f.hits(), 0, 'feed off: no request');
    const s = sandbox();
    assert.equal(s.run(['run', 'q'], on(f)).status, 0, 'the run itself does not wait for it');
    assert.ok(await until(() => fs.existsSync(files(s).catalog)), 'the catalog arrives after the run');
    assert.equal(await f.hits(), 1);
    assert.equal(s.run(['run', '--fresh', 'q2'], on(f)).status, 0);
    await sleep(1500);
    assert.equal(await f.hits(), 1, 'fresh enough (24 h): not fetched again');
  } finally {
    await f.close();
  }
});

test('prices: the vendor\'s own provider first, then any; provider/model ids as they are; #effort stripped', () => {
  const home = scratchDir('pitroom-prices-');
  const saved = { home: process.env.PITROOM_HOME, config: process.env.PITROOM_CONFIG };
  process.env.PITROOM_HOME = home;
  process.env.PITROOM_CONFIG = path.join(home, 'none.json');
  try {
    fs.writeFileSync(path.join(home, 'prices.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'test', models: trim(catalog()) }));
    assert.equal(readCatalog().source, 'test');
    assert.deepEqual(catalogPrice('codex', 'gpt-test'), { input: 2, output: 10, cachedInput: 0.5, key: 'openai/gpt-test' }, 'not the reseller (9)');
    assert.equal(catalogPrice('codex', 'gpt-test#high').key, 'openai/gpt-test');
    assert.equal(catalogPrice('claude', 'claude-test').input, 4);
    assert.equal(catalogPrice('opencode', 'reseller/gpt-test').input, 9, 'an id with its provider is taken as it is');
    assert.equal(catalogPrice('opencode', 'only-here').key, 'reseller/only-here', 'else any provider that has it');
    assert.equal(catalogPrice('codex', 'nothing', 'gpt-test').key, 'openai/gpt-test', 'the next model named is tried');
    assert.equal(catalogPrice('codex', 'nothing'), undefined);
    assert.equal(catalogPrice('codex', undefined), undefined);
  } finally {
    for (const [k, v] of [['PITROOM_HOME', saved.home], ['PITROOM_CONFIG', saved.config]]) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
});

test('prices: a run with no price of the user\'s gets the catalog\'s, marked so; their own price wins; the feed off, none', async () => {
  const f = await feed();
  try {
    const run = (s, config, env) => {
      s.config({ worker: 'gemini:gemini-3.8-flash', ...config });
      const r = s.run(['run', '--fresh', 'where is app.txt?'], { PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'k', ...env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const meta = JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', RUN.exec(r.stdout)[0], 'meta.json'), 'utf8'));
      return { out: r.stdout, usage: meta.usage };
    };
    const s = sandbox();
    assert.equal(s.run(['prices', '--refresh'], on(f)).status, 0);
    const fromCatalog = run(s, {}, on(f)); // the mock reports gemini-2.5-flash as the model that ran
    const u = fromCatalog.usage;
    assert.equal(u.costSource, 'catalog');
    assert.ok(Math.abs(u.costEstimate - (u.input * 0.3 + u.cacheRead * 0.03 + (u.output + u.reasoning) * 2.5) / 1e6) < 1e-12);
    // the test's catalog is a mirror (a local server): the receipt names that host, not models.dev
    assert.match(fromCatalog.out, /worker cost ~\$[\d.]+ \(estimated from 127\.0\.0\.1:\d+ prices\)/);
    const ledger = fs.readFileSync(path.join(s.base, 'home', 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual([ledger.at(-1).costEstimated, ledger.at(-1).costSource], [true, 'catalog'], 'the ledger says whose price it was');
    const own = run(s, { workerPrices: { 'gemini:gemini-2.5-flash': '5,50' } }, on(f));
    assert.equal(own.usage.costSource, 'config', 'the user\'s own price comes first');
    assert.match(own.out, /\(estimated from your workerPrices\)/);
    const feedOff = run(s, {}, { PITROOM_PRICE_FEED: '0' });
    assert.equal(feedOff.usage.costEstimate, undefined, 'a catalog on disk is not used while the feed is off');
    assert.match(feedOff.out, /worker cost n\/a/);
    // doctor: no warning that the cost is missing while the catalog prices it; pitroom prices lists the price in use
    const doctor = s.run(['doctor'], { ...on(f), PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'k' }).stdout;
    assert.doesNotMatch(doctor, /reports no cost/);
    assert.match(doctor, /✔ price catalog: 15\d priced models from /);
    const prices = s.run(['prices'], { ...on(f), PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'k' }).stdout;
    assert.match(prices, /gemini:gemini-3\.8-flash\s+in 0\.4 · out 3 · cached 0\.04 USD\/1M  \(price catalog 127\.0\.0\.1:\d+\)/);
  } finally {
    await f.close();
  }
});

test('prices: "primary" may be any model id of the catalog, for the savings comparison', async () => {
  const f = await feed();
  try {
    const s = sandbox();
    assert.equal(s.run(['prices', '--refresh'], on(f)).status, 0);
    const price = (env) => JSON.parse(s.run(['savings', '--json'], env).stdout).price;
    assert.deepEqual(price({ ...on(f), PITROOM_PRIMARY: 'claude-test' }), { name: 'claude-test', source: 'catalog', input: 4, output: 20, cachedInput: 0.4 });
    assert.equal(price({ PITROOM_PRIMARY: 'claude-test' }).name, 'Claude Sonnet', 'with the feed off an unknown name is the default preset');
    assert.equal(price({ ...on(f), PITROOM_PRIMARY: 'opus' }).name, 'Claude Opus', 'a preset name is still a preset');
  } finally {
    await f.close();
  }
});

test('prices: a mirror is named as the source, not models.dev, and a catalog file that is not one is not used', async () => {
  const f = await feed();
  try {
    const s = sandbox();
    assert.equal(s.run(['prices', '--refresh'], on(f)).status, 0);
    s.config({ worker: 'gemini:gemini-3.8-flash' });
    const r = s.run(['run', '--fresh', 'where is app.txt?'], { ...on(f), PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'k' });
    assert.match(r.stdout, /\(estimated from 127\.0\.0\.1:\d+ prices\)/, 'the host of the mirror, as the user set it');
    assert.doesNotMatch(r.stdout, /models\.dev/);
    // hand-edited into nonsense: ignored, and `pitroom prices` says there is no catalog rather than "NaN h ago"
    fs.writeFileSync(files(s).catalog, JSON.stringify({ fetchedAt: 'yesterday-ish', source: 'x', models: { 'a/b': [1, 2, 3] } }));
    const out = s.run(['prices'], on(f)).stdout;
    assert.match(out, /catalog:\s+none yet/);
    assert.doesNotMatch(out, /NaN/);
    // a triple with a bad number in an otherwise good file is skipped, not turned into $NaN
    fs.writeFileSync(files(s).catalog, JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'x', models: { 'google/gemini-3.8-flash': [1, 'x', 3] } }));
    const bad = s.run(['run', '--fresh', 'where is app.txt?'], { ...on(f), PITROOM_GEMINI_BIN: GEMINI_MOCK, GEMINI_API_KEY: 'k', PITROOM_PRICE_FEED_HOURS: '9999' });
    assert.match(bad.stdout, /worker cost n\/a/);
    assert.doesNotMatch(bad.stdout, /NaN|Infinity/);
  } finally {
    await f.close();
  }
});
