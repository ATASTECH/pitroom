// A map of the project for the worker's prompt (config `repoMap`, `--map`): the files git sees in the run's directory,
// by folder, with the top-level names each source file declares. A free model otherwise spends its first steps
// listing folders and grepping for where things are. The map is a starting point, not the code: the prompt says so.
//
// Kept small (MAP_BUDGET characters): with too many names, files are listed without them; with too many files, only
// folders and their file counts. Secret-looking files are left out, names and all. A map is reused while the project
// is in the same state (the commit, and the names, sizes and times of the files changed since), so twenty workers
// started at once build it once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../vcs/git.js';
import { looksSecret } from './secrets.js';
import { home } from './store.js';

export const MAP_BUDGET = 6000;
/** Files read for their names; past this many, a map lists files only. */
const MAX_SCANNED = 3000;
const MAX_FILE_BYTES = 200_000;
const NAMES_PER_FILE = 10;
const KEEP_DAYS = 3;

/** Top-level declarations by language: the first capture group that matched is the name. */
const DECLARATIONS: [RegExp, RegExp][] = [
  [/\.(m|c)?[jt]sx?$/, /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm],
  [/\.py$/, /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm],
  [/\.go$/, /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gm],
  [/\.rs$/, /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+([A-Za-z_]\w*)/gm],
  [/\.(java|kt|cs|swift|scala)$/, /^\s{0,4}(?:public\s+|open\s+|internal\s+)?(?:final\s+|abstract\s+|sealed\s+|data\s+)?(?:class|interface|enum|record|struct|protocol|object)\s+([A-Za-z_]\w*)/gm],
  [/\.rb$/, /^(?:class|module|def)\s+([A-Za-z_][\w:.]*)/gm],
  [/\.php$/, /^(?:final\s+|abstract\s+)?(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/gm],
];

/** The names a source file declares at its top level, in order; [] for a file of no known language. */
export function declarations(file: string, text: string): string[] {
  const rule = DECLARATIONS.find(([ext]) => ext.test(file));
  if (!rule) return [];
  const names: string[] = [];
  for (const m of text.matchAll(rule[1])) if (m[1] && !names.includes(m[1])) names.push(m[1]);
  return names;
}

/** The files git sees under `dir` (tracked, and untracked ones it does not ignore), relative to it; secret-looking ones left out. */
function listFiles(dir: string): string[] {
  const r = git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']);
  if (r.code !== 0) return [];
  const seen = new Set<string>();
  for (const f of r.stdout.split('\0')) {
    if (f && !looksSecret(path.basename(f)) && fs.existsSync(path.join(dir, f))) seen.add(f);
  }
  return [...seen].sort();
}

/** Files by folder, the project's top level first, then folders in name order. */
function byFolder(files: string[]): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  for (const f of files) {
    const d = path.posix.dirname(f.split(path.sep).join('/'));
    folders.set(d, [...(folders.get(d) ?? []), path.posix.basename(f)]);
  }
  return new Map([...folders].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : a > b ? 1 : 0)));
}

const folderLabel = (d: string) => (d === '.' ? './' : `${d}/`);

/** Folders a worker rarely needs a map of: tests and their fixtures, docs, examples, assets, build output, tooling. */
const LOW = /^(\..+|tests?|__tests__|specs?|fixtures?|mocks?|docs?|examples?|samples?|benchmarks?|bench|marketing|assets|static|public|scripts|vendor|third_party|dist|build|out|coverage)$/i;
const lowValue = (d: string) => d !== '.' && d.split('/').some((seg) => LOW.test(seg));

/** One folder at one level of detail: 2 files with their names, 1 files only, 0 the folder and its file count. */
function renderFolder(d: string, list: string[], detail: number, names: Map<string, string[]>): string {
  if (detail === 0) return `${folderLabel(d)}  (${list.length} file${list.length === 1 ? '' : 's'})`;
  const lines = [folderLabel(d)];
  for (const f of list) {
    const n = detail === 2 ? (names.get(d === '.' ? f : `${d}/${f}`) ?? []) : [];
    const shown = n.slice(0, NAMES_PER_FILE).join(', ') + (n.length > NAMES_PER_FILE ? `, +${n.length - NAMES_PER_FILE} more` : '');
    lines.push(`  ${f}${shown ? `: ${shown}` : ''}`);
  }
  return lines.join('\n');
}

interface Folder {
  d: string;
  list: string[];
  named: boolean;
  low: boolean;
  detail: number;
}

/** The shortest part of a folder's path that ends in a low-value name (`test/` for `test/fixtures/a`), if any. */
function lowRoot(d: string): string | undefined {
  const segs = d.split('/');
  const i = segs.findIndex((seg) => LOW.test(seg));
  return d === '.' || i < 0 ? undefined : segs.slice(0, i + 1).join('/');
}

/** The map's text: counted folders under one low-value folder (tests, fixtures, docs) share one line. */
function renderMap(folders: Folder[], names: Map<string, string[]>): string {
  const rolled = new Map<string, { files: number; folders: number; at: number }>();
  const lines: string[] = [];
  for (const f of folders) {
    const root = f.detail === 0 ? lowRoot(f.d) : undefined;
    if (!root) {
      lines.push(renderFolder(f.d, f.list, f.detail, names));
      continue;
    }
    const r = rolled.get(root);
    if (r) {
      r.files += f.list.length;
      r.folders++;
    } else {
      rolled.set(root, { files: f.list.length, folders: 1, at: lines.push('') - 1 });
    }
  }
  for (const [root, r] of rolled) {
    lines[r.at] = `${root}/  (${r.files} file${r.files === 1 ? '' : 's'}${r.folders > 1 ? ` in ${r.folders} folders` : ''})`;
  }
  return lines.join('\n');
}

/**
 * Builds the map of `dir` within the budget. Every folder starts at full detail; while the map is too long, detail
 * goes, the longest first: whole trees of tests, docs, assets and the like (to one line with their counts), then
 * folders whose files declare no names (to a count), then the rest (names first, then the file list). Empty when git
 * lists nothing there.
 */
export function buildMap(dir: string, budget = MAP_BUDGET): string {
  const files = listFiles(dir);
  if (!files.length) return '';
  const names = new Map<string, string[]>();
  if (files.length <= MAX_SCANNED) {
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        const n = declarations(f, fs.readFileSync(full, 'utf8'));
        if (n.length) names.set(f.split(path.sep).join('/'), n);
      } catch {
        // unreadable: listed without names
      }
    }
  }
  const folders: Folder[] = [...byFolder(files)].map(([d, list]) => {
    const named = list.some((f) => names.has(d === '.' ? f : `${d}/${f}`));
    return { d, list, named, low: lowValue(d), detail: named ? 2 : 1 };
  });
  const size = (group: Folder[]) => group.reduce((n, f) => n + renderFolder(f.d, f.list, f.detail, names).length, 0);
  const largest = (groups: Folder[][]) => groups.reduce((a, b) => (size(b) > size(a) ? b : a));
  let map = renderMap(folders, names);
  while (map.length > budget) {
    const open = folders.filter((f) => f.detail > 0);
    if (!open.length) break;
    const trees = new Map<string, Folder[]>();
    for (const f of open.filter((x) => x.low)) trees.set(lowRoot(f.d)!, [...(trees.get(lowRoot(f.d)!) ?? []), f]);
    const plain = open.filter((f) => !f.named);
    if (trees.size) for (const f of largest([...trees.values()])) f.detail = 0;
    else if (plain.length) largest(plain.map((f) => [f]))[0]!.detail = 0;
    else largest(open.map((f) => [f]))[0]!.detail--;
    map = renderMap(folders, names);
  }
  return map.length <= budget ? map : `${map.slice(0, budget).replace(/\n[^\n]*$/, '')}\n… (${folders.length} folders in all)`;
}

/** What the map depends on: the directory, the commit, and the files changed since (names, sizes, times). */
function stateKey(dir: string): string | undefined {
  const head = git(dir, ['rev-parse', 'HEAD']);
  const changed = git(dir, ['ls-files', '-z', '--modified', '--others', '--deleted', '--exclude-standard', '--', '.']);
  if (changed.code !== 0) return undefined;
  const h = crypto.createHash('sha256').update(`${dir}\0${head.code === 0 ? head.stdout.trim() : 'no-commit'}\0`);
  for (const f of changed.stdout.split('\0').filter(Boolean).sort()) {
    let stat = 'gone';
    try {
      const s = fs.statSync(path.join(dir, f));
      stat = `${s.size}:${s.mtimeMs}`;
    } catch {
      // deleted
    }
    h.update(`${f}\0${stat}\0`);
  }
  return h.digest('hex').slice(0, 24);
}

const mapsDir = () => path.join(home(), 'maps');

/** The map of `dir`, reused while the project is in the same state; old maps are pruned as new ones are written. */
export function projectMap(dir: string): string {
  const key = stateKey(dir);
  const file = key && path.join(mapsDir(), `${key}.md`);
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const map = buildMap(dir);
  if (!file) return map;
  try {
    fs.mkdirSync(mapsDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, map);
    fs.renameSync(tmp, file);
    const old = Date.now() - KEEP_DAYS * 86_400_000;
    for (const f of fs.readdirSync(mapsDir())) {
      const p = path.join(mapsDir(), f);
      if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
    }
  } catch {
    // a map not kept is made again next time
  }
  return map;
}
