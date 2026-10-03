#!/usr/bin/env node
// Fake `gemini` for tests: replays a stream from ../events or ../failures and logs its argv (and the system
// settings path it was given) to $MOCK_LOG. MOCK_GEMINI_FIXTURE picks the file (default events/read-flash.jsonl);
// a failure fixture also prints its .stderr.log and exits 1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (process.env.MOCK_LOG) {
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ argv, backend: 'gemini', systemSettings: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH }) + '\n');
}
if (argv[0] === '--version') {
  console.log('0.35.3');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
// MOCK_GEMINI_FIXTURE: "events/<file>.jsonl" (a clean run) or "failures/<name>" (that failure's stdout and stderr, exit 1).
const fixture = process.env.MOCK_GEMINI_FIXTURE ?? 'events/read-flash.jsonl';
const failure = /^failures\/([\w-]+)$/.exec(fixture)?.[1];
process.stdout.write(fs.readFileSync(path.join(here, '..', failure ? `failures/${failure}.stdout.jsonl` : fixture), 'utf8'));
if (failure) {
  const log = path.join(here, '..', 'failures', `${failure}.stderr.log`);
  if (fs.existsSync(log)) process.stderr.write(fs.readFileSync(log, 'utf8'));
  process.exit(1);
}
