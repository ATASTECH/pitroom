// End-to-end tests against the built CLI with a fake `opencode` (test/fixtures/opencode).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

test('read mode returns the answer, a receipt, and touches nothing', () => {
  const s = sandbox();
  const before = s.status();
  const r = s.run(['run', 'where is login handled?'], { MOCK_ACTIONS: 'answer:SUMMARY: login is in auth.ts:12' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pitroom ✔ done · read/);
  assert.match(r.stdout, /SUMMARY: login is in auth.ts:12/);
  assert.match(r.stdout, /receipt: worker processed 10\.5k tokens/);
  assert.match(r.stdout, /model mock\/good-model/);
  assert.equal(s.status(), before);
  const call = s.calls().find((c) => c.argv[0] === 'run');
  assert.equal(call.argv[call.argv.indexOf('--agent') + 1], 'pitroom-read');
  assert.equal(call.active, '1');
  assert.notEqual(call.stdin, 'pipe', 'stdin must not be an open pipe');
  const cfg = JSON.parse(call.config);
  assert.equal(cfg.agent['pitroom-read'].permission.edit, 'deny');
  assert.equal(cfg.agent['pitroom-read'].model, undefined, 'model is never hardcoded');
});

test('no permission rule is ever "ask" (non-interactive runs would stall)', () => {
  const s = sandbox();
  s.run(['run', 'x']);
  const cfg = s.calls().find((c) => c.argv[0] === 'run').config;
  assert.ok(!cfg.includes('"ask"'));
  const perm = JSON.parse(cfg).agent['pitroom-write'].permission;
  for (const p of ['git push*', 'git reset*', 'git checkout*', 'git stash*', 'git clean*', 'rm -rf*']) {
    assert.equal(perm.bash[p], 'deny', p);
  }
  assert.equal(perm.read['*.env'], 'deny');
  assert.equal(perm.task, 'deny');
});

test('web tools are off unless --web is passed', () => {
  const s = sandbox();
  s.run(['run', 'x']);
  s.run(['run', '--web', 'y']);
  const [off, on] = s.calls().filter((c) => c.argv[0] === 'run').map((c) => JSON.parse(c.config).agent['pitroom-read'].permission);
  assert.equal(off.webfetch, 'deny');
  assert.equal(on.webfetch, 'allow');
});

test('existing OPENCODE_CONFIG_CONTENT is merged, not replaced', () => {
  const s = sandbox();
  s.run(['run', 'x'], { OPENCODE_CONFIG_CONTENT: '{"theme":"mine","agent":{"custom":{"mode":"primary"}}}' });
  const cfg = JSON.parse(s.calls().find((c) => c.argv[0] === 'run').config);
  assert.equal(cfg.theme, 'mine');
  assert.ok(cfg.agent.custom && cfg.agent['pitroom-read']);
});

test('write mode reports only the worker changes and revert restores exactly', () => {
  const s = sandbox();
  const r = s.run(['run', '--write', 'add line2'], { MOCK_ACTIONS: 'append:app.txt:line2;answer:SUMMARY: done' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changes \(in your working tree\): 1 files, \+1 −0/);
  assert.match(r.stdout, /M app\.txt/);
  assert.doesNotMatch(r.stdout, /other\.txt|untracked\.txt/, 'user wip is not attributed to the worker');
  assert.equal(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), 'line1\nline2\n');
  const id = /run (\S+)/.exec(r.stdout)[1];
  const u = s.run(['revert', id]);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.readFileSync(path.join(s.repo, 'app.txt'), 'utf8'), 'line1\n');
  assert.equal(fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8'), 'keep\nuser wip\n');
  assert.equal(fs.readFileSync(path.join(s.repo, 'untracked.txt'), 'utf8'), 'draft\n');
  assert.doesNotMatch(s.git('status', '--porcelain'), /^A /m, 'the user index is untouched');
});

test('isolate mode works on a copy of the current dirty state and applies cleanly', () => {
  const s = sandbox();
  const r = s.run(['run', '--isolate', 'extend wip'], { MOCK_ACTIONS: 'append:other.txt:worker line;answer:SUMMARY: ok' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOT applied yet/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8'), 'keep\nuser wip\n', 'real tree untouched');
  const id = /run (\S+)/.exec(r.stdout)[1];
  const copy = JSON.parse(s.run(['show', id, '--json']).stdout).worktree;
  assert.ok(fs.statSync(path.join(copy, '.git')).isDirectory(), 'a standalone repo, not a linked worktree (OpenCode v2 maps those back to the main checkout)');
  const patch = s.run(['show', id, '--patch']).stdout;
  assert.match(patch, /^ user wip$/m, 'worker saw uncommitted work as context');
  assert.match(patch, /^\+worker line$/m);
  const call = s.calls().find((c) => c.argv[0] === 'run');
  assert.notEqual(call.argv[call.argv.indexOf('--dir') + 1], s.repo, 'runs outside the real tree');
  assert.equal(s.run(['apply', id]).status, 0);
  assert.equal(fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8'), 'keep\nuser wip\nworker line\n');
  assert.equal(s.git('worktree', 'list').trim().split('\n').length, 1, 'worktree cleaned up');
  assert.equal(s.git('branch', '--all').trim(), '* main', 'no branches created');
});

test('isolate follow-up reuses the session and accumulates one patch', () => {
  const s = sandbox();
  const first = s.run(['run', '-i', 'step 1'], { MOCK_ACTIONS: 'append:app.txt:a;answer:SUMMARY: 1' });
  const id = /run (\S+)/.exec(first.stdout)[1];
  const second = s.run(['run', '--continue', id, 'step 2'], { MOCK_ACTIONS: 'append:app.txt:b;answer:SUMMARY: 2' });
  assert.equal(second.status, 0, second.stderr);
  const call = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
  assert.equal(call.argv[call.argv.indexOf('--session') + 1], 'ses_mock123');
  const id2 = /run (\S+)/.exec(second.stdout)[1];
  const patch = s.run(['show', id2, '--patch']).stdout;
  assert.match(patch, /^\+a$/m);
  assert.match(patch, /^\+b$/m);
});

test('an edit in read mode is flagged as a violation (exit 5)', () => {
  const s = sandbox();
  const r = s.run(['run', 'look'], { MOCK_ACTIONS: 'append:app.txt:oops;answer:SUMMARY: x' });
  assert.equal(r.status, 5);
  assert.match(r.stdout, /READ-ONLY VIOLATION/);
});

test('worker failure surfaces the real cause and a model hint (exit 1)', () => {
  const s = sandbox();
  const r = s.run(['run', 'x'], { MOCK_ACTIONS: 'fail:ProviderModelNotFoundError: Model not found: foo/bar.' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Model not found: foo\/bar/);
  assert.match(r.stdout, /pitroom doctor/);
});

test('timeout kills the worker (exit 4)', () => {
  const s = sandbox();
  const r = s.run(['run', '-t', '1', 'slow'], { MOCK_ACTIONS: 'sleep:20;answer:late' });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /timeout/);
});

test('refuses recursive delegation and untracked --write', () => {
  const s = sandbox();
  assert.equal(s.run(['run', 'x'], { PITROOM_ACTIVE: '1' }).status, 3);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-plain-'));
  assert.equal(s.run(['run', '--write', '-d', plain, 'x']).status, 3);
  assert.equal(s.run(['run', '--isolate', '-d', plain, 'x']).status, 3);
});

test('background run + wait', () => {
  const s = sandbox();
  const r = s.run(['run', '--bg', 'bg task'], { MOCK_ACTIONS: 'sleep:1;answer:SUMMARY: from bg' });
  assert.equal(r.status, 0, r.stderr);
  const id = /run (\S+) in background/.exec(r.stdout)[1];
  const w = s.run(['wait', id, '--timeout', '30']);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /SUMMARY: from bg/);
});

test('savings ledger, badge and card', () => {
  const s = sandbox();
  s.run(['run', 'a']);
  s.run(['run', 'b']);
  const card = path.join(s.base, 'card.svg');
  const r = s.run(['savings', '--card', card, '--badge'], { PITROOM_PRIMARY: 'opus' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /delegated tasks\s+2/);
  assert.match(r.stdout, /tokens offloaded\s+21k/);
  assert.match(r.stdout, /img\.shields\.io\/badge\/pitroom-/);
  assert.match(fs.readFileSync(card, 'utf8'), /^<svg/);
});

test('doctor flags a default model that OpenCode cannot resolve', () => {
  const s = sandbox();
  const bad = s.run(['doctor'], { MOCK_DEFAULT_MODEL: 'gone/model' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /"gone\/model" is not in `opencode models`/);
  const good = s.run(['doctor']);
  assert.match(good.stdout, /✔ permission profiles pitroom-read\/pitroom-write injected per run/);
  assert.match(good.stdout, /private --standalone server per run/);
});

test('file references in the answer are verified against disk', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.repo, 'src'));
  const pad = Array.from({ length: 12 }, () => '// pad').join('\n');
  fs.writeFileSync(path.join(s.repo, 'src', 'lib.js'), `// lib\nfunction hello() {}\n${pad}\nfunction other() {}\n`);
  const answer = [
    'SUMMARY: `hello()` is defined in src/lib.js:2',
    '- range src/lib.js:1-3 and app.txt:1',
    '- `nothere()` at src/lib.js:2',
    '- too far: src/lib.js:40 and missing/file.ts:3',
    // a symbol in another clause must not be pinned on the next reference
    '- `hello()` in src/lib.js:2; src/lib.js:15 is unrelated',
    // real case: `getBackend()` sits between two refs, so it must not be pinned on src/lib.js:1
    '- Registration: `REGISTRY Map` in src/lib.js:1, `getBackend()` in src/lib.js:2',
    // real case: the range sits inside hello(), whose definition is more than 5 lines above
    '- the body of `hello()` continues at src/lib.js:9-10',
    // real case: after "): " a new clause starts, so `absent()` is not the subject of src/lib.js:14
    '- Order (`src/lib.js:14`): iteration follows `absent()` order',
    '- not refs: https://example.com:8080/x localhost:3000 v1.2.3:4',
  ].join('\\n');
  const r = s.run(['run', 'where is hello?'], { MOCK_ACTIONS: `answer:${answer}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refs: 8\/11 verified/);
  assert.match(r.stdout, /src\/lib\.js:40 \(file has 15 lines\)/);
  assert.match(r.stdout, /missing\/file\.ts:3 \(file not found\)/);
  assert.match(r.stdout, /`nothere` not near line 2/);
});

test('fails over to fallback models on model errors and records the attempt', () => {
  const s = sandbox();
  const r = s.run(['run', 'x'], { MOCK_FAIL_MODELS: 'default,mock/dead', PITROOM_FALLBACK: 'mock/dead,mock/alive' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /fallback: opencode \(default model\) failed \(.*Model not found/);
  assert.match(r.stdout, /fallback: opencode:mock\/dead failed/);
  const runs = s.calls().filter((c) => c.argv[0] === 'run');
  assert.equal(runs.length, 3);
  assert.equal(runs[2].argv[runs[2].argv.indexOf('--model') + 1], 'mock/alive');
  const id = /run (\S+)/.exec(r.stdout)[1];
  const meta = JSON.parse(s.run(['show', id, '--json']).stdout);
  assert.equal(meta.attempts.length, 2);
  assert.equal(meta.state, 'done');
});

test('--no-fallback and non-model errors do not fail over', () => {
  const s = sandbox();
  const a = s.run(['run', '--no-fallback', 'x'], { MOCK_FAIL_MODELS: 'default', PITROOM_FALLBACK: 'mock/alive' });
  assert.equal(a.status, 1);
  const b = s.run(['run', 'y'], { MOCK_ACTIONS: 'fail:SyntaxError in tool', PITROOM_FALLBACK: 'mock/alive' });
  assert.equal(b.status, 1);
  assert.equal(s.calls().filter((c) => c.argv[0] === 'run').length, 2);
});

test('git guard blocks history changes even through sh -c, env and aliases', () => {
  const s = sandbox();
  s.git('config', 'alias.ci', 'commit');
  const head = s.git('rev-parse', 'HEAD');
  const cmds = [
    'sh -c "git commit -am sneaky"',
    'env git push origin main',
    'git ci -am via-alias',
    'git -c alias.zz=reset zz --hard',
    'git branch -D main',
    'git -C . reset --hard',
    'git stash',
    'git add -A',
    'git checkout -- other.txt',
    'git status --short',
    'git branch -a',
    'git log --oneline -1',
    'git config user.name',
  ];
  const r = s.run(['run', '--write', 'try git'], { MOCK_ACTIONS: cmds.map((c) => `exec:${c}`).join(';') + ';answer:SUMMARY: tried' });
  assert.equal(r.status, 0, r.stderr);
  const out = Object.fromEntries(s.execs().map((e) => [e.exec, e]));
  for (const c of cmds.slice(0, 9)) {
    assert.notEqual(out[c].code, 0, `${c} should be blocked`);
    assert.match(out[c].output, /blocked for workers/, c);
  }
  for (const c of cmds.slice(9)) assert.equal(out[c].code, 0, `${c} should be allowed: ${out[c].output}`);
  assert.equal(s.git('rev-parse', 'HEAD'), head);
  assert.match(s.git('branch'), /main/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'other.txt'), 'utf8'), 'keep\nuser wip\n');
  assert.doesNotMatch(s.git('status', '--porcelain'), /^A /m, 'index untouched');
});

test('git never waits for a password, editor or pager', () => {
  const s = sandbox();
  s.run(['run', 'x'], { MOCK_ACTIONS: 'exec:echo "$GIT_TERMINAL_PROMPT|$GIT_EDITOR|$GIT_PAGER";answer:ok' });
  assert.equal(s.execs()[0].output.trim(), '0|true|cat');
});

test('config file supplies defaults; flags and env win', () => {
  const s = sandbox();
  s.config({ fallback: ['mock/alive'], timeout: '1', primary: 'opus', bogus: 1 });
  const c = s.run(['config']);
  assert.match(c.stdout, /fallback\s+mock\/alive\s+\(config\)/);
  assert.match(c.stdout, /timeout\s+1\s+\(config\)/);
  assert.match(c.stdout, /unknown key "bogus"/);
  const slow = s.run(['run', 'slow'], { MOCK_ACTIONS: 'sleep:10;answer:late' });
  assert.equal(slow.status, 4, 'config timeout applied');
  const flagWins = s.run(['run', '-t', '30', 'quick'], { MOCK_ACTIONS: 'sleep:1;answer:SUMMARY: fine' });
  assert.equal(flagWins.status, 0);
  const env = s.run(['config'], { PITROOM_TIMEOUT: '5m' });
  assert.match(env.stdout, /timeout\s+5m\s+\(env\)/);
  const fo = s.run(['run', 'x'], { MOCK_FAIL_MODELS: 'default' });
  assert.equal(fo.status, 0, 'fallback from config file');
});

test('runs that never reached the model are kept out of the savings ledger', () => {
  const s = sandbox();
  s.run(['run', 'x'], { MOCK_ACTIONS: 'fail:boom' });
  s.run(['run', 'y']);
  assert.match(s.run(['savings']).stdout, /delegated tasks\s+1\b/);
});

test('a fallback equal to the failed OpenCode default is skipped, not retried', () => {
  const s = sandbox();
  const r = s.run(['run', 'x'], {
    MOCK_FAIL_MODELS: 'default,mock/good-model',
    PITROOM_FALLBACK: 'mock/good-model,mock/alive',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const models = s.calls().filter((c) => c.argv[0] === 'run').map((c) => (c.argv.includes('--model') ? c.argv[c.argv.indexOf('--model') + 1] : 'default'));
  assert.deepEqual(models, ['default', 'mock/alive']);
});
