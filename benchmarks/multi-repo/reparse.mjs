#!/usr/bin/env node
// Re-reads every run in results/*.jsonl from `pitroom show` with the current parser.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerParts } from './parse.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) Object.assign(r, answerParts(execFileSync('pitroom', ['show', r.run], { encoding: 'utf8', maxBuffer: 1 << 26 })));
  fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
