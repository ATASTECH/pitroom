// End-to-end tests against the built CLI with a fake `opencode` (test/fixtures/opencode).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { sandbox, scratchDir } from './helpers.mjs';

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
  const plain = scratchDir('pitroom-plain-');
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
    // real case: `rg` is a command, not the subject of the reference that follows it
    '- VERIFICATION: ran `rg` searches, and inspected `src/lib.js:14`',
    '- not refs: https://example.com:8080/x localhost:3000 v1.2.3:4',
  ].join('\\n');
  const r = s.run(['run', 'where is hello?'], { MOCK_ACTIONS: `answer:${answer}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refs: 8\/11 verified/);
  assert.match(r.stdout, /src\/lib\.js:40 \(file has 15 lines\)/);
  assert.match(r.stdout, /missing\/file\.ts:3 \(file not found\)/);
  assert.match(r.stdout, /`nothere` not near line 2/);
});

test('references written as a bare file name or a partial path are found; method calls are not references', () => {
  const s = sandbox();
  const dir = path.join(s.repo, 'apps', 'desktop', 'src', 'main');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ipc.ts'), Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  const answer = [
    '- registration at ipc.ts:2 and src/main/ipc.ts:3',
    // a method call that looks like name.ext:line is not a file reference at all
    '- `AssistantEventSchema.parse:432-436` and orchestrator.start:638-640 are calls',
    '- ipc.ts:99 is past the end, missing/file.ts:3 does not exist',
  ].join('\\n');
  const r = s.run(['run', 'where is ipc?'], { MOCK_ACTIONS: `answer:${answer}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refs: 2\/4 verified/);
  assert.match(r.stdout, /ipc\.ts:99 \(file has 10 lines\)/);
  assert.match(r.stdout, /missing\/file\.ts:3 \(file not found\)/);
  assert.doesNotMatch(/── refs:.*/.exec(r.stdout)[0], /Schema\.parse|orchestrator\.start/);
});

test('secret-looking files in the worker directory are called out', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.repo, 'apps', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'apps', 'brain', '.env'), 'PLACEHOLDER=1\n');
  fs.writeFileSync(path.join(s.repo, '.env.example'), 'PLACEHOLDER=\n');
  const r = s.run(['run', 'look around'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warning: secret-looking files sit in the directory the worker runs in \(apps\/brain\/\.env\)/);
  assert.doesNotMatch(r.stdout, /\.env\.example/);
  // it also shows when a run starts in the background, and can be silenced
  const bg = s.run(['run', '--bg', 'look around again'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  assert.match(bg.stdout, /warning: secret-looking files/);
  const quiet = s.run(['run', 'look around'], { MOCK_ACTIONS: 'answer:SUMMARY: ok', PITROOM_NO_SECRET_WARNING: '1' });
  assert.doesNotMatch(quiet.stdout, /secret-looking/);
});

test('an isolated copy only warns about secret files it would contain', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, '.env'), 'PLACEHOLDER=1\n');
  // untracked but not ignored: the copy would hold it
  const open = s.run(['run', '-i', 'x'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  assert.match(open.stdout, /would be copied into the isolated copy \(\.env\)/);
  // git-ignored: the copy leaves it out
  fs.appendFileSync(path.join(s.repo, '.gitignore'), '.env\n');
  const ignored = s.run(['run', '-i', 'x'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  assert.doesNotMatch(ignored.stdout, /secret-looking/);
});

test('--effort without a pinned OpenCode model is left out without a warning', () => {
  const s = sandbox();
  const r = s.run(['run', '--effort', 'high', 'x'], { MOCK_ACTIONS: 'answer:SUMMARY: ok' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /--effort needs a model/);
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

test('git guard layer 2 holds through login shells, absolute paths and pushes', () => {
  const s = sandbox();
  const remote = scratchDir('pitroom-remote-');
  s.git('init', '-q', '--bare', remote);
  s.git('remote', 'add', 'origin', remote);
  const head = s.git('rev-parse', 'HEAD');
  const cmds = [
    "/bin/sh -lc 'git commit -q --allow-empty --no-verify -m login-shell'",
    '/usr/bin/git -c user.name=t -c user.email=t@t commit -q --allow-empty --no-verify -m absolute',
    '/usr/bin/git branch side',
    '/usr/bin/git push -q origin main',
  ];
  const r = s.run(['run', '--write', 'try git'], { MOCK_ACTIONS: cmds.map((c) => `exec:${c}`).join(';') + ';answer:SUMMARY: tried' });
  assert.equal(r.status, 0, r.stderr);
  for (const e of s.execs()) assert.notEqual(e.code, 0, `${e.exec} should fail: ${e.output}`);
  assert.equal(s.git('rev-parse', 'HEAD'), head, 'no commit landed');
  assert.doesNotMatch(s.git('branch'), /side/);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' }), '', 'nothing was pushed');
});

test('records from before pluggable workers still list and show', () => {
  const s = sandbox();
  s.run(['run', 'x']);
  const home = path.join(s.base, 'home', 'runs');
  const id = fs.readdirSync(home)[0];
  const file = path.join(home, id, 'meta.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.worker;
  delete old.fallback;
  delete old.ran;
  old.model = 'legacy/model';
  fs.writeFileSync(file, JSON.stringify(old));
  const ls = s.run(['ls']);
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /opencode:legacy\/model/);
  assert.equal(s.run(['show', id]).status, 0);
});

test('fallback crosses backends: Claude Code (session expired) → OpenCode', () => {
  const s = sandbox();
  const claudeMock = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'claude', 'mock', 'claude.mjs');
  const r = s.run(['run', '-W', 'claude', 'where is login?'], {
    PITROOM_CLAUDE_BIN: claudeMock,
    PITROOM_FALLBACK: 'opencode:mock/alive',
    MOCK_ACTIONS: 'answer:SUMMARY: login is in auth.ts',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /fallback: claude \(default model\) failed \(Failed to authenticate: OAuth session expired/);
  assert.match(r.stdout, /worker opencode/);
  assert.match(r.stdout, /SUMMARY: login is in auth.ts/);
});

test('config "models" gives each worker a default model; explicit models win', () => {
  const s = sandbox();
  s.config({ models: { opencode: 'mock/configured' }, fallback: ['opencode'] });
  const modelOf = () => {
    const c = s.calls().filter((x) => x.argv[0] === 'run').at(-1);
    return c.argv.includes('--model') ? c.argv[c.argv.indexOf('--model') + 1] : 'default';
  };
  assert.equal(s.run(['run', 'x']).status, 0);
  assert.equal(modelOf(), 'mock/configured', 'preferred worker without a model');
  assert.equal(s.run(['run', '-W', 'opencode:mock/explicit', 'y']).status, 0);
  assert.equal(modelOf(), 'mock/explicit', 'target model wins');
  assert.equal(s.run(['run', '-m', 'mock/flag', 'z']).status, 0);
  assert.equal(modelOf(), 'mock/flag', '-m wins');
  // the model-less fallback "opencode" also gets the configured model
  const r = s.run(['run', '-W', 'opencode:mock/dead', 'w'], { MOCK_FAIL_MODELS: 'mock/dead' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(modelOf(), 'mock/configured');
  assert.match(s.run(['config']).stdout, /models\s+opencode=mock\/configured\s+\(config\)/);
});

test('config "tiers" names workers: --tier picks one, -W wins, unknown tiers warn', () => {
  const s = sandbox();
  s.config({ tiers: { cheap: 'opencode:mock/cheap', capable: 'opencode:mock/capable' } });
  const modelOf = () => {
    const c = s.calls().filter((x) => x.argv[0] === 'run').at(-1);
    return c.argv.includes('--model') ? c.argv[c.argv.indexOf('--model') + 1] : 'default';
  };
  assert.equal(s.run(['run', '--tier', 'capable', 'x']).status, 0);
  assert.equal(modelOf(), 'mock/capable');
  assert.equal(s.run(['run', '--tier', 'capable', '-W', 'opencode:mock/explicit', 'y']).status, 0);
  assert.equal(modelOf(), 'mock/explicit', '-W wins over --tier');
  const r = s.run(['run', '--tier', 'nope', 'z']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(modelOf(), 'default');
  assert.match(r.stdout, /warning: tier "nope" is not configured/);
  const inherited = s.run(['run', '--tier', 'constructor', 'w']);
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(inherited.stdout, /warning: tier "constructor" is not configured/);
  assert.match(s.run(['config']).stdout, /tiers\s+cheap=opencode:mock\/cheap, capable=opencode:mock\/capable\s+\(config\)/);
  assert.match(s.run(['doctor']).stdout, /tiers: cheap=opencode:mock\/cheap, capable=opencode:mock\/capable/);
  const id = /run (\S+)/.exec(r.stdout)[1];
  const c = s.run(['run', '--continue', id, '--tier', 'cheap', 'more']);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /drop --worker\/--tier/);
});

test('doctor reports a broken tier and keeps checking the others', () => {
  const s = sandbox();
  s.config({ tiers: { broken: '  ', cheap: 'opencode:mock/cheap' } });
  const d = s.run(['doctor']);
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stdout, /tier "broken": empty worker target/);
  assert.match(d.stdout, /tiers: cheap=opencode:mock\/cheap/);
});

test('doctor warns when superpowers is active too, and only while it is enabled', () => {
  const s = sandbox();
  // Each case gets its own home; CODEX_HOME and XDG_CONFIG_HOME must not leak in from the real one.
  const at = (name) => {
    const dir = path.join(s.base, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, env: { HOME: dir, CODEX_HOME: path.join(dir, '.codex'), XDG_CONFIG_HOME: path.join(dir, '.config') } };
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const doctor = (h) => {
    const out = s.run(['doctor'], h.env).stdout;
    assert.match(out, /worker chain:/, 'doctor ran its checks');
    return out;
  };

  const skills = at('skills-home');
  write(path.join(skills.dir, '.agents', 'skills', 'using-superpowers', 'SKILL.md'), '---\nname: using-superpowers\n---\n');
  assert.match(doctor(skills), /superpowers is installed too \(.*using-superpowers\).*keep one/);
  assert.doesNotMatch(doctor(at('empty-home')), /superpowers/);

  // Claude Code: installed plugins stay listed when disabled; only enabled ones count.
  const claude = at('claude-home');
  write(
    path.join(claude.dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user' }] } }),
  );
  const claudeEnabled = (on) =>
    write(path.join(claude.dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': on } }));
  claudeEnabled(true);
  assert.match(doctor(claude), /superpowers is installed too \(Claude Code plugin superpowers@claude-plugins-official\)/);
  claudeEnabled(false);
  assert.doesNotMatch(doctor(claude), /superpowers/, 'a disabled Claude Code plugin is not a second bootstrap');

  // Codex: config.toml turns plugins on and off.
  const codex = at('codex-home');
  const codexEnabled = (on) =>
    write(
      path.join(codex.dir, '.codex', 'config.toml'),
      `model = "x"\n\n[plugins."superpowers@openai-curated"]\nenabled = ${on}\n\n[plugins."other@openai-curated"]\nenabled = true\n`,
    );
  codexEnabled(true);
  assert.match(doctor(codex), /superpowers is installed too \(Codex plugin superpowers@openai-curated\)/);
  codexEnabled(false);
  assert.doesNotMatch(doctor(codex), /superpowers/, 'a disabled Codex plugin is not a second bootstrap');

  // OpenCode: a plugin is on while opencode.json lists it or its file sits in the plugin folder.
  const opencode = at('opencode-home');
  const config = path.join(opencode.dir, '.config', 'opencode', 'opencode.json');
  write(config, JSON.stringify({ plugin: ['superpowers@git+https://github.com/obra/superpowers.git'] }));
  assert.match(doctor(opencode), /superpowers is installed too \(OpenCode plugin superpowers@git/);
  write(config, JSON.stringify({ plugin: ['some-other-plugin'] }));
  assert.doesNotMatch(doctor(opencode), /superpowers/, 'an OpenCode plugin that is not listed is off');
  const file = path.join(opencode.dir, '.config', 'opencode', 'plugins', 'superpowers.js');
  write(file, 'export default {};\n');
  assert.match(doctor(opencode), /superpowers is installed too \(OpenCode plugin .*superpowers\.js\)/);
});

test('hook-card: one card per phase after a Bash pitroom command, silence otherwise', () => {
  const s = sandbox();
  const r = s.run(['run', 'where is the parser defined']);
  assert.equal(r.status, 0, r.stderr);
  const id = /run (\S+)/.exec(r.stdout)[1];
  const hook = (command, stdout, tool = 'Bash') =>
    s.run(['hook-card'], {}, JSON.stringify({ tool_name: tool, tool_input: { command }, tool_response: { stdout, stderr: '' } }));
  const first = hook('pitroom run "where is the parser defined"', r.stdout);
  assert.equal(first.status, 0, first.stderr);
  const card = JSON.parse(first.stdout).systemMessage;
  assert.match(card, new RegExp(`🏁 Pitroom ✔ research done on opencode.*\\(${id}\\)`));
  assert.doesNotMatch(card, /▶/, 'a run first seen finished gets its result card only');
  assert.equal(hook(`pitroom show ${id}`, r.stdout).stdout, '', 'each phase is shown once');
  assert.equal(hook('ls -la', r.stdout).stdout, '', 'not a pitroom command');
  assert.equal(hook(`cat ~/.local/state/pitroom/runs/${id}/meta.json`, id).stdout, '', 'a path is not a call');
  assert.equal(hook('pitroom status', id, 'Read').stdout, '', 'only Bash');
  assert.equal(s.run(['hook-card'], {}, 'not json').status, 0, 'never fails the host');
  // Subjects stay short: cut at a word boundary, and a plan brief's boilerplate becomes the task and plan.
  const subject = (task) => {
    const run = s.run(['run', task]);
    return JSON.parse(hook('pitroom run x', run.stdout).stdout).systemMessage.split(' · ')[1];
  };
  const long = subject('Find every place where the `session cookie` is read outside the auth module and list them');
  assert.ok(long.length <= 49 && long.endsWith('…') && !long.includes('`'), long);
  // Worker names stay short: no provider prefix, "-free" suffix or trailing version; none for the default model.
  const named = s.run(['run', '-W', 'opencode:opencode/muse-spark-1.3-contributor-free', 'x']);
  assert.match(JSON.parse(hook('pitroom run x', named.stdout).stdout).systemMessage, /done on opencode \(muse-spark\) · /);
  assert.match(card, /done on opencode · /, 'the default model is not spelled out');
  const briefRun = s.run(['run', 'You are implementing Task 3 of the plan docs/pitroom/plans/2026-09-30-widgets.md (in your copy).']);
  assert.match(JSON.parse(hook('pitroom run x', briefRun.stdout).stdout).systemMessage, / · Task 3 · 2026-09-30-widgets · /);
});

test('statusline: the user\'s own line first, then Pitroom\'s when it has something to say', () => {
  const s = sandbox();
  assert.equal(s.run(['statusline', '--then', 'echo base'], {}, '{}').stdout, 'base\n', 'nothing to add yet');
  assert.equal(s.run(['statusline'], {}, '{}').stdout, '');
  assert.equal(s.run(['run', 'x']).status, 0);
  const saved = JSON.parse(s.run(['savings', '--json', '--since', '7d']).stdout).saved;
  const out = s.run(['statusline', '--then', 'cat >/dev/null; echo base'], {}, '{"model":{}}').stdout;
  if (saved > 0) assert.match(out, /^base\n🏁 pitroom · ~\$[\d.]+ saved this week\n$/);
  else assert.equal(out, 'base\n');
});

test('hook-card announces a run that finished without being named, and tells the agent too', () => {
  const s = sandbox();
  const r = s.run(['run', '--bg', 'finish in the background']);
  const id = /run (\S+)/.exec(r.stdout)[1];
  assert.equal(s.run(['wait', id, '--timeout', '30']).status, 0);
  const hook = (command) =>
    s.run(['hook-card'], {}, JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'nothing about a run id', stderr: '' } }));
  const out = JSON.parse(hook('pitroom status').stdout);
  assert.match(out.systemMessage, new RegExp(`🏁 Pitroom ✔ research done on opencode.*\\(${id}\\)`), 'no id in the command or output');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^Pitroom, for the user:\n🏁 Pitroom ✔/, 'the agent sees the card too');
  assert.equal(hook('pitroom status').stdout, '', 'announced once');
});

test('savings --models lists workers and models with their runs and tokens', () => {
  const s = sandbox();
  for (const task of ['one', 'two', 'three']) assert.equal(s.run(['run', task]).status, 0);
  const out = s.run(['savings', '--models']).stdout;
  assert.match(out, /^worker {2}model\s+runs\s+processed\s+returned\s+cost\s+saved\n/);
  // the fake worker reports one model; the row counts every run that used it
  assert.match(out, /^opencode {2}mock\/good-model\s+3 /m);
});

test('an effort-only Codex target gets the configured model; an unpinned Codex or Claude worker is flagged', () => {
  const s = sandbox();
  // "#low" names only a reasoning effort: the configured model must still apply (it used to be skipped).
  s.config({ worker: 'codex:#low', models: { codex: 'gpt-test' } });
  const pinned = s.run(['doctor']).stdout;
  assert.match(pinned, /worker chain: codex:gpt-test#low/);
  assert.doesNotMatch(pinned, /no pinned model/);

  s.config({ worker: 'codex:#low' });
  assert.match(s.run(['doctor']).stdout, /codex has no pinned model, so it runs its own default/);
  s.config({ worker: 'claude' });
  assert.match(s.run(['doctor']).stdout, /claude has no pinned model/);
  s.config({ worker: 'codex:gpt-test#low' });
  assert.doesNotMatch(s.run(['doctor']).stdout, /no pinned model/, 'a model in the target pins it');
  s.config({ worker: 'opencode' });
  assert.doesNotMatch(s.run(['doctor']).stdout, /no pinned model/, 'OpenCode uses the model you set in opencode.json');
});

test('models: each worker\'s list with effort levels, your costs and your own usage', () => {
  const s = sandbox();
  const home = path.join(s.base, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'models_cache.json'),
    JSON.stringify({
      fetched_at: '2026-09-30T21:00:00Z',
      models: [
        { slug: 'gpt-test', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, 'high'] },
        { slug: 'gpt-hidden', visibility: 'hide', supported_reasoning_levels: [] },
      ],
    }),
  );
  s.config({ tiers: { standard: 'codex:gpt-test' }, costs: { 'codex:gpt-test': 3 } });
  const out = s.run(['models', 'codex'], { CODEX_HOME: home });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^codex\s+gpt-test\s+low\/medium\*\/high\s+3\s+-\s+-\s+-\s+tier standard/m);
  assert.doesNotMatch(out.stdout, /gpt-hidden/, 'hidden models are not offered');
  assert.match(out.stdout, /source codex: Codex model cache, fetched 2026-09-30/);
  const json = JSON.parse(s.run(['models', 'codex', '--json'], { CODEX_HOME: home }).stdout);
  assert.deepEqual(json.rows.map((r) => [r.model, r.cost, r.efforts]), [['gpt-test', 3, ['low', 'medium', 'high']]]);
  // Claude Code: aliases with the --effort levels
  assert.match(s.run(['models', 'claude']).stdout, /^claude\s+sonnet\s+low\/medium\/high\/xhigh\/max/m);
});

test('--effort becomes model#level: OpenCode variant, Codex effort, Claude Code --effort; a follow-up refuses it', () => {
  const s = sandbox();
  const r = s.run(['run', '-W', 'opencode:mock/m', '--effort', 'high', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const last = s.calls().filter((c) => c.argv[0] === 'run').at(-1);
  assert.equal(last.argv[last.argv.indexOf('--model') + 1], 'mock/m#high');
  s.config({ worker: 'codex', models: { codex: 'gpt-test' } });
  assert.match(s.run(['doctor']).stdout, /worker chain: codex:gpt-test/, 'the configured model applies');
  const bad = s.run(['run', '--effort', 'high!', 'x']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--effort takes a level/);
  const id = /run (\S+)/.exec(r.stdout)[1];
  const cont = s.run(['run', '--continue', id, '--effort', 'low', 'more']);
  assert.equal(cont.status, 2);
  assert.match(cont.stderr, /drop --worker\/--tier\/--effort/);
});

test('config "costs" must be numbers; doctor shows the cost of the models in use and a cheaper one you priced', () => {
  const s = sandbox();
  s.config({ costs: { 'codex:a': 'cheap' } });
  assert.match(s.run(['config']).stdout + s.run(['doctor']).stdout, /"costs" must be numbers; ignored/);
  s.config({ worker: 'codex:gpt-b', costs: { 'codex:gpt-a': 1, 'codex:gpt-b': 2 } });
  assert.match(s.run(['doctor']).stdout, /cost: codex:gpt-b = 2; you priced codex:gpt-a cheaper \(1\)/);
});
