// `pitroom crew --over`: one task, once per part of the project, each worker kept to its own part. Two workers that
// read the same files hand the primary agent two answers about the same code to reconcile (and when they disagree, it
// opens the files itself): parts that do not overlap keep the reading parallel and the merging small.
import fs from 'node:fs';
import path from 'node:path';
import type { Mode } from '../backends/types.js';
import { UserError } from './errors.js';

const clean = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';

/**
 * The parts `--over` names, relative to `dir`: paths, or a pattern whose last part has `*` or `?` (one entry per
 * match, hidden ones left out; a trailing "/" keeps folders only). Each must exist, and no part may hold another.
 */
export function expandScopes(patterns: string[], dir: string): string[] {
  const root = path.resolve(dir);
  const scopes: string[] = [];
  for (const raw of patterns.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)) {
    const foldersOnly = /[\\/]$/.test(raw);
    const p = clean(raw);
    const base = path.posix.basename(p);
    if (/[*?]/.test(path.posix.dirname(p))) throw new UserError(`--over ${raw}: only the last part of a path can have * or ?`);
    if (!/[*?]/.test(base)) {
      const abs = path.resolve(root, p);
      if (!fs.existsSync(abs)) throw new UserError(`--over ${raw}: no such file or folder in ${root}`);
      scopes.push(inside(root, abs, raw));
      continue;
    }
    const parent = path.resolve(root, path.posix.dirname(p));
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const hits = (fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }) : [])
      .filter((e) => !e.name.startsWith('.') && re.test(e.name) && (!foldersOnly || e.isDirectory()))
      .map((e) => inside(root, path.join(parent, e.name), raw))
      .sort();
    if (!hits.length) throw new UserError(`--over ${raw}: matches nothing in ${root}`);
    scopes.push(...hits);
  }
  if (!scopes.length) throw new UserError('--over needs the parts to split over, e.g. --over src/auth,src/billing or --over "src/*/"');
  for (const a of scopes) {
    for (const b of scopes) {
      if (a === b && scopes.indexOf(a) !== scopes.lastIndexOf(a)) throw new UserError(`--over names ${a} twice`);
      if (a !== b && (a === '.' || b.startsWith(`${a}/`))) {
        throw new UserError(`--over: ${b} is inside ${a}, so two workers would read the same files; name parts that do not overlap`);
      }
    }
  }
  return scopes;
}

/** A part relative to the project, compared where links lead (a link to a folder elsewhere is outside). */
function inside(root: string, abs: string, raw: string): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  if (path.relative(real(root), real(abs)).startsWith('..') || path.isAbsolute(path.relative(real(root), real(abs)))) {
    throw new UserError(`--over ${raw} is outside ${root}`);
  }
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new UserError(`--over ${raw} is outside ${root}`);
  return clean(rel);
}

/** The task for one part: `{scope}` filled in, and the boundary said, since a brief that leaves it out invites a sweep. */
export function scopedTask(template: string, scope: string, mode: Mode): string {
  const keep =
    mode === 'read'
      ? 'Read only inside it: other workers cover the rest of the project, in parallel.'
      : 'Change only files inside it (read what you need elsewhere): other workers change the rest, in parallel.';
  return `${template.split('{scope}').join(scope)}\n\nYour part of the project: ${scope}. ${keep}`;
}
