// Bundles src/ into a single dependency-free CLI (dist/pitroom.mjs); skills call it via `pitroom`.
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/pitroom.mjs';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: 'none',
});

// Pure adapter/target functions for the contract tests (and anyone embedding Pitroom).
await build({
  entryPoints: ['src/lib.ts'],
  outfile: 'dist/lib.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: 'none',
});

chmodSync(out, 0o755);
console.log(`built ${out} (v${version})`);
