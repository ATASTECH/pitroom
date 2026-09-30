// The skill pack and its packaging: Agent Skills rules, the SessionStart hook,
// plugin manifests, and install/uninstall in a throwaway HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CLI, root } from './helpers.mjs';

const skillsDir = path.join(root, 'skills');
const skills = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const json = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(file, 'utf8'));
  assert.ok(m, `${file} has frontmatter`);
  const fields = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { fields, body: m[2] };
}

const PACK = [
  'pitroom-brainstorming', 'pitroom-crew', 'pitroom-debugging', 'pitroom-driven-development', 'pitroom-finishing',
  'pitroom-implement', 'pitroom-receiving-review', 'pitroom-research', 'pitroom-review', 'pitroom-tdd',
  'pitroom-verification', 'pitroom-worktrees', 'pitroom-writing-plans', 'using-pitroom',
];

test('the pack: using-pitroom plus the pitroom-* workflow skills', () => {
  assert.deepEqual([...skills].sort(), PACK);
});

for (const name of skills) {
  test(`skill ${name} follows the Agent Skills rules`, () => {
    const { fields, body } = frontmatter(path.join(skillsDir, name, 'SKILL.md'));
    assert.equal(fields.name, name, 'name matches the folder');
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fields.name.length <= 64);
    assert.ok(fields.description && fields.description.length <= 1024, 'description present, at most 1024 chars');
    assert.match(fields.description, /^Use\b/, 'description says when to use it');
    assert.ok(body.trim().length > 200);
  });
}

test('skill files name Pitroom skills only, and every relative link resolves', () => {
  for (const name of skills) {
    const dir = path.join(skillsDir, name);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(text, /superpowers:|docs\/superpowers|\.superpowers\//, `${name}/${f}`);
      for (const [, target] of text.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        assert.ok(fs.existsSync(path.join(dir, target)), `${name}/${f}: link ${target}`);
      }
    }
  }
});

test('using-pitroom routes to every other skill', () => {
  const { body } = frontmatter(path.join(skillsDir, 'using-pitroom', 'SKILL.md'));
  for (const s of skills.filter((n) => n !== 'using-pitroom')) assert.ok(body.includes(`\`${s}\``), s);
});

test('session-start hook injects using-pitroom (and nothing inside a worker)', () => {
  const hook = path.join(root, 'hooks', 'session-start.mjs');
  const env = { ...process.env };
  delete env.PITROOM_ACTIVE;
  delete env.CURSOR_PLUGIN_ROOT;
  const r = spawnSync(process.execPath, [hook], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /# Using Pitroom/);
  assert.doesNotMatch(ctx, /^name: using-pitroom/m, 'frontmatter stripped');
  assert.ok(ctx.length < 8192, 'kept short: it is paid for in every session');
  assert.match(ctx, /pitroom-brainstorming/);
  const cursor = JSON.parse(spawnSync(process.execPath, [hook], { encoding: 'utf8', env: { ...env, CURSOR_PLUGIN_ROOT: root } }).stdout);
  assert.ok(cursor.additional_context && !cursor.hookSpecificOutput, 'one field per host, never both');
  const inWorker = spawnSync(process.execPath, [hook], { encoding: 'utf8', env: { ...env, PITROOM_ACTIVE: '1' } });
  assert.equal(inWorker.stdout, '');
});

test('plugin manifests are valid and agree on the version', () => {
  const hooks = json('hooks/hooks.json');
  const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /hooks\/session-start\.mjs/);
  assert.equal(json('.claude-plugin/plugin.json').name, 'pitroom');
  assert.equal(json('.claude-plugin/plugin.json').version, version);
  // The marketplace (read by Claude Code and Codex) installs the published npm package, not this
  // repository: a repository source would copy src/ and test/ and run npm install for the dev tools.
  const market = json('.claude-plugin/marketplace.json');
  assert.deepEqual(market.plugins[0].source, { source: 'npm', package: 'pitroom' });
  assert.equal(market.plugins[0].version, undefined, 'no pin: users follow the latest release');
  assert.equal(market.plugins[0].name, json('.claude-plugin/plugin.json').name);
  const codex = json('.codex-plugin/plugin.json');
  assert.equal(codex.version, version);
  assert.ok(fs.existsSync(path.join(root, codex.skills)));
});

test('the Codex manifest meets the public directory limits (no hooks, short listing text)', () => {
  const codex = json('.codex-plugin/plugin.json');
  assert.equal('hooks' in codex, false, 'the directory rejects packages with lifecycle hooks');
  const ui = codex.interface;
  assert.ok(ui.displayName.length <= 30 && ui.shortDescription.length <= 30, 'display name and subtitle: 30 characters');
  assert.ok(ui.longDescription.length <= 4000 && ui.developerName.length <= 80);
  assert.ok(Array.isArray(ui.capabilities), 'capabilities are required in the Codex format');
  for (const k of ['websiteURL', 'supportURL']) assert.match(ui[k], /^https:\/\//, k);
  assert.ok(codex.description.length <= 4000 && codex.author.name);
});

test('the Codex listing has an icon, a privacy policy and no other assistants in its text', () => {
  const codex = json('.codex-plugin/plugin.json');
  const ui = codex.interface;
  for (const key of ['logo', 'composerIcon']) {
    assert.match(ui[key], /^\.\//, `${key} is a ./-relative path`);
    const svg = fs.readFileSync(path.join(root, ui[key]), 'utf8');
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(box && box[1] === box[2] && Number(box[1]) >= 48, `${key}: a square viewBox of at least 48`);
    assert.ok(fs.statSync(path.join(root, ui[key])).size < 5 * 1024 * 1024);
  }
  assert.match(ui.privacyPolicyURL, /^https:\/\//);
  assert.ok(fs.existsSync(path.join(root, 'PRIVACY.md')));
  // The portal warns when the name or description references another assistant, model or platform.
  const text = [codex.name, codex.description, ui.displayName, ui.shortDescription, ui.longDescription, ...codex.keywords].join(' ');
  assert.doesNotMatch(text, /claude|anthropic|opencode|codex|gemini|cursor|copilot|gpt|openai|chatgpt/i);
  // What the listing references must ship in the npm package.
  const files = json('package.json').files;
  for (const f of ['assets', 'PRIVACY.md']) assert.ok(files.includes(f), `${f} is in the npm package`);
});

test('install links every skill and a working launcher; uninstall removes only those', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitroom-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const agents = path.join(home, '.agents', 'skills');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'someone-else'), 'keep me');
  // An old single-skill link from earlier versions is cleaned up.
  fs.symlinkSync(path.join(root, 'skills', 'using-pitroom'), path.join(agents, 'pitroom'));
  const env = { ...process.env, HOME: home };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

  const i = run('install');
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /removed old link .*pitroom$/m);
  for (const base of [agents, path.join(home, '.claude', 'skills')]) {
    for (const s of skills) assert.ok(fs.existsSync(path.join(base, s, 'SKILL.md')), `${base}/${s}`);
  }
  const launcher = path.join(home, '.local', 'bin', 'pitroom');
  const v = spawnSync(launcher, ['--version'], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } });
  assert.equal(v.stdout.trim(), version, 'launcher finds a Node 18+ even when none is on PATH');

  const u = run('uninstall');
  assert.equal(u.status, 0, u.stderr);
  for (const s of skills) assert.ok(!fs.existsSync(path.join(agents, s)));
  assert.ok(!fs.existsSync(launcher));
  assert.equal(fs.readFileSync(path.join(agents, 'someone-else'), 'utf8'), 'keep me');
});
