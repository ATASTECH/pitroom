#!/usr/bin/env node
// Adds the "equivalent" packages: one or two edits that look like the planted bugs (a comparison
// changed on one line) but cannot change what the code does, by construction. A Critical or Important
// finding on one of them is a false alarm. Appended to manifest.json after the existing packages,
// which stay as they were (their results remain valid).
//   mirror   the operands of a comparison swapped and the operator mirrored: `i < n` -> `n > i`,
//            `a.x === b` -> `b === a.x`
// Only where both operands are plain (a name, a dotted name, a number, a simple string) and what is
// around the comparison binds more loosely than it (an opening bracket, a comma, `&&`, `||`, `return`,
// `if`, ...), so the edit is the same expression. Never in comments, strings or docstrings. Never a
// literal moved to the left (`null !== x`: a lint rule may forbid it), and no added parentheses
// (gofmt, black and Prettier remove them, so CI would rightly complain): the formatters and linters
// these repositories run leave a mirrored comparison alone.
//
// A repository that commits its build output (Pitroom's dist/: "commit the rebuilt files with your
// change") gets the same mirror there, as a rebuild would (esbuild keeps the operand order); a
// comparison that is not exactly once in it is not used. Without that, a reviewer rightly asks for
// the rebuilt files.
//
//   node equiv.mjs --repos ~/workspace/bench-repos [--per-repo 4] [--redo pitroom]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const reposDir = path.resolve((args.repos ?? '~/workspace/bench-repos').replace(/^~/, os.homedir()));
const PER_REPO = Number(args['per-repo'] ?? 4);

const REPOS = {
  react: { lang: 'js', ext: ['.js'], roots: ['packages/react-reconciler/src', 'packages/react-dom/src', 'packages/react/src', 'packages/scheduler/src'] },
  django: { lang: 'py', ext: ['.py'], roots: ['django/db', 'django/utils', 'django/http', 'django/core'] },
  kubernetes: { lang: 'go', ext: ['.go'], roots: ['pkg/kubelet', 'pkg/scheduler', 'pkg/proxy', 'staging/src/k8s.io/apimachinery/pkg/util'] },
  pitroom: { lang: 'ts', ext: ['.ts'], roots: ['src/core', 'src/backends'], generated: ['dist/pitroom.mjs', 'dist/lib.mjs'] },
};

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });

const RESERVED = {
  js: ['typeof', 'instanceof', 'in', 'new', 'await', 'void', 'delete', 'yield', 'return', 'case', 'of', 'as'],
  py: ['not', 'in', 'is', 'and', 'or', 'lambda', 'await', 'if', 'else', 'return', 'yield'],
  go: ['range', 'return', 'go', 'func', 'case', 'chan'],
};
RESERVED.ts = RESERVED.js;

// What may stand right before the left operand and right after the right one: things that bind more
// loosely than a comparison. A line end only in Go, where a newline ends the expression; in JS and
// Python the next line could continue it with an operator that binds tighter.
const LEFT = {
  js: String.raw`(?:[(\[{,;]\s*|(?<![=!<>])=\s*|=>\s*|&&\s*|\|\|\s*|\?\s*|\b(?:return|if|while)\s+)`,
  py: String.raw`(?:[(\[{,]\s*|(?<![=!<>])=\s*|\b(?:return|if|elif|while|and|or|not|assert)\s+)`,
  go: String.raw`(?:[(\[{,;]\s*|(?<![=!<>])=\s*|&&\s*|\|\|\s*|\b(?:return|if)\s+)`,
};
LEFT.ts = LEFT.js;
const RIGHT = {
  js: String.raw`(?=\s*(?:\)|\]|\}|,|;|&&|\|\||\?|:|\{))`,
  py: String.raw`(?=\s*(?:\)|\]|\}|,|:|\band\b|\bor\b|\bif\b|\belse\b))`,
  go: String.raw`(?=\s*(?:\)|\]|\}|,|;|&&|\|\||\{|$))`,
};
RIGHT.ts = RIGHT.js;
const OPS = { js: ['===', '!==', '<=', '>=', '<', '>'], py: ['==', '!=', '<=', '>=', '<', '>'], go: ['==', '!=', '<=', '>=', '<', '>'] };
OPS.ts = OPS.js;
const MIRROR = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
// a literal: it would end up on the left, the "Yoda" form a lint rule may forbid
const LITERAL = /^(?:\d|['"]|(?:null|undefined|true|false|None|True|False|nil)$)/;

const atom = (lang) => String.raw`(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+(?:\.\d+)?|'[^'\\]*'|"[^"\\]*")`.replace(lang === 'py' || lang === 'go' ? /\$/g : /(?!)/, '');

/** Every comparison on the line that can be mirrored without changing the expression. */
export function comparisons(line, lang) {
  const ops = OPS[lang].map((o) => o.replace(/[<>=!]/g, (c) => `\\${c}`)).join('|');
  const re = new RegExp(`(${LEFT[lang]})(${atom(lang)}) (${ops}) (${atom(lang)})${RIGHT[lang]}`, 'g');
  const out = [];
  for (const m of line.matchAll(re)) {
    const [, lead, a, op, b] = m;
    const start = m.index + lead.length;
    const end = start + a.length + op.length + b.length + 2;
    if ([a, b].some((x) => RESERVED[lang].includes(x)) || a === b) continue;
    const before = line.slice(0, start);
    // not in a trailing comment, and not inside a string
    if (/\/\/|#/.test(before) || ((before.match(/["'`]/g) ?? []).length % 2) === 1) continue;
    if (LITERAL.test(b)) continue;
    out.push({ start, end, a, op, b });
  }
  return out;
}

/** The comparison as written, and mirrored. */
export const mirror = (c) => ({ from: `${c.a} ${c.op} ${c.b}`, to: `${c.b} ${MIRROR[c.op] ?? c.op} ${c.a}` });

/** Where a comparison stands in a file, as a whole expression (not part of a longer name). */
const occurrences = (text, cmp) => [...text.matchAll(new RegExp(`(?<![\\w$.])${cmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g'))].map((m) => m.index);

/** The line with the comparison mirrored. */
export function rewrite(line, c) {
  return line.slice(0, c.start) + `${c.b} ${MIRROR[c.op] ?? c.op} ${c.a}` + line.slice(c.end);
}

/** Line numbers that are code: not in a block comment, a docstring, a template literal or a raw string. */
function codeLines(lines, lang) {
  const ok = [];
  let open = null; // the token that closes what we are inside
  lines.forEach((l, i) => {
    const wasOpen = open;
    for (const tok of l.match(lang === 'py' ? /"""|'''/g : /\/\*|\*\/|`/g) ?? []) {
      if (open) { if (tok === open) open = null; } else if (tok !== '*/') open = tok === '/*' ? '*/' : tok;
    }
    const comment = /^\s*(\/\/|#|\*|\/\*)/.test(l);
    if (!wasOpen && !open && !comment && l.trim()) ok.push(i);
  });
  return ok;
}

function syntaxOk(lang, text) {
  try {
    if (lang === 'py') { const t = path.join(os.tmpdir(), `equiv-${process.pid}.py`); fs.writeFileSync(t, text); execFileSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', t], { stdio: 'pipe' }); }
    if (lang === 'go') execFileSync('gofmt', ['-e'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function sourceFiles(dir, cfg) {
  return git(dir, 'ls-files', '--', ...cfg.roots).split('\n').filter((f) => cfg.ext.some((e) => f.endsWith(e)) && !/(test|spec|mock|fake|generated|zz_|\.pb\.|__tests__|testdata|fixtures)/i.test(f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestFile = path.join(here, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // --redo REPO makes that repository's packages again, under the same ids; their results no longer apply
  const redo = args.redo;
  const ids = redo ? manifest.filter((m) => m.kind === 'equiv' && m.repo === redo).map((m) => m.id) : [];
  if (redo && !ids.length) throw new Error(`no equivalent packages of ${redo} to redo`);
  if (!redo && manifest.some((m) => m.kind === 'equiv')) throw new Error('manifest.json already has the equivalent packages (--redo REPO makes one again)');
  const keep = manifest.filter((m) => !ids.includes(m.id));
  manifest.length = 0;
  manifest.push(...keep);
  let n = manifest.length;
  const nextId = () => ids.shift() ?? `p${String(++n).padStart(2, '0')}`;
  for (const [repo, cfg] of Object.entries(REPOS)) {
    if (redo && repo !== redo) continue;
    const dir = path.join(reposDir, repo);
    if (!fs.existsSync(dir)) { console.log(`skip ${repo}: not cloned in ${reposDir}`); continue; }
    if (git(dir, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error(`${repo} has local changes`);
    const base = manifest.find((m) => m.repo === repo)?.base ?? git(dir, 'rev-parse', 'HEAD').trim();
    const used = new Set(manifest.filter((m) => m.repo === repo).map((m) => m.file));
    const r = rng(20261025 + repo.length);
    // files no other package changed first; each package is reviewed on its own, so one may reuse a file
    const sized = shuffle(sourceFiles(dir, cfg), r).filter((f) => {
      const c = git(dir, 'show', `${base}:${f}`).split('\n').length;
      return c >= 60 && c <= 500;
    });
    const files = [...sized.filter((f) => !used.has(f)), ...sized.filter((f) => used.has(f))];
    // half the packages with one edit, half with two (in the same file, on different lines)
    const plan = shuffle([...Array(Math.ceil(PER_REPO / 2)).fill(1), ...Array(Math.floor(PER_REPO / 2)).fill(2)], r);
    let fi = 0;
    for (const count of plan) {
      let made = null;
      while (!made && fi < files.length) {
        const file = files[fi++];
        const lines = git(dir, 'show', `${base}:${file}`).split('\n');
        const generated = Object.fromEntries((cfg.generated ?? []).map((g) => [g, git(dir, 'show', `${base}:${g}`)]));
        // in the build output once, in the main bundle at least, or the rebuilt file could not be made to match
        const inBuild = (c) => !cfg.generated || (occurrences(generated[cfg.generated[0]], mirror(c).from).length === 1 && Object.values(generated).every((t) => occurrences(t, mirror(c).from).length <= 1));
        const spots = codeLines(lines, cfg.lang).flatMap((i) => comparisons(lines[i], cfg.lang).filter(inBuild).slice(0, 1).map((c) => ({ i, c })));
        if (spots.length < count) continue;
        const edits = shuffle(spots, r).slice(0, count).sort((x, y) => x.i - y.i).map(({ i, c }) => ({ i, c, before: lines[i], after: rewrite(lines[i], c) }));
        if (new Set(edits.map((e) => mirror(e.c).from)).size < edits.length) continue; // two edits of one comparison: the build output has it once
        const changed = [...lines];
        for (const e of edits) changed[e.i] = e.after;
        if (!syntaxOk(cfg.lang, changed.join('\n'))) continue;
        const id = nextId();
        git(dir, 'checkout', '-q', '-B', `bench/${id}`, base);
        fs.writeFileSync(path.join(dir, file), changed.join('\n'));
        git(dir, 'add', file);
        for (const [g, text] of Object.entries(generated)) {
          let out = text;
          for (const e of edits) {
            const { from, to } = mirror(e.c);
            const [at] = occurrences(out, from);
            if (at !== undefined) out = out.slice(0, at) + to + out.slice(at + from.length);
          }
          if (out !== text) { fs.writeFileSync(path.join(dir, g), out); git(dir, 'add', g); }
        }
        git(dir, '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', `chore: tidy ${path.basename(file)}`);
        const commit = git(dir, 'rev-parse', 'HEAD').trim();
        made = {
          id, repo, kind: 'equiv', difficulty: count === 1 ? 'one' : 'two', base, commit, file,
          op: 'mirror', before: edits[0].before.trim(), after: edits[0].after.trim(), line: edits[0].i + 1,
          edits: edits.map((e) => ({ line: e.i + 1, before: e.before.trim(), after: e.after.trim() })),
          ...(cfg.generated ? { generated: cfg.generated.filter((g) => edits.some((e) => occurrences(generated[g], mirror(e.c).from).length)) } : {}),
        };
        manifest.push(made);
      }
      if (!made) throw new Error(`not enough suitable files in ${repo}`);
    }
    git(dir, 'checkout', '-q', '--detach', base);
    console.log(`${repo}: ${manifest.filter((m) => m.repo === repo && m.kind === 'equiv').length} equivalent packages`);
  }
  manifest.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`manifest.json: ${manifest.length} packages (${manifest.filter((m) => m.kind === 'equiv').length} equivalent)`);
}
