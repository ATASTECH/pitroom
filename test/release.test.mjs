// The version lives in several files; scripts/bump-version.mjs moves them together.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { root, scratchDir } from './helpers.mjs';

const SCRIPT = path.join(root, 'scripts', 'bump-version.mjs');
const json = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const FILES = ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'gemini-extension.json', 'server.json', 'CHANGELOG.md'];

/** A throwaway copy of the files the script touches. */
function copy() {
  const dir = scratchDir('pitroom-bump-');
  for (const name of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(dir, name));
  }
  return dir;
}
const bump = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });

test('this repository keeps one version everywhere, with a finished CHANGELOG entry', () => {
  const version = json(root, 'package.json').version;
  assert.equal(json(root, 'package-lock.json').version, version, 'package-lock.json');
  assert.equal(json(root, 'package-lock.json').packages[''].version, version, 'package-lock.json root package');
  assert.equal(json(root, '.claude-plugin/plugin.json').version, version, 'Claude Code manifest');
  assert.equal(json(root, '.codex-plugin/plugin.json').version, version, 'Codex manifest');
  assert.equal(json(root, 'gemini-extension.json').version, version, 'Gemini CLI extension manifest');
  const server = json(root, 'server.json');
  assert.equal(server.version, version, 'MCP Registry entry');
  assert.equal(server.packages[0].version, version, 'its npm package');
  assert.equal(server.name, json(root, 'package.json').mcpName, 'the registry checks package.json mcpName against server.json');
  assert.equal(server.packages[0].identifier, json(root, 'package.json').name);
  assert.ok(server.description.length <= 100, 'the registry allows 100 characters');
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(log, new RegExp(`^## ${version.replaceAll('.', '\\.')}$`, 'm'), 'CHANGELOG has a heading for this version');
  assert.doesNotMatch(log, /TODO/, 'the CHANGELOG stub was filled in');
});

test('bump: patch, minor, major and an explicit version move every file together', () => {
  const [a, b, c] = json(root, 'package.json').version.split('.').map(Number);
  for (const [target, expected] of [['patch', `${a}.${b}.${c + 1}`], ['minor', `${a}.${b + 1}.0`], ['major', `${a + 1}.0.0`], ['9.8.7', '9.8.7']]) {
    const dir = copy();
    const current = json(dir, 'package.json').version;
    const r = bump(dir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`bumped ${current.replaceAll('.', '\\.')} → ${expected.replaceAll('.', '\\.')}`));
    assert.equal(json(dir, 'package.json').version, expected);
    assert.equal(json(dir, 'package-lock.json').version, expected);
    assert.equal(json(dir, 'package-lock.json').packages[''].version, expected);
    assert.equal(json(dir, '.claude-plugin/plugin.json').version, expected);
    assert.equal(json(dir, '.codex-plugin/plugin.json').version, expected);
    assert.equal(json(dir, 'gemini-extension.json').version, expected);
    assert.equal(json(dir, 'server.json').version, expected);
    assert.equal(json(dir, 'server.json').packages[0].version, expected);
    assert.match(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), new RegExp(`^# Changelog\\n\\n## ${expected.replaceAll('.', '\\.')}\\n\\n`));
  }
});

test('bump: --dry-run writes nothing, and bad input is refused', () => {
  const dir = copy();
  const before = FILES.map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  const dry = bump(dir, 'patch', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would bump/);
  assert.deepEqual(FILES.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')), before);
  for (const bad of ['banana', '1.2', 'v1.2.3']) assert.equal(bump(dir, bad).status, 2, bad);
  assert.equal(bump(dir).status, 2, 'no target');
  assert.equal(bump(dir, json(dir, 'package.json').version).status, 2, 'the version it already has');
});

test('bump: an "## Unreleased" section becomes the version\'s entry, with no stub; without one a stub is added', () => {
  const dir = copy();
  const log = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(log, '# Changelog\n\n## Unreleased\n\n### New\n- a thing\n\n## 0.0.1\n\n- old\n');
  assert.equal(bump(dir, '9.0.0').status, 0);
  assert.equal(fs.readFileSync(log, 'utf8'), '# Changelog\n\n## 9.0.0\n\n### New\n- a thing\n\n## 0.0.1\n\n- old\n');
  fs.writeFileSync(log, '# Changelog\n\n## 0.0.1\n\n- old\n');
  assert.equal(bump(dir, '9.1.0').status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /^# Changelog\n\n## 9\.1\.0\n\nTODO: describe this release\.\n\n## 0\.0\.1/);
});
