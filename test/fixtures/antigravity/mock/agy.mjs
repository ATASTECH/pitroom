#!/usr/bin/env node
// Fake `agy` for tests: replays a stream from ../events and logs its argv, cwd and data folder to $MOCK_LOG.
// MOCK_AGY_FIXTURE picks the file (default events/read.jsonl). MOCK_AGY_WRITE=<name> also writes that file in its
// working directory, as agy does in a read run despite --mode plan (google-antigravity/antigravity-cli#1181).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (process.env.MOCK_LOG) {
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ argv, backend: 'antigravity', cwd: process.cwd(), dataDir: process.env.ANTIGRAVITY_APP_DATA_DIR }) + '\n');
}
if (argv[0] === '--version') {
  console.log('1.3.2');
  process.exit(0);
}
if (process.env.MOCK_AGY_WRITE) fs.writeFileSync(path.join(process.cwd(), process.env.MOCK_AGY_WRITE), 'written by a read run\n');
const here = path.dirname(fileURLToPath(import.meta.url));
process.stdout.write(fs.readFileSync(path.join(here, '..', process.env.MOCK_AGY_FIXTURE ?? 'events/read.jsonl'), 'utf8'));
