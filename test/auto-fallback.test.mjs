// autoFallback: with no fallback of yours, a run falls back to the other workers your config names (installed ones,
// cheapest first by `costs`), never to one you did not pick somewhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const meta = (s, r) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', RUN_ID.exec(r.stdout)[0], 'meta.json'), 'utf8'));
// qwen is named in the config but not installed here: its binary is a path that does not exist
const NO_QWEN = { PITROOM_QWEN_BIN: path.join(path.sep, 'nonexistent', 'qwen') };
const conf = {
  worker: 'opencode:mock/a#high',
  models: { opencode: 'mock/a' },
  tiers: { cheap: 'opencode:mock/b', review: 'opencode:mock/c', audit: 'qwen:qwen-coder', capable: 'opencode:mock/a#low' },
  costs: { 'opencode:mock/b': 2, 'opencode:mock/c': 0 },
};

test('autoFallback: the other workers the config names, installed, cheapest first; never the worker itself', () => {
  const s = sandbox();
  s.config({ ...conf, autoFallback: true });
  const r = s.run(['run', 'where is app.txt?'], { ...NO_QWEN, MOCK_FAIL_MODELS: 'mock/a#high', MOCK_EXPORT_MODEL: 'mock/c' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = meta(s, r);
  assert.deepEqual(m.fallback.map((t) => `${t.backend}:${t.model}`), ['opencode:mock/c', 'opencode:mock/b'], 'mock/c costs 0, mock/b 2; qwen is not installed; mock/a#low is the worker');
  assert.equal(m.ran.model, 'mock/c');
  assert.equal(m.attempts[0].target, 'opencode:mock/a#high');

  const doctor = s.run(['doctor'], NO_QWEN);
  assert.match(doctor.stdout, /worker chain: opencode:mock\/a#high → opencode:mock\/c → opencode:mock\/b \(fallbacks from "autoFallback"/);
});

test('autoFallback: off by default; your own fallback list and --no-fallback win', () => {
  const s = sandbox();
  s.config(conf);
  const off = s.run(['run', 'where is app.txt?'], { ...NO_QWEN, MOCK_FAIL_MODELS: 'mock/a#high' });
  assert.equal(off.status, 1, 'no fallback, none made up');
  assert.deepEqual(meta(s, off).fallback, []);

  s.config({ ...conf, autoFallback: true, fallback: ['opencode:mock/b'] });
  const own = s.run(['run', 'what is in app.txt?'], { ...NO_QWEN, MOCK_EXPORT_MODEL: 'mock/a' });
  assert.deepEqual(meta(s, own).fallback.map((t) => t.model), ['mock/b'], 'your list as it is');

  s.config({ ...conf, autoFallback: true });
  // a question no run answered yet: an answered one would come from the answer cache, with no worker run
  const none = s.run(['run', '--no-fallback', 'how long is app.txt?'], { ...NO_QWEN, MOCK_FAIL_MODELS: 'mock/a#high' });
  assert.equal(none.status, 1);
  assert.deepEqual(meta(s, none).fallback, []);
});
