// A model that said "rate limited" is remembered for a while, so the next runs skip it while a fallback is left.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cooldownMs, retryAfterMs } from '../dist/lib.mjs';
import { sandbox } from './helpers.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const modelsCalled = (s) => s.calls().filter((c) => c.argv.includes('--model')).map((c) => c.argv[c.argv.indexOf('--model') + 1]);
const file = (s) => path.join(s.base, 'home', 'cooldowns.json');

test('cooldown: the wait comes from the provider\'s message, else from the kind of limit, within bounds', () => {
  assert.equal(retryAfterMs('Please retry in 4h28m23.8s.'), 4 * HOUR + 28 * MIN + 23_800);
  assert.equal(retryAfterMs('try again in 30 seconds'), 30_000);
  assert.equal(retryAfterMs('resets in 2 hours'), 2 * HOUR);
  assert.equal(retryAfterMs('nothing to see'), undefined);
  assert.equal(cooldownMs('Please retry in 2h.'), 2 * HOUR);
  assert.equal(cooldownMs('retry in 1s'), MIN, 'at least a minute');
  assert.equal(cooldownMs('retry in 9d'), 24 * HOUR, 'at most a day');
  assert.equal(cooldownMs('Rate limit exceeded: free-models-per-day'), 4 * HOUR, 'a daily quota: hours');
  assert.equal(cooldownMs('the model is overloaded'), 20 * MIN, 'overload: minutes');
});

test('cooldown: a rate-limited model is remembered, skipped by the next run, tried again once its time is up', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a', fallback: ['opencode:mock/b'] });
  const env = { MOCK_RATE_LIMIT_MODELS: 'mock/a' };
  const first = s.run(['run', 'where is app.txt?'], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /fallback: opencode:mock\/a failed/);
  assert.deepEqual(modelsCalled(s), ['mock/a', 'mock/b'], 'the first run tries a, which fails, then b');
  const saved = JSON.parse(fs.readFileSync(file(s), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['opencode:mock/a']);
  assert.ok(Date.parse(saved['opencode:mock/a'].until) - Date.now() > HOUR, 'two hours from the message');

  const second = s.run(['run', 'what is in app.txt?'], env);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /skipped: opencode:mock\/a \(cooling down until /);
  assert.deepEqual(modelsCalled(s), ['mock/a', 'mock/b', 'mock/b'], 'the second run goes straight to b');

  const list = s.run(['cooldown']).stdout;
  assert.match(list, /opencode:mock\/a/);
  assert.match(list, /Rate limit exceeded/);
  assert.match(s.run(['doctor']).stdout, /! opencode:mock\/a is cooling down until/);

  // time is up: tried again
  saved['opencode:mock/a'].until = new Date(Date.now() - MIN).toISOString();
  fs.writeFileSync(file(s), JSON.stringify(saved));
  const third = s.run(['run', 'again'], { MOCK_RATE_LIMIT_MODELS: '' });
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.deepEqual(modelsCalled(s).slice(3), ['mock/a'], 'a is the worker again');
  assert.doesNotMatch(third.stdout, /skipped:/);
});

test('cooldown: with no fallback left the model is tried anyway, and --clear forgets the cooldowns', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a', fallback: [] });
  const env = { MOCK_RATE_LIMIT_MODELS: 'mock/a' };
  assert.equal(s.run(['run', 'x'], env).status, 1, 'fails: nothing else to run');
  const again = s.run(['run', 'y'], { MOCK_RATE_LIMIT_MODELS: '' });
  assert.equal(again.status, 0, 'a model on cooldown is still tried when it is the only one');
  assert.deepEqual(modelsCalled(s), ['mock/a', 'mock/a']);
  assert.match(s.run(['cooldown', '--clear']).stdout, /cleared 1 cooldown/);
  assert.match(s.run(['cooldown']).stdout, /no model is cooling down/);
  assert.match(s.run(['cooldown', '--clear']).stdout, /no cooldowns/);
});

test('cooldown: errors that are not rate limits are not remembered', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/a', fallback: ['opencode:mock/b'] });
  const r = s.run(['run', 'x'], { MOCK_FAIL_MODELS: 'mock/a' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(file(s)) || Object.keys(JSON.parse(fs.readFileSync(file(s), 'utf8'))).length === 0, 'a missing model is not a cooldown');
});
