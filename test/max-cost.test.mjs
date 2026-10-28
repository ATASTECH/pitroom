// --max-cost: what one run's workers may cost. The worker is stopped when the run reaches it, no fallback spends
// past it, and what it changed until then stays in the run's changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
const workerCalls = (s) => s.calls().filter((c) => c.argv[0] === 'run');
// two steps of $0.50, then a pause long enough for the cap to be checked, then a third edit that must not happen
const SPENDY = { MOCK_COST: '0.5', MOCK_ACTIONS: 'append:app.txt:a;append:app.txt:b;sleep:5;append:app.txt:c;answer:SUMMARY: done' };

test('max cost: the worker is stopped at the cap, the run fails saying so, and its edits until then are kept', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/first', fallback: ['opencode:mock/backup'] });
  const r = s.run(['run', '-i', '--max-cost', '$1', 'change app.txt'], SPENDY);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /stopped at the run's cost cap: \$1\.00 of the \$1\.00 allowed \(--max-cost, "maxCost"\); what it changed until then is in the changes/);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.state, 'failed');
  assert.equal(m.capped, true);
  assert.equal(m.maxCost, 1);
  assert.equal(workerCalls(s).length, 1, 'no fallback spends past the cap');
  assert.equal(fs.readFileSync(path.join(m.worktree, 'app.txt'), 'utf8'), 'line1\na\nb\n');
  assert.deepEqual(m.changes.map((c) => c.path), ['app.txt']);
});

test('max cost: the config and the environment set it too; a run under it is not touched', () => {
  const s = sandbox();
  s.config({ maxCost: 1 });
  const capped = s.run(['run', '-i', 'change app.txt'], SPENDY);
  assert.equal(capped.status, 1, capped.stdout);
  assert.match(capped.stdout, /stopped at the run's cost cap/);
  s.config({});
  const env = s.run(['run', '-i', 'change app.txt'], { ...SPENDY, PITROOM_MAX_COST: '0.9' });
  assert.equal(env.status, 1, env.stdout);
  assert.match(env.stdout, /\$1\.00 of the \$0\.900 allowed/);
  const under = s.run(['run', '--max-cost', '5', 'what is in app.txt?'], { MOCK_COST: '0.5', MOCK_ACTIONS: 'answer:SUMMARY: line1' });
  assert.equal(under.status, 0, under.stdout + under.stderr);
  assert.doesNotMatch(under.stdout, /cost cap/);
  assert.equal(meta(s, RUN_ID.exec(under.stdout)[0]).capped, undefined);
});

test('max cost: --max-cost takes an amount above 0', () => {
  const s = sandbox();
  for (const v of ['0', 'abc', '-1']) {
    const r = s.run(['run', '--max-cost', v, 'q']);
    assert.equal(r.status, 2, v);
    assert.match(r.stderr, /--max-cost takes an amount in USD above 0/);
  }
  assert.equal(workerCalls(s).length, 0);
});
