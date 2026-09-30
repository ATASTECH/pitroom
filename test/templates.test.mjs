// Prompt templates shipped in the skills, and the structured lines of worker answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fill, loadTemplate, parseStatus, parseVerdict } from '../dist/lib.mjs';

const KEYS = {
  implementer: ['BRIEF', 'NOTES', 'PLAN_FILE', 'STEP', 'TITLE'],
  'task-reviewer': ['PACKAGE_FILE'],
  're-review': ['PACKAGE_FILE'],
  'code-reviewer': ['PACKAGE_FILE'],
};

test('templates: shipped in the skills, human header stripped, exactly the documented placeholders', () => {
  for (const [name, keys] of Object.entries(KEYS)) {
    const t = loadTemplate(name);
    assert.doesNotMatch(t, /^\s*<!--/, `${name}: header comment stripped`);
    assert.deepEqual([...new Set([...t.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort(), keys, name);
    assert.doesNotMatch(fill(t, Object.fromEntries(keys.map((k) => [k, `<${k}>`]))), /\{\{/, name);
  }
  assert.match(loadTemplate('implementer'), /STATUS: DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED/);
  for (const name of ['task-reviewer', 're-review', 'code-reviewer']) {
    assert.match(loadTemplate(name), /SUMMARY: SPEC: PASS\|FAIL · QUALITY: APPROVED\|NEEDS_FIXES · ISSUES: critical=N important=N minor=N/, name);
  }
});

test('fill: values are inserted literally and missing values are an error', () => {
  assert.equal(fill('a {{X}} b', { X: '$& {{Y}} $1' }), 'a $& {{Y}} $1 b');
  assert.throws(() => fill('{{X}} {{Y}}', { X: '1' }), /no value for template placeholder\(s\): Y/);
});

test('answers: STATUS line and review verdicts', () => {
  assert.equal(parseStatus('STATUS: DONE_WITH_CONCERNS\nSUMMARY: x'), 'DONE_WITH_CONCERNS');
  assert.equal(parseStatus('status: blocked'), 'BLOCKED');
  assert.equal(parseStatus('SUMMARY: done, no status line'), 'unknown');
  assert.equal(parseStatus('STATUS: FINISHED'), 'unknown');
  assert.deepEqual(parseVerdict('SUMMARY: SPEC: FAIL · QUALITY: NEEDS_FIXES · ISSUES: critical=1 important=2 minor=3'), {
    spec: 'fail', quality: 'needs-fixes', critical: 1, important: 2, minor: 3,
  });
  assert.deepEqual(parseVerdict('SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0'), {
    spec: 'pass', quality: 'approved', critical: 0, important: 0, minor: 0,
  });
  assert.deepEqual(parseVerdict('looks fine'), { spec: 'unknown', quality: 'unknown', critical: 0, important: 0, minor: 0 });
  const quoted = 'Last round: SPEC: FAIL · QUALITY: NEEDS_FIXES\n'
    + 'SUMMARY: SPEC: PASS · QUALITY: APPROVED · ISSUES: critical=0 important=0 minor=0\n'
    + 'DETAILS: fixed the critical=2 findings';
  assert.deepEqual(parseVerdict(quoted), { spec: 'pass', quality: 'approved', critical: 0, important: 0, minor: 0 },
    'every field comes from the SUMMARY line, never from verdicts quoted elsewhere');
});
