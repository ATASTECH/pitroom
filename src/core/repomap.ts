// A map of the project for the worker's prompt (config `repoMap`, `--map`): the files git sees in the run's directory,
// by folder, with the top-level names each source file declares. A free model otherwise spends its first steps
// listing folders and grepping for where things are. The map is a starting point, not the code: the prompt says so.
//
// It is kept to a budget (config `repoMapTokens`, ~1,500 tokens) however big the project, and spent where the task
// is: folders, files and names that share words with the task keep their detail, the rest gives it up, the least
// useful first (tests, docs, assets and the like, then deep folders, then shallow ones): first a file's names, then
// the folder's file list, then the whole subtree becomes one line with its counts. Every part of the project keeps
// at least a line, so a big repository is an overview with the task's corner in detail, never a list cut short.
//
// Secret-looking files are left out, names and all. The names are read once per file content (git's blob id, or the
// size and time of a changed or untracked file) and kept per project, so a big repository is read in full once and
// a crew of workers started together reads almost nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../vcs/git.js';
import { looksSecret } from './secrets.js';
import { home } from './store.js';

/** The default budget, in tokens (~4 characters each); `repoMapTokens` changes it. */
export const MAP_TOKENS = 1500;
export const MIN_MAP_TOKENS = 300;
export const MAX_MAP_TOKENS = 8000;
/** Files read for their names in one build (the ones not known yet); the rest are listed without names. */
const MAX_SCANNED = 4000;
const MAX_FILE_BYTES = 200_000;
const NAMES_PER_FILE = 10;
/** The files a map keeps in detail for the task, at most. */
const RELEVANT_FILES = 40;
/** With a task to focus on, the map is cut down to this share of the budget by what is not about the task. */
const FOCUSED_SHARE = 0.6;
const KEEP_DAYS = 14;

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

const canRead = (file: string) => DECLARATIONS.some(([ext]) => ext.test(file));

// ── the task's words ──────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
  ('the and for with from into that this then than when where what which while how why who are was were has have had ' +
    'not but all any can could should would will shall may might must one two its their there here them they you your ' +
    'our out use used using make made add fix find show tell give take keep also only each every some more most file ' +
    'files code line lines function functions method class type value name names call calls return returns new old ' +
    'change changes test summary details answer task does doing done like just about please run runs').split(' '),
);

/** Words of an identifier or path: camelCase, snake_case, kebab-case and dots split, lower case. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** What the task is about, as words a folder, file or name can share with it. */
export function taskWords(task: string): Set<string> {
  return new Set(words(task).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)));
}

/** A word without its plural "s" (sessions, session), so the two count as the same word. */
const singular = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** Two words are alike when one starts the other and both are 4 letters or more (auth, authentication): a weaker match. */
const like = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
/** What an alike word counts for, against the same word. */
const ALIKE = 0.3;

/**
 * How much each file is about the task: the task's words its path and declared names share, each weighed by how
 * rare it is in the project (log(files / files with it)). In a big repository "main" or "handler" are everywhere and
 * say little; "ipc" or "bounds" say where to look. A word that is only alike (import for importers) counts ALIKE of
 * that, weighed by how rare the alike words are. Only the best files count (half the best score or more, at most
 * RELEVANT_FILES): a word that matches a little everywhere does not spread the detail thin.
 */
function relevance(files: string[], names: Map<string, string[]>, wanted: Set<string>): Map<string, number> {
  const scores = new Map<string, number>();
  if (!wanted.size) return scores;
  const want = [...new Set([...wanted].map(singular))];
  const hits = files.map((f) => {
    const doc = new Set([...words(f), ...(names.get(f) ?? []).flatMap(words)].map(singular));
    const same = want.filter((w) => doc.has(w));
    return { same, alike: want.filter((w) => !doc.has(w) && [...doc].some((d) => like(d, w))) };
  });
  const df = new Map<string, number>();
  const dfAlike = new Map<string, number>();
  for (const h of hits) {
    for (const w of h.same) df.set(w, (df.get(w) ?? 0) + 1);
    for (const w of h.alike) dfAlike.set(w, (dfAlike.get(w) ?? 0) + 1);
  }
  const idf = (n: number) => Math.log((files.length + 1) / (n + 1));
  const all = files.map((f, i) => {
    const h = hits[i]!;
    const s = h.same.reduce((t, w) => t + idf(df.get(w)!), 0) + h.alike.reduce((t, w) => t + ALIKE * idf((df.get(w) ?? 0) + dfAlike.get(w)!), 0);
    return [f, s] as const;
  });
  // the task's corner: the files that score at least half the best one, the best RELEVANT_FILES of them
  const best = Math.max(0, ...all.map(([, s]) => s));
  const top = all.filter(([, s]) => s > 0 && s >= best / 2).sort((a, b) => b[1] - a[1]).slice(0, RELEVANT_FILES);
  for (const [f, s] of top) scores.set(f, s);
  return scores;
}

// ── the files and their names ─────────────────────────────────────────────────────────────────────

interface Listing {
  /** Files under the directory, relative to it with "/", sorted; secret-looking ones left out. */
  files: string[];
  /** What a file's names are kept under: its blob id, or for a changed or untracked file its size and time. */
  keys: Map<string, string>;
}

const posix = (f: string) => f.split(path.sep).join('/');

/** The files git sees under `dir` (tracked, and untracked ones it does not ignore). */
function listFiles(dir: string): Listing {
  const tracked = git(dir, ['ls-files', '-z', '--stage', '--', '.']);
  if (tracked.code !== 0) return { files: [], keys: new Map() };
  const keys = new Map<string, string>();
  for (const entry of tracked.stdout.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) \d+\t(.+)$/.exec(entry);
    if (m) keys.set(posix(m[2]!), m[1]!);
  }
  const changed = new Set(git(dir, ['ls-files', '-z', '--modified', '--', '.']).stdout.split('\0').filter(Boolean).map(posix));
  for (const f of git(dir, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']).stdout.split('\0').filter(Boolean)) {
    keys.set(posix(f), '');
    changed.add(posix(f));
  }
  const files: string[] = [];
  for (const f of [...keys.keys()].sort()) {
    if (looksSecret(path.posix.basename(f))) continue;
    if (changed.has(f)) {
      try {
        const s = fs.statSync(path.join(dir, f));
        if (!s.isFile()) continue;
        keys.set(f, `${f}\0${s.size}\0${s.mtimeMs}`);
      } catch {
        continue; // deleted in the working tree
      }
    }
    files.push(f);
  }
  return { files, keys };
}

const mapsDir = () => path.join(home(), 'maps');
const namesFile = (dir: string) => path.join(mapsDir(), `names-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16)}.json`);

function loadNames(dir: string): Record<string, string[]> {
  try {
    const data = JSON.parse(fs.readFileSync(namesFile(dir), 'utf8'));
    return data && typeof data.names === 'object' ? data.names : {};
  } catch {
    return {};
  }
}

/** Keeps the names of the files seen now (the old ones of files gone are dropped), and prunes other projects' unused files. */
function saveNames(dir: string, names: Record<string, string[]>): void {
  try {
    fs.mkdirSync(mapsDir(), { recursive: true });
    const file = namesFile(dir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, names }));
    fs.renameSync(tmp, file);
    const old = Date.now() - KEEP_DAYS * 86_400_000;
    for (const f of fs.readdirSync(mapsDir())) {
      const p = path.join(mapsDir(), f);
      if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
    }
  } catch {
    // names not kept are read again next time
  }
}

// ── the tree ──────────────────────────────────────────────────────────────────────────────────────

interface Node {
  /** "." for the directory itself, else "a/b". */
  path: string;
  depth: number;
  files: string[];
  children: Node[];
  parent?: Node;
  /** Files and folders in the subtree, this folder included. */
  totalFiles: number;
  totalFolders: number;
  /** How much the task is about this folder (its most relevant file), and its worth to the map (see score()). */
  score: number;
  value: number;
  /** The highest value in the subtree: what collapsing it loses. */
  subtreeValue: number;
  /** 2: files with their names, 1: files only, 0: the folder and its file count. */
  detail: number;
  collapsed: boolean;
  /** The subtree holds a file the task is about. */
  hot: boolean;
  /** Its children that hold nothing the task is about are shown as one line (an open folder on the task's path). */
  folded: boolean;
}

/** Folders a worker rarely needs a map of: tests and their fixtures, docs, examples, assets, build output, tooling. */
const LOW = /^(\..+|tests?|__tests__|specs?|fixtures?|mocks?|docs?|examples?|samples?|benchmarks?|bench|marketing|assets|static|public|scripts|vendor|third_party|dist|build|out|coverage)$/i;

function buildTree(files: string[]): Node {
  const make = (p: string, parent?: Node): Node => ({
    path: p,
    depth: parent ? parent.depth + 1 : 0,
    files: [],
    children: [],
    parent,
    totalFiles: 0,
    totalFolders: 1,
    score: 0,
    value: 0,
    subtreeValue: 0,
    detail: 2,
    collapsed: false,
    hot: false,
    folded: false,
  });
  const root = make('.');
  const index = new Map<string, Node>([['.', root]]);
  const folder = (p: string): Node => {
    const known = index.get(p);
    if (known) return known;
    const parent = folder(path.posix.dirname(p));
    const node = make(p, parent);
    parent.children.push(node);
    index.set(p, node);
    return node;
  };
  for (const f of files) folder(path.posix.dirname(f)).files.push(path.posix.basename(f));
  const count = (n: Node): void => {
    n.children.sort((a, b) => (a.path < b.path ? -1 : 1));
    n.totalFiles = n.files.length;
    n.totalFolders = 1;
    for (const c of n.children) {
      count(c);
      n.totalFiles += c.totalFiles;
      n.totalFolders += c.totalFolders;
    }
  };
  count(root);
  return root;
}

const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
const fileOf = (n: Node, f: string) => (n.path === '.' ? f : `${n.path}/${f}`);
const label = (n: Node) => (n.path === '.' ? './' : `${n.path}/`);

/**
 * A folder's worth to the map: more where the task is (the relevance of its most relevant file), less for tests,
 * docs and the like, and less the deeper it is.
 */
function score(root: Node, rel: Map<string, number>): void {
  for (const n of nodes(root)) {
    n.score = Math.max(0, ...n.files.map((f) => rel.get(fileOf(n, f)) ?? 0));
    const low = n.path.split('/').some((seg) => LOW.test(seg));
    // deeper is worth less where the task is not; where it is, the relevance decides
    n.value = (1 / (1 + 0.5 * n.depth) + n.score * 3) * (low ? 0.2 : 1);
  }
  const up = (n: Node): number => (n.subtreeValue = Math.max(n.value, ...n.children.map(up)));
  up(root);
  // every child is heated (no short circuit: a folder with a relevant file of its own still has children to mark)
  const heat = (n: Node): boolean => {
    const below = n.children.map(heat).some(Boolean);
    return (n.hot = below || n.files.some((f) => rel.has(fileOf(n, f))));
  };
  heat(root);
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────

const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

interface Known {
  names: Map<string, string[]>;
  rel: Map<string, number>;
}

/**
 * The lines a visible folder writes itself (its children write their own): none for a folder that only holds
 * folders. The files the task is about keep their line and names at every detail but a collapsed subtree.
 */
function ownText(n: Node, k: Known): string {
  if (n.collapsed) {
    return `${label(n)}  (${plural(n.totalFiles, 'file')}${n.totalFolders > 1 ? ` in ${n.totalFolders} folders` : ''})`;
  }
  if (!n.files.length) return '';
  const line = (f: string, withNames: boolean) => {
    const list = withNames ? (k.names.get(fileOf(n, f)) ?? []) : [];
    const shown = list.slice(0, NAMES_PER_FILE).join(', ') + (list.length > NAMES_PER_FILE ? `, +${list.length - NAMES_PER_FILE} more` : '');
    return `  ${f}${shown ? `: ${shown}` : ''}`;
  };
  const relevant = (f: string) => k.rel.has(fileOf(n, f));
  if (n.detail === 0) {
    const kept = n.files.filter(relevant);
    return [`${label(n)}  (${plural(n.files.length, 'file')}${kept.length ? `; the task's ${kept.length}:` : ''})`, ...kept.map((f) => line(f, true))].join('\n');
  }
  return [label(n), ...n.files.map((f) => line(f, n.detail === 2 || relevant(f)))].join('\n');
}

/** The one line for an open folder's children that hold nothing the task is about. */
function foldText(n: Node): string {
  const cold = n.children.filter((c) => !c.hot);
  if (!n.folded || !cold.length) return '';
  const files = cold.reduce((t, c) => t + c.totalFiles, 0);
  const folders = cold.reduce((t, c) => t + c.totalFolders, 0);
  return `${n.path === '.' ? '' : `${n.path}/`}…  (${plural(files, 'more file')} in ${plural(folders, 'other folder')})`;
}

function render(root: Node, k: Known): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    const own = ownText(n, k);
    if (own) out.push(own);
    if (n.collapsed) return;
    const fold = foldText(n);
    if (fold) out.push(fold);
    for (const c of n.children) if (!n.folded || c.hot) walk(c);
  };
  walk(root);
  return out.join('\n');
}

/**
 * Gives up detail until the map fits, the actions that lose the least first. Losing a folder's names costs its
 * value, its file list twice that, collapsing a subtree three times the highest value in it: deep, cold subtrees go
 * before shallow ones, and a subtree that holds the task's corner stays open the longest. An open folder on the
 * task's path can fold its other children into one line, at a loss that grows near the top (the overview of the
 * top folders goes last). With a task to focus on, what is not about it is cut down to FOCUSED_SHARE of the budget
 * even when the whole would fit: a shorter map, and less to wade through.
 */
function fit(root: Node, k: Known, budget: number): void {
  const size = (n: Node) => {
    const t = ownText(n, k);
    return t ? t.length + 1 : 0;
  };
  const foldSize = (n: Node) => {
    const t = foldText(n);
    return t ? t.length + 1 : 0;
  };
  const visible = (n: Node): number =>
    size(n) + (n.collapsed ? 0 : foldSize(n) + n.children.reduce((s, c) => s + (n.folded && !c.hot ? 0 : visible(c)), 0));
  let total = visible(root);
  const focused = root.hot;
  const coldTarget = focused ? budget * FOCUSED_SHARE : budget;
  if (total <= coldTarget) return;
  type Action = { loss: number; node: Node; kind: 'names' | 'list' | 'collapse' | 'fold' };
  const actions: Action[] = [];
  for (const n of nodes(root)) {
    // a long list says less per line: past 10 files, the loss of dropping it shrinks with its length
    const per = (count: number) => 10 / Math.max(10, count);
    const named = n.files.filter((f) => k.names.has(fileOf(n, f))).length;
    if (named) actions.push({ loss: n.value * per(named), node: n, kind: 'names' });
    if (n.files.length) actions.push({ loss: n.value * 2 * per(n.files.length), node: n, kind: 'list' });
    if (n !== root) actions.push({ loss: n.subtreeValue * 3, node: n, kind: 'collapse' });
    const cold = n.children.filter((c) => !c.hot);
    // the top folders' lines are the overview: folded last
    if (n.hot && cold.length > 1) actions.push({ loss: Math.max(...cold.map((c) => c.subtreeValue)) * 3 * (n === root ? 100 : 1 + 2 / n.depth), node: n, kind: 'fold' });
  }
  // the least loss first; for the same loss the deeper folder, then the bigger one
  actions.sort((a, b) => a.loss - b.loss || b.node.depth - a.node.depth || b.node.totalFiles - a.node.totalFiles);
  const hidden = (n: Node) => {
    for (let c = n, p = n.parent; p; c = p, p = p.parent) if (p.collapsed || (p.folded && !c.hot)) return true;
    return false;
  };
  for (const a of actions) {
    const n = a.node;
    // an action on what is not about the task (or folding it away) goes on to the focused target; the rest, to the budget
    const cold = a.kind === 'fold' ? n !== root : !n.hot;
    if (total <= (cold ? coldTarget : budget)) continue;
    if (n.collapsed || hidden(n)) continue;
    if (a.kind === 'collapse' || a.kind === 'fold') {
      const before = visible(n);
      if (a.kind === 'collapse') n.collapsed = true;
      else n.folded = true;
      total += visible(n) - before;
    } else {
      const want = a.kind === 'names' ? 1 : 0;
      if (n.detail <= want) continue;
      const before = size(n);
      n.detail = want;
      total += size(n) - before;
    }
  }
}

export interface MapStats {
  files: number;
  folders: number;
  /** Files whose names were read now, and those already known. */
  read: number;
  known: number;
}

/**
 * Builds the map of `dir` for `task` within `tokens` (about 4 characters each). Empty when git lists nothing there.
 * The names read are kept for the next build.
 */
export function buildMap(dir: string, opts: { task?: string; tokens?: number; fresh?: boolean } = {}): { text: string; stats: MapStats } {
  const budget = Math.min(Math.max(opts.tokens ?? MAP_TOKENS, MIN_MAP_TOKENS), MAX_MAP_TOKENS) * 4;
  const { files, keys } = listFiles(dir);
  const stats: MapStats = { files: files.length, folders: 0, read: 0, known: 0 };
  if (!files.length) return { text: '', stats };
  const root = buildTree(files);
  stats.folders = root.totalFolders;
  const wanted = taskWords(opts.task ?? '');

  // names: those known for this content, then new ones (the task's folders first, then by worth) up to MAX_SCANNED
  const kept = opts.fresh ? {} : loadNames(dir);
  const next: Record<string, string[]> = {};
  const names = new Map<string, string[]>();
  const unread: string[] = [];
  for (const f of files) {
    if (!canRead(f)) continue;
    const key = keys.get(f)!;
    if (Object.hasOwn(kept, key)) {
      next[key] = kept[key]!;
      if (kept[key]!.length) names.set(f, kept[key]!);
      stats.known++;
    } else unread.push(f);
  }
  // what is not read yet is read by worth: its own relevance (by path, before any names are known), then its folder's
  const early = relevance(files, names, wanted);
  score(root, early);
  const worth = new Map(nodes(root).map((n) => [n.path, n.subtreeValue + n.value]));
  const worthOf = (f: string) => (early.get(f) ?? 0) * 10 + (worth.get(path.posix.dirname(f)) ?? 0);
  unread.sort((a, b) => worthOf(b) - worthOf(a));
  for (const f of unread.slice(0, MAX_SCANNED)) {
    let list: string[] = [];
    try {
      const full = path.join(dir, f);
      if (fs.statSync(full).size <= MAX_FILE_BYTES) list = declarations(f, fs.readFileSync(full, 'utf8'));
    } catch {
      // unreadable: listed without names
    }
    next[keys.get(f)!] = list;
    if (list.length) names.set(f, list);
    stats.read++;
  }
  if (stats.read || Object.keys(next).length !== Object.keys(kept).length) saveNames(dir, next);

  const known: Known = { names, rel: relevance(files, names, wanted) };
  score(root, known.rel);
  fit(root, known, budget);
  const text = render(root, known);
  return { text: text.length <= budget ? text : `${text.slice(0, budget).replace(/\n[^\n]*$/, '')}\n… (${root.totalFolders} folders in all)`, stats };
}

/** The map of `dir` for a run's prompt: its task decides where the detail goes. */
export function projectMap(dir: string, task: string, tokens?: number): string {
  return buildMap(dir, { task, tokens }).text;
}
