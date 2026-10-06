import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from './helpers.mjs';
import {
  badgeUrl,
  card,
  compact,
  estimateTokens,
  findSecretFiles,
  findSecretFilesInTree,
  looksSecret,
  primaryPrice,
  readLedger,
  savedUsd,
  secretWarning,
  totals,
  usd,
} from '../dist/lib.mjs';

function withEnv(vars, fn) {
  const prev = new Map();
  for (const k of Object.keys(vars)) {
    prev.set(k, process.env[k]);
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const noConfig = () => path.join(scratchDir('pitroom-nocfg-'), 'config.json');

test('looksSecret flags credential file names', () => {
  for (const n of [
    '.env', '.env.local', '.env.production', 'prod.env',
    'id_rsa', 'id_ed25519', 'cert.pem', 'a.p12', 'a.pfx', 'a.key', 'a.jks', 'a.keystore',
    '.netrc', 'credentials.json', 'secrets.json', 'secret.json', 'secrets.yml', 'secret.yaml', 'secrets.toml',
    // the same files on a case-insensitive file system
    '.ENV', '.Env.Local', 'PROD.ENV', 'ID_RSA', 'Id_Ed25519', '.NETRC', 'Credentials.json', 'SECRETS.YML', 'Cert.PEM',
  ]) assert.equal(looksSecret(n), true, n);
});

test('looksSecret ignores templates and innocent names', () => {
  for (const n of [
    '.env.example', '.env.sample', '.env.template', '.env.dist', '.ENV.EXAMPLE', 'id_rsa.pub',
    'README.md', 'environment.ts',
  ]) assert.equal(looksSecret(n), false, n);
});

test('findSecretFiles finds nested secrets, sorts, skips dirs and depth', () => {
  const dir = scratchDir('pitroom-secrets-');
  fs.mkdirSync(path.join(dir, 'sub', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', '.env.local'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'nested', 'id_rsa'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'notes.md'), 'x');
  for (const skip of ['node_modules', '.git', 'dist']) {
    fs.mkdirSync(path.join(dir, skip), { recursive: true });
    fs.writeFileSync(path.join(dir, skip, '.env'), 'x');
  }
  fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'd', 'e', '.env'), 'x'); // depth 5: beyond the limit
  const found = findSecretFiles(dir);
  assert.deepEqual(found, ['.env', 'sub/.env.local', 'sub/nested/id_rsa']);
  assert.ok(found.every((p) => !p.includes('\\')));
});

test('findSecretFilesInTree returns [] outside a git repo', () => {
  const dir = scratchDir('pitroom-nogit-');
  fs.writeFileSync(path.join(dir, '.env'), 'x');
  assert.deepEqual(findSecretFilesInTree(dir, dir), []);
});

test('findSecretFilesInTree respects the dir filter in a git repo', () => {
  const root = scratchDir('pitroom-git-');
  // A worker sandbox may guard git via GIT_CONFIG_* (core.hooksPath): drop those
  // for setup so `git init` works everywhere; ls-files itself needs no such help.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'secrets.json'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'x');
  assert.deepEqual(findSecretFilesInTree(root, root), ['.env', 'sub/secrets.json']);
  assert.deepEqual(findSecretFilesInTree(root, path.join(root, 'sub')), ['secrets.json']);
});

test('secretWarning wording per mode and truncation', () => {
  assert.equal(secretWarning([], 'read'), undefined);
  const read = secretWarning(['.env'], 'read');
  const write = secretWarning(['.env'], 'write');
  const iso = secretWarning(['.env'], 'isolate');
  assert.ok(read.includes('sit in the directory the worker runs in'));
  assert.ok(write.includes('sit in the directory the worker runs in'));
  assert.ok(iso.includes('would be copied into the isolated copy'));
  assert.ok(iso.includes('add them to .gitignore'));
  assert.ok(read.includes('use an isolated copy'));
  const many = secretWarning(['a', 'b', 'c', 'd', 'e'], 'read');
  assert.ok(many.includes('a, b, c, +2 more'));
  assert.ok(!many.includes(', d'));
});

test('usd magnitude boundaries', () => {
  assert.equal(usd(0.5), '$0.500');
  assert.equal(usd(0), '$0.000');
  assert.equal(usd(1), '$1.00');
  assert.equal(usd(99.99), '$99.99');
  assert.equal(usd(100), '$100');
  assert.equal(usd(150.4), '$150');
});

test('compact below 1000, thousands, millions', () => {
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1k');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(100000), '100k');
  assert.equal(compact(1000000), '1M');
  assert.equal(compact(2500000), '2.5M');
});

test('estimateTokens is ceil(length/4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('badgeUrl shields URL with dash escaping', () => {
  const t = { runs: 1, tokens: 1500, returned: 500, workerCost: 0, saved: 1.5, ratio: 3 };
  const msg = encodeURIComponent(`saved ${usd(t.saved)} · ${compact(t.tokens)} tokens offloaded`).replace(/-/g, '--');
  assert.equal(badgeUrl(t), `https://img.shields.io/badge/pitroom-${msg}-7c3aed`);
  const neg = { runs: 0, tokens: 0, returned: 0, workerCost: 0, saved: -5, ratio: 0 };
  assert.ok(badgeUrl(neg).includes('--'), 'a - in the message is doubled');
});

test('totals of empty list and zero-returned ratio', () => {
  assert.deepEqual(totals([]), { runs: 0, tokens: 0, returned: 0, workerCost: 0, saved: 0, ratio: 0 });
  const zero = totals([{ tokens: 10, returned: 0, workerCost: 1, saved: 2 }]);
  assert.equal(zero.ratio, 0);
  assert.equal(zero.runs, 1);
  const full = totals([
    { tokens: 100, returned: 25, workerCost: 1, saved: 2 },
    { tokens: 100, returned: 25, workerCost: 1, saved: 2 },
  ]);
  assert.deepEqual([full.runs, full.tokens, full.returned, full.ratio], [2, 200, 50, 4]);
});

test('readLedger: missing file gives []', () => {
  withEnv({ PITROOM_HOME: scratchDir('pitroom-ledger-') }, () => {
    assert.deepEqual(readLedger(), []);
  });
});

test('readLedger: corrupt lines skipped, sinceMs filters', () => {
  withEnv({ PITROOM_HOME: scratchDir('pitroom-ledger-') }, () => {
    const home = process.env.PITROOM_HOME;
    const mk = (id, at) => ({ id, at, mode: 'write', state: 'done', tokens: 1, returned: 1, workerCost: 0, saved: 0, price: 'x' });
    fs.writeFileSync(
      path.join(home, 'ledger.jsonl'),
      `${JSON.stringify(mk('old', '2020-01-01T00:00:00.000Z'))}\nnot json\n${JSON.stringify(mk('new', new Date().toISOString()))}\n`,
    );
    assert.deepEqual(readLedger().map((e) => e.id), ['old', 'new']);
    assert.deepEqual(readLedger(Date.now() - 60_000).map((e) => e.id), ['new']);
  });
});

test('savedUsd never goes below 0', () => {
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 99, steps: 1, toolCalls: 0, denied: 0 };
  assert.equal(savedUsd(usage, 0, { name: 't', input: 3, output: 15, cachedInput: 0.3 }), 0);
  const paid = { ...usage, input: 1e6, cost: 0 };
  assert.equal(savedUsd(paid, 0, { name: 't', input: 3, output: 15, cachedInput: 0.3 }), 3);
});

test('primaryPrice: PITROOM_PRICE wins, unknown primary falls back to sonnet', () => {
  withEnv({ PITROOM_PRICE: '3,15', PITROOM_PRIMARY: 'no-such-preset', PITROOM_CONFIG: noConfig() }, () => {
    assert.deepEqual(primaryPrice(), { name: 'custom', input: 3, output: 15, cachedInput: 0.3 });
  });
  withEnv({ PITROOM_PRICE: undefined, PITROOM_PRIMARY: 'no-such-preset', PITROOM_CONFIG: noConfig() }, () => {
    const p = primaryPrice();
    assert.equal(p.name, 'Claude Sonnet');
    assert.deepEqual([p.input, p.output], [3, 15]);
  });
});

test('card returns svg with escaped text', () => {
  withEnv({ PITROOM_PRICE: undefined, PITROOM_PRIMARY: undefined, PITROOM_CONFIG: noConfig() }, () => {
    const t = { runs: 2, tokens: 2000, returned: 500, workerCost: 1, saved: 2.5, ratio: 4 };
    const svg = card(t, '<b>&"week</b>');
    assert.ok(svg.includes('<svg'));
    assert.ok(!svg.includes('<b>&"week</b>'));
    assert.ok(svg.includes('&lt;B&gt;&amp;&quot;WEEK&lt;/B&gt;'));
  });
});
