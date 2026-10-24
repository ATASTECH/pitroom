// A worker that hits a limit part way (a plan's usage limit, a used-up quota) hands the task over to the next one
// instead of failing the run: an edit carries on in the same tree, told what was already changed; a read starts over.
// Audits fall back to the other auditors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
const prompts = (s, model) => s.calls().filter((c) => c.argv[c.argv.indexOf('--model') + 1] === model).map((c) => c.argv.at(-1));
const LIMIT = { MOCK_LIMIT_PART_WAY_MODELS: 'mock/first', MOCK_COST: '0.5' };

test('handover: an isolated edit a limit stops part way is finished by the next worker, which is told what changed', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/first', fallback: ['opencode:mock/backup'] });
  const r = s.run(['run', '-i', 'change app.txt'], { ...LIMIT, MOCK_ACTIONS: 'write:app.txt:half done;answer:SUMMARY: app.txt changed' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.state, 'done');
  assert.equal(m.ran.model, 'mock/backup');
  assert.equal(m.attempts.length, 1);
  assert.equal(m.attempts[0].partial, true);
  assert.match(m.attempts[0].error, /usage limit/);
  assert.match(r.stdout, /mock\/first hit a limit part way and handed the task over/);

  const [first] = prompts(s, 'mock/first');
  const [second] = prompts(s, 'mock/backup');
  assert.doesNotMatch(first, /Another worker started this task/);
  assert.match(second, /Another worker started this task and stopped part way, at its usage limit\. Its edits are already in the files: app\.txt\. Do not start over/);
  assert.deepEqual(m.changes.map((c) => c.path), ['app.txt']);

  // both workers' steps and costs are the run's: one step before the limit, two after (the write and the answer)
  assert.equal(m.priorUsage.steps, 1);
  assert.equal(m.usage.steps, 3);
  assert.ok(Math.abs(m.usage.cost - 1.5) < 1e-9, `cost ${m.usage.cost}`);
  const ledger = fs.readFileSync(path.join(s.base, 'home', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(Math.abs(ledger.find((e) => e.id === m.id).workerCost - 1.5) < 1e-9, 'the ledger counts what both cost');

  // the limit is remembered until the time the provider named, so the next run goes straight to the backup
  const cooldowns = JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'cooldowns.json'), 'utf8'));
  assert.ok(Date.parse(cooldowns['opencode:mock/first'].until) - Date.now() > 0);
});

test('handover: a read a limit stops part way starts over on the next worker, without an edit note', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/first', fallback: ['opencode:mock/backup'] });
  const r = s.run(['run', 'where is app.txt?'], { ...LIMIT, MOCK_ACTIONS: 'exec:cat app.txt;answer:SUMMARY: app.txt holds line1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.state, 'done');
  assert.equal(m.attempts[0].partial, true);
  assert.equal(m.handoff, undefined);
  assert.doesNotMatch(prompts(s, 'mock/backup')[0], /Another worker/);
  assert.match(fs.readFileSync(path.join(s.base, 'home', 'runs', m.id, 'summary.md'), 'utf8'), /app\.txt holds line1/);
});

test('handover: with no fallback left a limit part way still fails the run, as before', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/first' });
  const r = s.run(['run', '-i', 'change app.txt'], { ...LIMIT, MOCK_ACTIONS: 'write:app.txt:half done;answer:SUMMARY: done' });
  assert.equal(r.status, 1);
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(m.failureKind, 'rate-limited');
  assert.equal(m.attempts, undefined);
});

test('handover: an audit whose auditor hit a limit falls back to the next auditor, never to the worker audited', async () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model', fallback: ['opencode:mock/good-model#high', 'opencode:mock/backup'], tiers: { audit: 'opencode:mock/auditor' } });
  const r = s.run(['run', 'what is in app.txt?'], { PITROOM_AUDIT: '1', MOCK_RATE_LIMIT_MODELS: 'mock/auditor', MOCK_ACTIONS: 'answer:SUMMARY: app.txt holds line1\nAUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  assert.equal(r.status, 0, r.stderr);
  const id = RUN_ID.exec(r.stdout)[0];
  let a;
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(200)) {
    a = meta(s, id).audit;
    if (a && a.state !== 'running' && a.state !== 'queued') break;
  }
  const audit = meta(s, a.id);
  assert.equal(a.state, 'done', JSON.stringify(audit.attempts));
  assert.equal(audit.ran.model, 'mock/backup', 'the next auditor; the audited model at another effort is not one');
  assert.deepEqual(audit.fallback.map((t) => t.model), ['mock/backup']);
  for (const end = Date.now() + 10_000; Date.now() < end && audit.pid; await sleep(100)) {
    try {
      process.kill(audit.pid, 0);
    } catch {
      break;
    }
  }
});
