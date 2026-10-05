// The skill pack and its packaging: Agent Skills rules, the SessionStart hook,
// plugin manifests, and install/uninstall in a throwaway HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CLI, root, scratchDir } from './helpers.mjs';

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

test('the Codex plugin registers hooks: Pitroom is introduced at session start and cards follow pitroom commands', () => {
  const manifest = json('.codex-plugin/plugin.json');
  assert.equal(manifest.hooks, './hooks/codex-hooks.json');
  const hooks = json('hooks/codex-hooks.json').hooks;
  const start = hooks.SessionStart[0];
  const card = hooks.PostToolUse[0];
  assert.equal(card.matcher, 'Bash');
  // they go through `pitroom` on PATH (Codex does not give a plugin root) and stay silent when it is missing
  assert.match(start.hooks[0].command, /command -v pitroom .*pitroom hook-start \|\| true/);
  assert.match(card.hooks[0].command, /command -v pitroom .*pitroom hook-card \|\| true/);
  // hook-start emits the SessionStart JSON Codex reads, and nothing inside a worker
  const env = { ...process.env, PITROOM_ACTIVE: '', CURSOR_PLUGIN_ROOT: '' };
  const out = spawnSync(process.execPath, [CLI, 'hook-start'], { encoding: 'utf8', env, input: '{"hook_event_name":"SessionStart","source":"startup"}' });
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout).hookSpecificOutput;
  assert.equal(body.hookEventName, 'SessionStart');
  assert.match(body.additionalContext, /<pitroom>[\s\S]*using-pitroom|You have Pitroom/);
  assert.equal(spawnSync(process.execPath, [CLI, 'hook-start'], { encoding: 'utf8', env: { ...env, PITROOM_ACTIVE: '1' } }).stdout, '');
});

test('plugin manifests are valid and agree on the version', () => {
  const hooks = json('hooks/hooks.json');
  const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /hooks\/session-start\.mjs/);
  // One hooks/hooks.json serves Claude Code and Gemini CLI (an extension reads that file too, and warns about event
  // names it does not know): it holds SessionStart only, and its command works in both hosts, since Claude Code
  // fills ${CLAUDE_PLUGIN_ROOT}, Gemini CLI fills ${extensionPath}, and the shell turns the other into nothing.
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart'], 'only events both hosts know');
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\$\{extensionPath\}/);
  // The card after each `pitroom` command is Claude Code's alone: the manifest names its own file.
  assert.equal(json('.claude-plugin/plugin.json').hooks, './hooks/claude-hooks.json');
  const post = json('hooks/claude-hooks.json').hooks.PostToolUse[0];
  assert.equal(post.matcher, 'Bash');
  assert.match(post.hooks[0].command, /pitroom\.mjs" hook-card/);
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
  // Gemini CLI reads this manifest from the repository root, the skills from skills/ and a context file next to it.
  const gemini = json('gemini-extension.json');
  assert.equal(gemini.name, 'pitroom');
  assert.equal(gemini.version, version);
  assert.ok(fs.existsSync(path.join(root, gemini.contextFileName)), 'the context file exists');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'using-pitroom', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(root, gemini.contextFileName), 'utf8'), /using-pitroom/);
  assert.ok(json('package.json').files.includes('gemini-extension.json') && json('package.json').files.includes(gemini.contextFileName), 'both ship in the npm package');
});

// The manifest declares hooks (see the test above), which OpenAI's directory rejects: Pitroom is not submitted there
// (docs/releasing.md). The listing text still keeps to the directory's limits, in case that ever changes.
test('the Codex manifest keeps its listing text within the public directory limits', () => {
  const codex = json('.codex-plugin/plugin.json');
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
  const home = scratchDir('pitroom-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  const agents = path.join(home, '.agents', 'skills');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'someone-else'), 'keep me');
  // An old single-skill link from earlier versions is cleaned up.
  fs.symlinkSync(path.join(root, 'skills', 'using-pitroom'), path.join(agents, 'pitroom'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

  const i = run('install');
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /removed old link .*pitroom$/m);
  for (const base of [agents, path.join(home, '.claude', 'skills')]) {
    for (const s of skills) assert.ok(fs.existsSync(path.join(base, s, 'SKILL.md')), `${base}/${s}`);
  }
  const win = process.platform === 'win32';
  const launcher = path.join(home, '.local', 'bin', win ? 'pitroom.cmd' : 'pitroom');
  // a .cmd only starts through a shell
  const v = spawnSync(launcher, ['--version'], { encoding: 'utf8', shell: win, env: { ...env, PATH: win ? process.env.PATH : '/usr/bin:/bin' } });
  assert.equal(v.stdout.trim(), version, 'launcher finds a Node 22.13+ even when none is on PATH');

  const u = run('uninstall');
  assert.equal(u.status, 0, u.stderr);
  for (const s of skills) assert.ok(!fs.existsSync(path.join(agents, s)));
  assert.ok(!fs.existsSync(launcher));
  assert.equal(fs.readFileSync(path.join(agents, 'someone-else'), 'utf8'), 'keep me');
});

test('the skills keep deletion decisions with the primary agent and the user', () => {
  const { body } = frontmatter(path.join(skillsDir, 'using-pitroom', 'SKILL.md'));
  assert.match(body, /Deletions are your decision/);
  assert.match(body, /fixed floor/);
  assert.match(body, /--allow-delete/);
  for (const s of ['pitroom-implement', 'pitroom-driven-development', 'pitroom-crew']) {
    assert.match(frontmatter(path.join(skillsDir, s, 'SKILL.md')).body, /--allow-delete/, s);
  }
});

test('the README keeps no hard-coded version, and its code fences and diagrams are balanced', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Current version/i, 'a version written by hand drifts; the badges show it');
  const fences = readme.split('\n').filter((l) => /^\s*```/.test(l));
  assert.equal(fences.length % 2, 0, 'every code fence is closed');
  // The diagrams are SVG files, which render on GitHub and on npm alike (mermaid does not on npm).
  assert.doesNotMatch(readme, /```mermaid/);
  for (const svg of ['docs/workflow.svg', 'docs/architecture.svg']) {
    assert.ok(readme.includes(svg), `${svg} is shown in the README`);
    const src = fs.readFileSync(path.join(root, svg), 'utf8');
    assert.match(src, /^<svg [^>]*viewBox="0 0 \d+ \d+"/, `${svg} is an SVG with a viewBox`);
    assert.match(src, /<title[^>]*>.+<\/title>/s, `${svg} has a title for screen readers`);
  }
  for (const tag of ['details', 'div', 'table']) {
    assert.equal((readme.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length, (readme.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, `<${tag}> is balanced`);
  }
});

test('third-party notices ship with the package and carry the superpowers MIT notice', () => {
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /Copyright \(c\) 2025 Jesse Vincent/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files.includes('THIRD_PARTY_NOTICES.md'));
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /THIRD_PARTY_NOTICES\.md/);
});

test('community files exist: code of conduct, issue forms, pull request template', () => {
  for (const f of ['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});
