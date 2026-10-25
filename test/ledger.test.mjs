// The savings ledger: every finished run that reached the model is in it once, also when its process died before
// writing its own line, and a done run its CLI reported no steps for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;

const ledgerOf = (s) => {
  const f = path.join(s.base, 'home', 'ledger.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const writeLedger = (s, entries) => fs.writeFileSync(path.join(s.base, 'home', 'ledger.jsonl'), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
const metaFile = (s, id) => path.join(s.base, 'home', 'runs', id, 'meta.json');
const editMeta = (s, id, f) => fs.writeFileSync(metaFile(s, id), JSON.stringify(f(JSON.parse(fs.readFileSync(metaFile(s, id), 'utf8'))), null, 2));
// The run's process is gone: on Windows its id may already belong to another process (one of the tests running
// beside this one), which would read as a run still writing its own line.
const gone = (s, id) => editMeta(s, id, (m) => ({ ...m, pid: undefined }));

test('ledger: a run killed between its meta.json and its ledger line is recorded on the next look', () => {
  const s = sandbox();
  const r = s.run(['run', 'list the files']);
  assert.equal(r.status, 0, r.stderr);
  const id = RUN_ID.exec(r.stdout)[0];
  const line = ledgerOf(s).find((e) => e.id === id);
  assert.ok(line, 'the run wrote its own line');
  writeLedger(s, ledgerOf(s).filter((e) => e.id !== id)); // as if killed right after its final meta.json
  gone(s, id);

  assert.equal(s.run(['savings']).status, 0);
  const again = ledgerOf(s).filter((e) => e.id === id);
  assert.equal(again.length, 1, 'recorded once');
  assert.deepEqual(again[0], line, 'with the figures the run would have written');
  assert.equal(s.run(['savings']).status, 0);
  assert.equal(ledgerOf(s).filter((e) => e.id === id).length, 1, 'settling again adds nothing');
});

test('ledger: a done run with no steps counts; a failed one that never reached the model does not; audits stay out', () => {
  const s = sandbox();
  const done = RUN_ID.exec(s.run(['run', 'list the files']).stdout)[0];
  const failed = s.run(['run', '--no-fallback', 'x'], { MOCK_FAIL_MODELS: 'default' });
  assert.equal(failed.status, 1);
  const failedId = RUN_ID.exec(failed.stdout)[0];
  editMeta(s, done, (m) => ({ ...m, usage: { ...m.usage, steps: 0 }, pid: undefined }));
  editMeta(s, failedId, (m) => ({ ...m, usage: undefined, pid: undefined }));
  writeLedger(s, []);

  assert.equal(s.run(['savings']).status, 0);
  const ids = ledgerOf(s).map((e) => e.id);
  assert.ok(ids.includes(done), 'the done run with no steps is in the ledger');
  assert.ok(!ids.includes(failedId), 'the failed run that never reached the model is not');

  editMeta(s, done, (m) => ({ ...m, auditOf: 'someone' }));
  writeLedger(s, []);
  assert.equal(s.run(['savings']).status, 0);
  assert.ok(!ledgerOf(s).some((e) => e.id === done), 'an audit saved nothing');
});

test('ledger: a run in it twice (two processes settling at once) counts once', () => {
  const s = sandbox();
  assert.equal(s.run(['run', 'list the files']).status, 0);
  const [e] = ledgerOf(s);
  writeLedger(s, [{ ...e, saved: 2 }, { ...e, saved: 2 }]);
  assert.match(s.run(['savings']).stdout, /est\. saved\s+\$2\.00/);
});
