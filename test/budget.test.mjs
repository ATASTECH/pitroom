// The daily budget: once the workers' cost today reaches it, only free workers run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));

test('budget: near the daily budget a run warns; once it is spent only free workers run, and none is refused', () => {
  const s = sandbox();
  const conf = { worker: 'opencode:mock/good-model', fallback: ['opencode:mock/other'], budgetDaily: 1 };
  s.config(conf);
  const first = s.run(['run', 'question one'], { MOCK_COST: '0.85' });
  assert.equal(first.status, 0, first.stderr);
  const cost = meta(s, RUN_ID.exec(first.stdout)[0]).usage.cost;
  assert.ok(cost >= 0.8 && cost < 1, `one run costs ${cost}`);
  assert.doesNotMatch(first.stdout, /daily budget/, 'nothing spent before it: nothing to say');

  const second = s.run(['run', 'question two'], { MOCK_COST: '0.45' });
  assert.match(second.stdout, /the workers cost \$0\.8\d+ today, of your \$1\.00 daily budget/, 'past 80%: a warning');

  const refused = s.run(['run', 'question three'], { MOCK_COST: '0.45' });
  assert.equal(refused.status, 3, refused.stdout);
  assert.match(refused.stderr, /reaches your daily budget of \$1\.00 \("budgetDaily"\)/);
  assert.match(refused.stderr, /opencode:mock\/good-model, opencode:mock\/other are not known to be free/);

  // a price of 0 makes a worker free: the run goes to it, the paid one is left out
  s.config({ ...conf, workerPrices: { 'opencode:mock/other': '0,0' } });
  const free = s.run(['run', 'question four']);
  assert.equal(free.status, 0, free.stderr);
  assert.match(free.stdout, /the daily budget \(\$1\.00\) is spent \(\$\d\.\d+ today\): only the free workers run, 1 paid one left out/);
  const m = meta(s, RUN_ID.exec(free.stdout)[0]);
  assert.equal(m.worker.model, 'mock/other');
  assert.deepEqual(m.fallback, []);

  // no budget: no limit
  s.config({ worker: 'opencode:mock/good-model' });
  assert.equal(s.run(['run', 'question six'], { MOCK_COST: '0.45' }).status, 0);
  assert.equal(s.run(['config']).status, 0);
});

test('budget: 0 lets only free workers run, and a worker whose runs cost nothing is free without a price', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model' });
  assert.equal(s.run(['run', 'question one']).status, 0);
  s.config({ worker: 'opencode:mock/good-model', budgetDaily: 0 });
  const r = s.run(['run', 'question two']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the daily budget \(\$0\.000\) is spent \(\$0\.000 today\): only the free workers run/);
  assert.equal(s.run(['run', 'question three'], { MOCK_COST: '0.1' }).status, 0, 'it was free until now');
  assert.equal(s.run(['run', 'question four']).status, 3, 'its last run cost something: no longer free');
});

test('budget: PITROOM_BUDGET_DAILY sets it too, and an audit does not start once it is spent', async () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model', tiers: { audit: 'opencode:mock/other' } });
  const r = s.run(['run', 'what is in app.txt?'], { MOCK_COST: '2', PITROOM_BUDGET_DAILY: '1', PITROOM_AUDIT: '1' });
  assert.equal(r.status, 0, r.stderr);
  // the run itself was under the budget when it started; its audit is not, and mock/other has no known cost
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.audit, undefined, 'no audit over the budget');
  assert.equal(s.run(['run', 'again?'], { PITROOM_BUDGET_DAILY: '1' }).status, 3);
});

test('budget: a run that is still going counts with what it has used so far', async () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model', budgetDaily: 1 });
  // one step that costs 0.9, then it waits: still running when the next run asks
  const bg = s.run(['run', '--bg', 'long one'], { MOCK_ACTIONS: 'exec:true;sleep:20;answer:SUMMARY: late', MOCK_COST: '0.9' });
  const id = /run (\S+) in background/.exec(bg.stdout)[1];
  const events = path.join(s.base, 'home', 'runs', id, 'events.jsonl');
  for (let i = 0; i < 100 && !(fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('step_finish')); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    const next = s.run(['run', 'another question'], { MOCK_COST: '0.9' });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /the workers cost \$0\.9\d* today, of your \$1\.00 daily budget/, 'the running run\'s cost so far counts');
  } finally {
    s.run(['stop', id]);
  }
});
