// Audits: another worker re-checks a finished read run's answer in the background.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseAudit } from '../dist/lib.mjs';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWER = 'SUMMARY: app.txt holds line1';
const DISAGREE = `${ANSWER}\nAUDIT: DISAGREE\nCHECKED: 2\nDISPUTED:\n- app.txt has two lines — it has one (app.txt:1)`;
const meta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8'));
const runIds = (s) => fs.readdirSync(path.join(s.base, 'home', 'runs')).filter((d) => RUN_ID.test(d));
/** Waits for the audit that started from this run to end. */
async function audited(s, id) {
  const end = Date.now() + 30_000;
  for (;;) {
    const a = meta(s, id).audit;
    if (a && a.state !== 'running' && a.state !== 'queued') {
      // the audit process still compacts files after it has written the verdict: wait for it to exit
      // before the test directory is removed
      const pid = meta(s, a.id).pid;
      if (!pid || !alive(pid)) return a;
    }
    if (Date.now() > end) assert.fail(`the audit of ${id} did not finish: ${JSON.stringify(a)}`);
    await sleep(200);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const two = (s) => s.config({ worker: 'opencode:mock/good-model', tiers: { audit: 'opencode:mock/other' } });

test('audit: the verdict line and the disputed claims are read from the auditor\'s answer', () => {
  assert.deepEqual(parseAudit('AUDIT: AGREE\nCHECKED: 3\nDISPUTED:\n- (none)'), { verdict: 'agree', disputed: [] });
  assert.deepEqual(parseAudit(DISAGREE), { verdict: 'disagree', disputed: ['app.txt has two lines — it has one (app.txt:1)'] });
  assert.equal(parseAudit('audit: partial\nDISPUTED:\n* a claim\n* another').disputed.length, 2);
  assert.deepEqual(parseAudit('I looked and it seems fine.'), { verdict: 'unclear', disputed: [] });
});

test('audit: off unless asked; PITROOM_AUDIT=1 audits a read run on another worker and keeps its verdict', async () => {
  const s = sandbox();
  two(s);
  const plain = s.run(['run', 'where is app.txt?'], { MOCK_ACTIONS: `answer:${ANSWER}` });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(meta(s, RUN_ID.exec(plain.stdout)[0]).audit, undefined, 'the default is no audit');
  assert.equal(runIds(s).length, 1);

  const r = s.run(['run', 'what is in app.txt?'], { PITROOM_AUDIT: '1', MOCK_ACTIONS: `answer:${DISAGREE}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /── audit: another worker is re-checking this answer in the background/);
  const id = RUN_ID.exec(r.stdout)[0];
  const a = await audited(s, id);
  assert.equal(a.state, 'done');
  assert.equal(a.verdict, 'disagree');
  assert.deepEqual(a.disputed, ['app.txt has two lines — it has one (app.txt:1)']);

  const audit = meta(s, a.id);
  assert.equal(audit.auditOf, id);
  assert.equal(audit.mode, 'read');
  assert.equal(audit.worker.model, 'mock/other', 'not the model that answered');
  assert.match(audit.task, /QUESTION:\nwhat is in app\.txt\?/);
  assert.match(audit.task, /ANSWER TO AUDIT:\nSUMMARY: app\.txt holds line1/);
  const ran = s.calls().filter((c) => c.argv.includes('--model') && c.argv[c.argv.indexOf('--model') + 1] === 'mock/other');
  assert.ok(ran.length >= 1, 'the auditor ran with its own model');
  assert.equal(audit.savedUsd, 0, 'an audit saves nothing');
  const ledger = fs.readFileSync(path.join(s.base, 'home', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!ledger.some((e) => e.id === a.id), 'and is not in the savings ledger');
  assert.equal(runIds(s).length, 3, 'an audit is not audited again');

  const stats = JSON.parse(s.run(['history', 'stats', '--json']).stdout);
  assert.equal(stats.totals.runs, 2, 'audits are not counted as runs');
  assert.equal(stats.audits.runs, 1);
  assert.equal(stats.audits.disagree, 1);
  const row = stats.byWorker.find((w) => w.audited);
  assert.ok(row, 'the audited worker has its count');
  assert.deepEqual([row.audited, row.agreed], [1, 0]);

  const show = s.run(['show', id]);
  assert.match(show.stdout, /── audit \(run \d{8}-\d{6}-[0-9a-f]{4}\): DISAGREE/);
  assert.match(show.stdout, /disputed: app\.txt has two lines/);
});

test('audit: --no-audit wins over the config, and only read runs are audited', async () => {
  const s = sandbox();
  two(s);
  const skipped = s.run(['run', '--no-audit', 'where is app.txt?'], { PITROOM_AUDIT: '1', MOCK_ACTIONS: `answer:${ANSWER}` });
  assert.equal(meta(s, RUN_ID.exec(skipped.stdout)[0]).audit, undefined);
  const change = s.run(['run', '--isolate', 'extend app'], { PITROOM_AUDIT: '1', MOCK_ACTIONS: 'append:app.txt:more;answer:SUMMARY: done' });
  assert.equal(change.status, 0, change.stderr);
  assert.equal(meta(s, RUN_ID.exec(change.stdout)[0]).audit, undefined, 'a change is reviewed, not audited');
  assert.equal(s.run(['run', '--audit', '-i', 'x']).status, 2, '--audit goes with read runs');
  await sleep(500);
  assert.equal(runIds(s).length, 2);
});

test('audit: with no other worker to ask nothing starts, and `pitroom audit` says so', () => {
  const s = sandbox();
  s.config({ worker: 'opencode:mock/good-model' });
  const r = s.run(['run', 'where is app.txt?'], { PITROOM_AUDIT: '1', MOCK_ACTIONS: `answer:${ANSWER}` });
  const id = RUN_ID.exec(r.stdout)[0];
  assert.equal(meta(s, id).audit, undefined, 'the only worker would grade itself');
  const a = s.run(['audit', id]);
  assert.equal(a.status, 3);
  assert.match(a.stderr, /no other worker to audit with/);
});

test('audit: `pitroom audit RUN -W` audits at once and prints the verdict; changes and audits are refused', () => {
  const s = sandbox();
  two(s);
  const r = s.run(['run', 'where is app.txt?'], { MOCK_ACTIONS: `answer:${ANSWER}` });
  const id = RUN_ID.exec(r.stdout)[0];
  const a = s.run(['audit', id, '-W', 'opencode:mock/other'], { MOCK_ACTIONS: 'answer:AUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /── audit of \d{8}-\d{6}-[0-9a-f]{4}: AGREE/);
  const auditId = RUN_ID.exec(a.stdout)[0];
  assert.equal(meta(s, id).audit.verdict, 'agree', 'the audited run carries the verdict');
  assert.match(s.run(['audit', auditId]).stderr, /is itself an? audit/);
  const change = s.run(['run', '--isolate', 'extend'], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: ok' });
  assert.match(s.run(['audit', RUN_ID.exec(change.stdout)[0]]).stderr, /changed files/);
  assert.equal(s.run(['audit']).status, 2);
});
