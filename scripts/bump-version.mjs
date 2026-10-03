#!/usr/bin/env node
// Bumps the version everywhere it lives, so no file is forgotten:
//   package.json, package-lock.json (two places), .claude-plugin/plugin.json,
//   .codex-plugin/plugin.json, gemini-extension.json, and a new heading in CHANGELOG.md.
//
//   npm run bump -- patch | minor | major | 1.2.3   [--root DIR] [--dry-run]
//
// Docs do not carry a version by hand (the badges show it), so there is nothing else to edit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const dryRun = args.includes('--dry-run') && !!args.splice(args.indexOf('--dry-run'), 1);
const root = path.resolve(flag('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const target = args[0];

const fail = (message) => {
  console.error(`bump-version: ${message}`);
  process.exit(2);
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const file = (name) => path.join(root, name);
const readJson = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));

if (!target) fail('usage: npm run bump -- patch | minor | major | X.Y.Z [--dry-run]');
const current = readJson('package.json').version;
const match = SEMVER.exec(current);
if (!match) fail(`package.json has version "${current}", which is not X.Y.Z`);
const [major, minor, patch] = match.slice(1).map(Number);
const next =
  target === 'patch' ? `${major}.${minor}.${patch + 1}`
  : target === 'minor' ? `${major}.${minor + 1}.0`
  : target === 'major' ? `${major + 1}.0.0`
  : SEMVER.test(target) ? target
  : fail(`"${target}" is not patch, minor, major or X.Y.Z`);
if (next === current) fail(`the version is already ${current}`);

const changed = [];
const writeJson = (name, data) => {
  changed.push(name);
  if (!dryRun) fs.writeFileSync(file(name), `${JSON.stringify(data, null, 2)}\n`);
};

for (const name of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'gemini-extension.json']) {
  if (!fs.existsSync(file(name))) fail(`${name} is missing`);
  const data = readJson(name);
  data.version = next;
  writeJson(name, data);
}
if (fs.existsSync(file('package-lock.json'))) {
  const lock = readJson('package-lock.json');
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeJson('package-lock.json', lock);
}

const log = fs.existsSync(file('CHANGELOG.md')) ? fs.readFileSync(file('CHANGELOG.md'), 'utf8') : '# Changelog\n\n';
if (!new RegExp(`^## ${next.replaceAll('.', '\\.')}\\b`, 'm').test(log)) {
  changed.push('CHANGELOG.md');
  const stub = `## ${next}\n\nTODO: describe this release.\n\n`;
  if (!dryRun) fs.writeFileSync(file('CHANGELOG.md'), log.replace(/^# Changelog\n\n/, `# Changelog\n\n${stub}`));
}

console.log(`${dryRun ? 'would bump' : 'bumped'} ${current} → ${next}`);
for (const name of changed) console.log(`  ${name}`);
console.log('Next: write the CHANGELOG entry (the TODO must go), npm test, commit, npm publish. See docs/releasing.md.');
