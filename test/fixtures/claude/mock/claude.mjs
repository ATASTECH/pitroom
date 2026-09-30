#!/usr/bin/env node
// Fake `claude` for tests: replays the recorded "OAuth session expired" stream and fails,
// and logs its argv to $MOCK_LOG like the OpenCode mock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ argv, backend: 'claude' }) + '\n');
if (argv[0] === '--version') {
  console.log('2.1.0 (Claude Code, mock)');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
process.stdout.write(fs.readFileSync(path.join(here, '..', 'failures', 'auth-expired.stdout.jsonl'), 'utf8'));
process.exit(1);
