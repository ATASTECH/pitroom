// The project map (--map, config repoMap, `pitroom map`): the files git sees by folder, with the names each source
// file declares, within a budget; secret-looking and ignored files left out; in a new run's prompt only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const prompts = (s) => s.calls().filter((c) => c.argv[0] === 'run').map((c) => c.argv.at(-1));
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;

function sources(s) {
  fs.mkdirSync(path.join(s.repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'src', 'auth.ts'), 'import x from "y";\nexport async function login() {}\nexport class Session {}\nfunction hidden() {}\nexport const TTL = 5;\n');
  fs.writeFileSync(path.join(s.repo, 'src', 'jobs.py'), 'def run():\n    def inner():\n        pass\nclass Queue:\n    pass\n');
  fs.writeFileSync(path.join(s.repo, '.env'), 'TOKEN=secret\n');
  fs.mkdirSync(path.join(s.repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'node_modules', 'dep', 'index.js'), 'export function dep() {}\n');
}

test('map: the files git sees, with the top-level names of source files; secrets and ignored files left out', () => {
  const s = sandbox();
  sources(s);
  const r = s.run(['map']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\.\/\n {2}\.gitignore\n {2}app\.txt\n {2}other\.txt\n {2}untracked\.txt\nsrc\/\n {2}auth\.ts: login, Session, TTL\n {2}jobs\.py: run, Queue$/m);
  assert.doesNotMatch(r.stdout, /\.env|secret|node_modules|dep|hidden|inner/);
  assert.match(r.stderr, /── \d+ characters, ~\d+ tokens in a prompt/);
  // kept while the project is in the same state
  assert.equal(fs.readdirSync(path.join(s.base, 'home', 'maps')).length, 1);
  s.run(['map']);
  assert.equal(fs.readdirSync(path.join(s.base, 'home', 'maps')).length, 1);
  fs.appendFileSync(path.join(s.repo, 'src', 'auth.ts'), 'export function logout() {}\n');
  assert.match(s.run(['map']).stdout, /auth\.ts: login, Session, TTL, logout/);
});

test('map: a big project fits the budget; tests and fixtures give up their detail first, source folders keep their names', () => {
  const s = sandbox();
  sources(s);
  for (let i = 0; i < 40; i++) {
    const d = path.join(s.repo, 'test', 'fixtures', `case-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < 6; j++) fs.writeFileSync(path.join(d, `input-with-a-long-name-${j}.json`), '{}\n');
    fs.writeFileSync(path.join(s.repo, 'test', `case-${i}.test.ts`), `export function helper${i}() {}\n`);
  }
  const r = s.run(['map', '--fresh']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length <= 6001, `${r.stdout.length} characters`);
  assert.match(r.stdout, /^src\/\n {2}auth\.ts: login, Session, TTL$/m);
  assert.match(r.stdout, /^test\/ {2}\(280 files in 41 folders\)$/m);
});

test('map: --map puts it in a new run\'s prompt, as does repoMap; never in a follow-up; --no-map wins', () => {
  const s = sandbox();
  sources(s);
  const ANSWER = { MOCK_ACTIONS: 'answer:SUMMARY: ok' };
  const first = s.run(['run', '--map', 'where is login?'], ANSWER);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  s.run(['run', 'no map here'], ANSWER);
  s.config({ repoMap: true });
  s.run(['run', '-i', 'from the config'], ANSWER);
  s.run(['run', '--no-map', 'turned off'], ANSWER);
  s.run(['run', '--continue', RUN_ID.exec(first.stdout)[0], 'and logout?'], ANSWER);
  const [withMap, without, fromConfig, off, followUp] = prompts(s);
  assert.match(withMap, /Project map: the files git sees here, by folder, .* not the code: read what you rely on\.\n\.\/\n[\s\S]* {2}auth\.ts: login, Session, TTL[\s\S]*\nTask:\nwhere is login\?/);
  assert.doesNotMatch(without, /Project map/);
  assert.match(fromConfig, /Project map/);
  assert.doesNotMatch(off, /Project map/);
  assert.doesNotMatch(followUp, /Project map/);
  const both = s.run(['run', '--map', '--no-map', 'q']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /choose one of --map, --no-map/);
});

test('map: outside a git repository it says why', () => {
  const s = sandbox();
  const outside = path.join(s.base, 'plain');
  fs.mkdirSync(outside);
  const r = s.run(['map', '-d', outside]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not in a git repository/);
});
