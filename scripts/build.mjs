// Bundles src/ into a single dependency-free CLI (dist/pitroom.mjs); skills call it via `pitroom`.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/pitroom.mjs';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
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
  target: 'node22',
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: 'none',
});

// The dashboard (React, Tailwind and shadcn on Base UI) is bundled once into static files that
// `pitroom dash` serves; the CLI itself needs none of it and the package has no runtime dependencies.
await build({
  entryPoints: ['ui/src/main.tsx'],
  outfile: 'dist/ui/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  jsx: 'automatic',
  loader: { '.gif': 'dataurl' },
  tsconfig: 'ui/tsconfig.json',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});
// Run its entry file with this Node: node_modules/.bin/tailwindcss is a symlink on macOS and Linux but a .cmd shim on Windows.
execFileSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'ui/src/styles.css', '-o', 'dist/ui/app.css', '--minify'], { stdio: ['ignore', 'ignore', 'inherit'] });

chmodSync(out, 0o755);
console.log(`built ${out} (v${version})`);
