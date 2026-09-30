// Shared helpers for locating and launching worker CLIs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First existing executable: $<envVar>, then PATH, then known install locations. */
export function findBinary(name: string, envVar: string, known: string[] = []): string {
  const override = process.env[envVar];
  if (override) return override;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, `${name}${ext}`);
      if (isFile(p)) return p;
    }
  }
  return known.map((k) => k.replace(/^~/, os.homedir())).find(isFile) ?? name;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * npm-installed CLIs (Codex, some OpenCode installs) are Node scripts with
 * `#!/usr/bin/env node`. Agents' shells often have an old Node first on PATH, so
 * such scripts run on Pitroom's own Node (18+) instead of whatever `env` finds.
 */
export function resolveCommand(bin: string): { command: string; prefix: string[] } {
  try {
    const real = fs.realpathSync(bin);
    const fd = fs.openSync(real, 'r');
    const head = Buffer.alloc(128);
    const n = fs.readSync(fd, head, 0, 128, 0);
    fs.closeSync(fd);
    const firstLine = head.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
    if (/^#!.*\bnode\b/.test(firstLine)) return { command: process.execPath, prefix: [real] };
  } catch {
    /* not a readable file: let spawn report it */
  }
  return { command: bin, prefix: [] };
}
