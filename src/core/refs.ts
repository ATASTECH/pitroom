// Hallucination guard: checks every `path:line` reference in the worker's answer
// against the files on disk, so the primary agent knows which claims hold up
// without spending tokens opening them.
import fs from 'node:fs';
import path from 'node:path';

export interface Ref {
  text: string; // as written, e.g. "src/auth.ts:12-40"
  file: string;
  start: number;
  end: number;
  symbol?: string; // a lone backticked identifier on the same line of the answer
}

export interface RefCheck {
  total: number;
  valid: number;
  invalid: { ref: string; reason: string }[];
}

/**
 * Extensions a bare `name.ext:12` can have as a file. Without a directory part, anything else
 * (`Schema.parse:432`, `orchestrator.start:638`) is a method call that only looks like a file name.
 */
const FILE_EXTENSIONS = new Set(
  ('ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rst py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs fs php lua r jl sh bash zsh fish ps1 bat ' +
    'yml yaml toml ini cfg conf env html htm css scss sass less vue svelte astro sql graphql gql proto lock xml svg csv tsv gradle tf hcl dart ex exs erl hs ml scala clj ' +
    'vim el mk cmake dockerfile gitignore gitattributes editorconfig npmrc nvmrc').split(' '),
);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.cache']);
const MAX_INDEXED = 60_000;

const EXTENSIONLESS = 'Makefile|Dockerfile|Containerfile|Gemfile|Rakefile|Procfile|Justfile|Vagrantfile|BUILD|WORKSPACE';
// Not preceded by a word char, "/" or ":" (rules out URLs like https://host:8080).
const REF = new RegExp(
  String.raw`(?<![\w/:.-])(\.{0,2}/?(?:[\w@.+-]+/)*(?:[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7}|${EXTENSIONLESS})):(\d+)(?:[-–](\d+))?`,
  'g',
);
const IDENT = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g;
// Clause boundaries: ';' '|' '—', a sentence end, or ': ' ("Order (x.ts:1): iteration follows `f()`").
const CLAUSE = /[;|—]|\.\s|:\s/g;
const MAX_BYTES = 5 * 1024 * 1024;
const WINDOW = 5;
const DEFINITION_LOOKBACK = 80;

/**
 * Backticked words that are probably code symbols rather than commands or plain
 * words (`rg`, `git`, `ls`): called like `f()`, or with a capital, underscore,
 * `$` or digit, or at least five characters long.
 */
function looksLikeSymbol(m: RegExpMatchArray): boolean {
  const name = m[1]!;
  return m[0].includes('(') || /[A-Z_$0-9]/.test(name) || name.length >= 5;
}

export function extractRefs(answer: string): Ref[] {
  const seen = new Map<string, Ref>();
  for (const line of answer.split('\n')) {
    const matches = [...line.matchAll(REF)];
    const seps = [...line.matchAll(CLAUSE)].map((s) => s.index ?? 0);
    const sepBetween = (a: number, b: number) => seps.some((s) => s >= a && s < b);
    // An identifier between two references of the same clause ("`a` in x.ts:1, `b` in y.ts:2"
    // vs "x.ts:1 has `a`, y.ts:2 has `b`") could belong to either: skip it rather than guess.
    const idents = [...line.matchAll(IDENT)].filter((i) => {
      if (!looksLikeSymbol(i)) return false;
      const pos = i.index ?? 0;
      const before = matches.filter((m) => (m.index ?? 0) + m[0].length <= pos).at(-1);
      const after = matches.find((m) => (m.index ?? 0) >= pos + i[0].length);
      return !(before && after && !sepBetween((before.index ?? 0) + before[0].length, after.index ?? 0));
    });
    matches.forEach((m, k) => {
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      if (start < 1 || end < start) return;
      // An identifier is the reference's subject only if it sits in the same clause,
      // with no other reference in between, and is the only one there.
      const at = m.index ?? 0;
      const prev = matches[k - 1];
      const next = matches[k + 1];
      const from = Math.max(at - 80, prev ? (prev.index ?? 0) + prev[0].length : 0, ...seps.filter((s) => s < at).map((s) => s + 1));
      const to = Math.min(at + m[0].length + 40, next?.index ?? Infinity, ...seps.filter((s) => s >= at + m[0].length));
      const near = new Set(idents.filter((i) => (i.index ?? 0) >= from && (i.index ?? 0) < to).map((i) => i[1]!));
      const symbol = near.size === 1 ? [...near][0] : undefined;
      // The same location claimed for two different symbols is two claims.
      const key = `${m[1]}:${start}-${end}:${symbol ?? ''}`;
      if (!seen.has(key)) seen.set(key, { text: m[0], file: m[1]!, start, end, symbol });
    });
  }
  return [...seen.values()];
}

/** `dirs` are tried in order; absolute paths must live inside one of them. */
export function verifyRefs(refs: Ref[], dirs: string[]): RefCheck {
  const roots = [...new Set(dirs.filter(Boolean).map((d) => path.resolve(d)))];
  const invalid: RefCheck['invalid'] = [];
  const lineCache = new Map<string, string[] | null>();
  const load = (file: string) => {
    if (!lineCache.has(file)) {
      const size = fs.statSync(file).size;
      const lines = size > MAX_BYTES ? null : fs.readFileSync(file, 'utf8').split('\n');
      if (lines && lines[lines.length - 1] === '') lines.pop();
      lineCache.set(file, lines);
    }
    return lineCache.get(file)!;
  };

  // A worker often writes `ipc.ts:218` or `src/main/ipc.ts:218` for `apps/desktop/src/main/ipc.ts`: when the
  // path does not resolve as written, any file of the project that ends with it is a candidate.
  let index: Map<string, string[]> | undefined;
  const byName = () => (index ??= indexFiles(roots));
  const candidates = (ref: Ref): string[] => {
    const direct = resolve(ref.file, roots);
    if (direct) return [direct];
    if (path.isAbsolute(ref.file)) return [];
    const wanted = ref.file.replace(/^(\.{1,2}\/)+/, '');
    return (byName().get(path.basename(wanted)) ?? []).filter((f) => f.endsWith(`/${wanted}`) || path.basename(f) === wanted).slice(0, 20);
  };
  // Why a candidate does not hold up, or undefined when it does.
  const check = (file: string, ref: Ref): string | undefined => {
    const lines = load(file);
    if (!lines) return undefined; // too large to check lines; existence is enough
    if (ref.end > lines.length) return `file has ${lines.length} lines`;
    if (ref.symbol && !mentions(lines, ref) && !enclosedBy(lines, ref)) return `\`${ref.symbol}\` not near line ${ref.start}`;
    return undefined;
  };

  let total = 0;
  for (const ref of refs) {
    const files = candidates(ref);
    if (!files.length) {
      // `Schema.parse:432` is a method, not a file: not a reference at all.
      if (!ref.file.includes('/') && !isFileName(ref.file)) continue;
      total++;
      invalid.push({ ref: ref.text, reason: path.isAbsolute(ref.file) && !inside(ref.file, roots) ? 'outside the project' : 'file not found' });
      continue;
    }
    total++;
    const reasons = files.map((f) => check(f, ref));
    if (!reasons.some((r) => r === undefined)) invalid.push({ ref: ref.text, reason: files.length > 1 ? `${reasons[0]} (${files.length} files match)` : reasons[0]! });
  }
  return { total, valid: total - invalid.length, invalid };
}

/** The symbol appears within a few lines of the referenced range. */
function mentions(lines: string[], ref: Ref): boolean {
  const near = lines.slice(Math.max(0, ref.start - 1 - WINDOW), ref.end + WINDOW).join('\n');
  return new RegExp(`(^|[^\\w$])${escape(ref.symbol!)}([^\\w$]|$)`).test(near);
}

/** "`fn()` at x.ts:140-144" where 140-144 is inside fn: its definition sits a little above. */
function enclosedBy(lines: string[], ref: Ref): boolean {
  const name = escape(ref.symbol!);
  const def = new RegExp(
    `\\b(function|def|fn|func|class|interface|struct|impl|type|const|let|var)\\s+\\*?${name}\\b|^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(static\\s+)?${name}\\s*[(:=]`,
  );
  return lines.slice(Math.max(0, ref.start - 1 - DEFINITION_LOOKBACK), ref.start).some((l) => def.test(l));
}

const isFileName = (name: string) => {
  const base = path.basename(name);
  return !base.includes('.') || new RegExp(`^(${EXTENSIONLESS})$`).test(base) || FILE_EXTENSIONS.has(base.split('.').pop()!.toLowerCase());
};

/** Basename → absolute paths of the project's files (heavy and generated directories skipped, capped). */
function indexFiles(roots: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_INDEXED) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
        const list = index.get(e.name);
        if (list) list.push(path.join(dir, e.name));
        else index.set(e.name, [path.join(dir, e.name)]);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}

function resolve(ref: string, roots: string[]): string | undefined {
  const candidates = path.isAbsolute(ref) ? (inside(ref, roots) ? [ref] : []) : roots.map((r) => path.join(r, ref));
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile() && inside(c, roots);
    } catch {
      return false;
    }
  });
}

function inside(file: string, roots: string[]): boolean {
  return roots.some((r) => {
    const rel = path.relative(r, path.resolve(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
