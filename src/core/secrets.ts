// A heads-up, not a guard: a worker runs in the project directory and could read a `.env` or a private key
// there, and its model may be hosted by a third party. The worker prompt tells it not to; this tells the user.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.cache']);
const MAX_VISITED = 20_000;
const MAX_DEPTH = 4;
const TEMPLATE = /\.(example|sample|template|dist|defaults?|tpl)$/i;

/**
 * Names that usually hold credentials: .env, .env.local and prod.env (not .env.example), private keys and keystores,
 * .netrc, credentials.json and secrets.json/yml/toml.
 */
export function looksSecret(file: string): boolean {
  // Any case: on macOS and Windows `.ENV`, `ID_RSA` and `Credentials.json` are the same files as their lower-case names.
  const name = file.toLowerCase();
  if (TEMPLATE.test(name)) return false;
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true;
  return (
    /\.(pem|p12|pfx|key|jks|keystore)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) ||
    name === '.netrc' ||
    name === 'credentials.json' ||
    /^secrets?\.(json|ya?ml|toml)$/.test(name)
  );
}

/** Secret-looking files a worker could read in `dir`, as paths relative to it. */
export function findSecretFiles(dir: string): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (d: string, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile() && looksSecret(e.name)) {
        found.push(slash(path.relative(dir, path.join(d, e.name))));
      }
    }
  };
  walk(dir, 0);
  return found.sort();
}

/** The same, but only the files an isolated copy would contain: tracked, or untracked and not ignored. */
export function findSecretFilesInTree(root: string, dir: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return out
      .split('\0')
      .filter((f) => f && looksSecret(path.basename(f)) && !path.relative(dir, path.join(root, f)).startsWith('..'))
      .map((f) => slash(path.relative(dir, path.join(root, f))))
      .sort();
  } catch {
    return [];
  }
}

export function secretWarning(files: string[], mode: 'read' | 'write' | 'isolate'): string | undefined {
  if (!files.length) return undefined;
  const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');
  const where = mode === 'isolate' ? 'would be copied into the isolated copy' : 'sit in the directory the worker runs in';
  const fix = mode === 'isolate' ? 'add them to .gitignore, or' : 'use an isolated copy (-i, git-ignored files are left out) or a clean checkout, or';
  return `secret-looking files ${where} (${shown}): the worker is told not to read them, but nothing stops it, and its model may be hosted by a third party; ${fix} set PITROOM_NO_SECRET_WARNING=1 to silence this`;
}

/** The paths shown to the user and compared in tests read the same on every platform. */
const slash = (p: string) => p.split(path.sep).join('/');
