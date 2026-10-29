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
  assert.match(r.stderr, /── \d+ characters, ~\d+ of 1500 tokens · 6 files in 2 folders · names read from 2 files, 0 already known/);
  // names are read once per file content: again, nothing is read; a changed file is read again
  assert.equal(fs.readdirSync(path.join(s.base, 'home', 'maps')).length, 1);
  assert.match(s.run(['map']).stderr, /names read from 0 files, 2 already known/);
  fs.appendFileSync(path.join(s.repo, 'src', 'auth.ts'), 'export function logout() {}\n');
  const changed = s.run(['map']);
  assert.match(changed.stdout, /auth\.ts: login, Session, TTL, logout/);
  assert.match(changed.stderr, /names read from 1 file, 1 already known/);
  assert.match(s.run(['map', '--fresh']).stderr, /names read from 2 files, 0 already known/);
});

/** A monorepo: `packages` packages of 12 source and 12 test files, one of them with the invoice code, plus fixtures and docs. */
function monorepo(s, packages = 30) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(s.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.repo, rel), text);
  };
  for (let p = 0; p < packages; p++) {
    const pkg = p === 17 ? 'billing' : `module-${String(p).padStart(3, '0')}`;
    for (let f = 0; f < 12; f++) {
      write(`packages/${pkg}/src/part-${f}-with-a-longer-name.ts`, `export function handler${p}x${f}() {}\nexport const settings${f} = {};\n`);
      write(`packages/${pkg}/test/part-${f}.test.ts`, `export function check${f}() {}\n`);
    }
  }
  write('packages/billing/src/invoice.ts', 'export function computeInvoiceTotal() {}\nexport class InvoiceRounding {}\n');
  // a folder about the task inside a folder about the task
  write('packages/billing/src/rounding/invoice-rounding.ts', 'export function roundInvoiceTotal() {}\n');
  for (let i = 0; i < 60; i++) write(`test/fixtures/case-${String(i).padStart(2, '0')}/input.json`, '{}\n');
  write('docs/guide.md', '# guide\n');
}

test('map: a big project fits the budget as an overview, never a list cut short; tests and fixtures give up their detail first', () => {
  const s = sandbox();
  monorepo(s);
  const r = s.run(['map']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length <= 6000, `${r.stdout.length} characters`);
  assert.doesNotMatch(r.stdout, /folders in all/, 'not cut short');
  // every top folder keeps a line, and the fixtures are counted, not listed
  for (const top of [/^\.\/$/m, /^docs\/(  \(1 file\))?$/m, /^packages\//m, /^test\/ {2}\(60 files in 62 folders\)$/m]) assert.match(r.stdout, top);
  assert.doesNotMatch(r.stdout, /input\.json/);
});

test('map: the task decides where the detail goes, and what is not about it is cut down', () => {
  const s = sandbox();
  monorepo(s);
  const plain = s.run(['map']);
  assert.doesNotMatch(plain.stdout, /computeInvoiceTotal/);
  const r = s.run(['map', '--task', 'Fix the rounding in computeInvoiceTotal for invoices']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^packages\/billing\/src\/\n(  .*\n)*  invoice\.ts: computeInvoiceTotal, InvoiceRounding$/m);
  assert.match(r.stdout, /^packages\/billing\/src\/rounding\/\n  invoice-rounding\.ts: roundInvoiceTotal$/m, 'the subfolder of a folder with a relevant file of its own');
  assert.doesNotMatch(r.stdout, /^packages\/module-000\/src\/\n  part-0/m, 'the other packages are counted, not listed');
  assert.ok(r.stdout.length < plain.stdout.length, 'a focused map is shorter');
  assert.match(r.stdout, /^docs\//m, 'the top folders stay');
  // the same words as positional arguments
  assert.match(s.run(['map', 'computeInvoiceTotal']).stdout, /invoice\.ts: computeInvoiceTotal/);
});

test('map: in a project too big to count every folder, the folders off the task\'s path fold into one line', () => {
  const s = sandbox();
  monorepo(s, 150);
  const r = s.run(['map', '--task', 'Fix the rounding in computeInvoiceTotal for invoices']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length <= 6000, `${r.stdout.length} characters`);
  assert.match(r.stdout, /invoice\.ts: computeInvoiceTotal, InvoiceRounding/);
  assert.match(r.stdout, /^packages\/…  \(\d+ more files in \d+ other folders\)$/m, 'the other packages fold into one line');
  assert.match(r.stdout, /^docs\//m, 'the top folders stay');
  assert.doesNotMatch(r.stdout, /folders in all/);
});

test('map: the budget is repoMapTokens (300 to 8000), or --tokens', () => {
  const s = sandbox();
  monorepo(s);
  const small = s.run(['map', '--tokens', '400']);
  assert.ok(small.stdout.length <= 1600, `${small.stdout.length} characters`);
  assert.match(small.stderr, /of 400 tokens/);
  const env = s.run(['map'], { PITROOM_REPO_MAP_TOKENS: '500' });
  assert.ok(env.stdout.length <= 2000, `${env.stdout.length} characters`);
  s.config({ repoMapTokens: 100000 });
  assert.match(s.run(['map']).stderr, /of 8000 tokens/, 'held to the most');
  const bad = s.run(['map', '--tokens', '50']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--tokens takes the map's budget, 300 to 8000, not "50"/);
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
