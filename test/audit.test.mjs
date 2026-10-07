// Audits: another worker re-checks a finished read run's answer in the background.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { focusedRate, parseAudit } from '../dist/lib.mjs';
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

test('audit: the auditor is told to check the question\'s conditions, extra and missing items and counts, not only the references', () => {
  const s = sandbox();
  two(s);
  const id = RUN_ID.exec(s.run(['run', 'list the files under src/ only'], { MOCK_ACTIONS: `answer:${ANSWER}` }).stdout)[0];
  s.run(['audit', id, '-W', 'opencode:mock/other'], { MOCK_ACTIONS: 'answer:AUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  const prompt = s.calls().filter((c) => c.argv[0] === 'run').at(-1).argv.at(-1);
  assert.match(prompt, /every condition the question sets/);
  assert.match(prompt, /items that are missing and items that do not belong/);
  assert.match(prompt, /for a count, count again yourself/);
  assert.match(prompt, /QUESTION:\nlist the files under src\/ only/);
  // one reply form and no economy rule: the worker contract's own would contradict the audit's
  assert.match(prompt, /AUDIT: AGREE \| PARTIAL \| DISAGREE/);
  assert.match(prompt, /End with the reply form the task gives/);
  assert.doesNotMatch(prompt, /SUMMARY: 1-5 lines/);
  assert.doesNotMatch(prompt, /Be economical/);
  assert.doesNotMatch(prompt, /search the whole scope/);
});

test('audit: paths of the project in the answer reach the auditor as paths it can open from its own directory', () => {
  const s = sandbox();
  two(s);
  // a secret-looking file makes read runs (the audit's too) work in a clean snapshot, not in the project itself
  fs.writeFileSync(path.join(s.repo, '.env'), 'TOKEN=1\n');
  // and a sibling directory that merely starts like the project's must stay as it is
  const answer = `SUMMARY: app.txt holds line1 (${path.join(s.repo, 'app.txt')}:1); not ${s.repo}-other/x.ts:1`;
  const first = s.run(['run', 'what is in app.txt?'], { MOCK_ACTIONS: `answer:${answer}` });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, new RegExp(`${s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]app\\.txt:1`), 'the answer names the project path, as the user sees it');
  const id = RUN_ID.exec(first.stdout)[0];
  const r = s.run(['audit', id, '-W', 'opencode:mock/other'], { MOCK_ACTIONS: 'answer:AUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const prompt = s.calls().filter((c) => c.argv[0] === 'run').at(-1).argv.at(-1);
  assert.ok(prompt.includes('ANSWER TO AUDIT:'), 'it is the audit prompt');
  assert.ok(prompt.includes('app.txt holds line1 (app.txt:1)'), `the cited path is relative to the auditor's directory: ${prompt.slice(prompt.indexOf('ANSWER TO AUDIT:'))}`);
  assert.ok(prompt.includes(`${s.repo}-other/x.ts:1`), 'a path that only starts like the project directory is left alone');
  assert.ok(!prompt.replace(`${s.repo}-other`, '').includes(s.repo), 'the project directory itself is not in the answer the auditor reads');
});

test('audit: with auditFix, a disputed answer goes back to its worker as a follow-up, once; off by default', async () => {
  const s = sandbox();
  two(s);
  const off = s.run(['run', 'what is in app.txt?'], { PITROOM_AUDIT: '1', MOCK_ACTIONS: `answer:${DISAGREE}` });
  const offId = RUN_ID.exec(off.stdout)[0];
  assert.equal((await audited(s, offId)).fix, undefined, 'the default is no fix');

  const r = s.run(['run', 'what is in app.txt?'], { PITROOM_AUDIT: '1', PITROOM_AUDIT_FIX: '1', MOCK_ACTIONS: `answer:${DISAGREE}` });
  const id = RUN_ID.exec(r.stdout)[0];
  const a = await audited(s, id);
  assert.equal(a.verdict, 'disagree');
  assert.ok(a.fix, 'the audited run names its fix');
  const fix = meta(s, a.fix);
  assert.equal(fix.parent, id, 'a follow-up of the disputed run');
  assert.equal(fix.fixOf, id);
  assert.equal(fix.worker.model, 'mock/good-model', 'on the worker that answered, not the auditor');
  assert.match(fix.task, /disputed these claims:\n- app\.txt has two lines — it has one \(app\.txt:1\)/);
  assert.match(fix.task, /give your whole answer again/);
  // the fix's own audit (PITROOM_AUDIT=1) disputes it too, and no second fix starts: one round
  const fixAudit = await audited(s, a.fix);
  assert.equal(fixAudit.verdict, 'disagree');
  assert.equal(fixAudit.fix, undefined, 'a correction is never sent back again');
  // the correction's own process still records its run after its audit has ended: let it exit first
  for (const end = Date.now() + 30_000; meta(s, a.fix).pid && alive(meta(s, a.fix).pid) && Date.now() < end; ) await sleep(200);
  const show = s.run(['show', id]);
  assert.match(show.stdout, /── fix: the worker is correcting its answer as a follow-up \(pitroom show \d{8}-\d{6}-[0-9a-f]{4}\)/);
  assert.match(s.run(['show', a.fix]).stdout, new RegExp(`── correction: the answer of ${id}`));
});

test('audit: an agreeing audit sends nothing back', async () => {
  const s = sandbox();
  two(s);
  const r = s.run(['run', 'what is in app.txt?'], { PITROOM_AUDIT: '1', PITROOM_AUDIT_FIX: '1', MOCK_ACTIONS: 'answer:SUMMARY: ok\nAUDIT: AGREE\nCHECKED: 1\nDISPUTED:\n- (none)' });
  const a = await audited(s, RUN_ID.exec(r.stdout)[0]);
  assert.equal(a.verdict, 'agree');
  assert.equal(a.fix, undefined);
});

test('audit focus: list and count questions and disputed workers are audited more, confirmed ones less', () => {
  assert.deepEqual(focusedRate(0.1, 'where is login handled?'), { rate: 0.1, why: [] });
  const list = focusedRate(0.1, 'list every caller of login');
  assert.equal(list.rate, 0.2);
  assert.deepEqual(list.why, ['asks for a list or a count']);
  assert.equal(focusedRate(0.1, 'How many tests are there?').rate, 0.2);
  const bad = focusedRate(0.1, 'list the routes', { audited: 4, agreed: 1 });
  assert.equal(bad.rate, 0.4, 'both reasons: four times the rate');
  assert.match(bad.why[1], /confirmed 1 of 4 times/);
  assert.equal(focusedRate(0.1, 'where is x?', { audited: 2, agreed: 0 }).rate, 0.1, 'two audits say too little');
  assert.equal(focusedRate(0.1, 'where is x?', { audited: 6, agreed: 6 }).rate, 0.05, 'a confirmed worker is audited less');
  assert.equal(focusedRate(0.4, 'list all', { audited: 3, agreed: 0 }).rate, 1, 'never above 1');
  assert.equal(focusedRate(0, 'list all').rate, 0, 'off stays off');
  assert.equal(focusedRate(1, 'where?', { audited: 9, agreed: 9 }).rate, 1, 'always stays always');
});

test('audit focus: on, a list question gets the raised chance recorded on its run; --no-audit still wins', () => {
  const s = sandbox();
  // one worker, so no auditor: the chance is recorded before an auditor is picked, and no audit is left running in the
  // background when the test ends (it would still be writing into the directory the test removes)
  s.config({ worker: 'opencode:mock/good-model' });
  const r = s.run(['run', 'list every file'], { PITROOM_AUDIT: '0.3', PITROOM_AUDIT_FOCUS: '1', MOCK_ACTIONS: `answer:${ANSWER}` });
  const m = meta(s, RUN_ID.exec(r.stdout)[0]);
  assert.deepEqual(m.auditFocus, { rate: 0.6, why: ['asks for a list or a count'] });
  const off = s.run(['run', 'list every folder', '--no-audit'], { PITROOM_AUDIT: '0.3', PITROOM_AUDIT_FOCUS: '1', MOCK_ACTIONS: `answer:${ANSWER}` });
  const o = meta(s, RUN_ID.exec(off.stdout)[0]);
  assert.equal(o.auditFocus, undefined);
  assert.equal(o.audit, undefined);
  const plain = s.run(['run', 'list each test'], { PITROOM_AUDIT: '0.3', MOCK_ACTIONS: `answer:${ANSWER}` });
  assert.equal(meta(s, RUN_ID.exec(plain.stdout)[0]).auditFocus, undefined, 'off by default');
});
