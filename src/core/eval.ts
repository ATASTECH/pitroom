// `pitroom eval`: your own questions about your own project, with known answers, put to one or more workers and
// scored. It is benchmarks/multi-repo made general: a definition scores 1 for the exact path:line (0.5 for the right
// file), a count only for the exact number, and a list the F1 of the paths it names against the real ones. A truth
// can be written down, or be a `git grep` that is run when the eval starts, so it stays right as the code changes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { UserError } from './errors.js';

export type EvalKind = 'definition' | 'count' | 'set';

/** A truth that is looked up: the files `git grep -l` finds for a pattern (for a definition, its first `-n` hit). */
export interface GrepTruth {
  grep: string;
  /** Limit the search to this directory, relative to the repository root. */
  dir?: string;
  /** Whole words only (git grep -w). */
  word?: boolean;
  /** An extended regular expression instead of a fixed string. */
  regex?: boolean;
  /** Leave out paths that match this regular expression (e.g. "__tests__"). */
  exclude?: string;
}

export interface EvalQuestion {
  id: string;
  task: string;
  kind: EvalKind;
  /** definition: "path:line"; count: a number; set: paths from the repository root; or a GrepTruth. */
  truth: string | number | string[] | GrepTruth;
}

export type Truth = { path: string; line: number } | { count: number } | { files: string[] };

const KINDS: EvalKind[] = ['definition', 'count', 'set'];

/** Reads and checks a questions file: {"questions": [{id, task, kind, truth}]}. */
export function loadEval(file: string): EvalQuestion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || !list.length) throw new UserError(`${file}: expected {"questions": [{"id", "task", "kind", "truth"}, …]}`);
  const ids = new Set<string>();
  return list.map((q: any, i) => {
    const where = `${file}: question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new UserError(`${where} is not an object`);
    const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${i + 1}`;
    if (ids.has(id)) throw new UserError(`${where}: the id "${id}" is used twice`);
    ids.add(id);
    if (typeof q.task !== 'string' || !q.task.trim()) throw new UserError(`${where} (${id}) has no task`);
    if (!KINDS.includes(q.kind)) throw new UserError(`${where} (${id}): kind must be one of ${KINDS.join(', ')}`);
    const t = q.truth;
    const grep = t && typeof t === 'object' && !Array.isArray(t) && typeof t.grep === 'string' && t.grep;
    const literal =
      (q.kind === 'definition' && typeof t === 'string' && /:\d+$/.test(t)) ||
      (q.kind === 'count' && typeof t === 'number' && Number.isInteger(t) && t >= 0) ||
      (q.kind === 'set' && Array.isArray(t) && t.every((s: unknown) => typeof s === 'string'));
    if (!grep && !literal) {
      const want = { definition: '"path:line"', count: 'a whole number', set: 'a list of paths' }[q.kind as EvalKind];
      throw new UserError(`${where} (${id}): truth must be ${want} or {"grep": "pattern", …}`);
    }
    return { id, task: q.task.trim(), kind: q.kind, truth: t };
  });
}

const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

function gitGrep(root: string, flags: string[], t: GrepTruth): string[] {
  const r = spawnSync('git', ['-C', root, 'grep', ...flags, t.regex ? '-E' : '-F', ...(t.word ? ['-w'] : []), '-e', t.grep, '--', t.dir ?? '.'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new UserError(`git grep "${t.grep}" failed: ${(r.stderr || r.error?.message || '').trim()}`);
  const exclude = t.exclude ? new RegExp(t.exclude) : undefined;
  return r.stdout.split('\n').filter(Boolean).filter((l) => !exclude?.test(l.split(':')[0]!));
}

/** The answer a question has: written down, or looked up with git grep in `root` (the repository). */
export function truthOf(q: EvalQuestion, root: string | undefined): Truth {
  const t = q.truth;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if (!root) throw new UserError(`question ${q.id}: a "grep" truth needs a git repository`);
    if (q.kind === 'definition') {
      const hit = gitGrep(root, ['-n'], t).map((l) => /^(.*?):(\d+):/.exec(l)).find(Boolean);
      if (!hit) throw new UserError(`question ${q.id}: git grep found no definition for "${t.grep}"`);
      return { path: clean(hit[1]!), line: Number(hit[2]) };
    }
    const files = [...new Set(gitGrep(root, ['-l'], t).map(clean))];
    return q.kind === 'count' ? { count: files.length } : { files };
  }
  if (q.kind === 'definition') {
    const m = /^(.*):(\d+)$/.exec(t as string)!;
    return { path: clean(m[1]!), line: Number(m[2]) };
  }
  if (q.kind === 'count') return { count: t as number };
  return { files: [...new Set((t as string[]).map(clean))] };
}

/** The SUMMARY part of an answer (the label is optional: some models leave it out) and its DETAILS. */
export function answerParts(answer: string): { summary: string; details: string } {
  const text = answer.replace(/`/g, '');
  const s = /SUMMARY:\s*([\s\S]*?)(?=^\s*(?:DETAILS|FILES CHANGED|VERIFICATION|OPEN ISSUES):|$(?![\s\S]))/m.exec(text);
  const d = /^\s*DETAILS:\s*([\s\S]*?)(?=^\s*(?:FILES CHANGED|VERIFICATION|OPEN ISSUES):|$(?![\s\S]))/m.exec(text);
  const summary = s ? s[1]! : text.split(/^\s*(?:DETAILS|FILES CHANGED|VERIFICATION|OPEN ISSUES):/m)[0]!;
  return { summary: summary.trim(), details: (d?.[1] ?? '').trim() };
}

/** Paths an answer names (with a file extension), without a line number. */
export function pathsIn(text: string): string[] {
  const found = text.replace(/\\/g, '/').match(/[A-Za-z0-9_.@\-/]+\.[A-Za-z0-9]{1,8}(?::\d+)?/g) ?? [];
  return [...new Set(found.map((p) => clean(p.replace(/:\d+$/, ''))))];
}

/** Scores one answer: 0 to 1, and what was read from it. */
export function scoreAnswer(q: EvalQuestion, truth: Truth, answer: string, root?: string): { score: number; got: string } {
  const prefix = root ? `${clean(root).replace(/\/$/, '')}/` : '';
  const text = prefix ? answer.replace(/\\/g, '/').split(prefix).join('') : answer;
  const { summary, details } = answerParts(text);
  if (!summary && !details) return { score: 0, got: '(no answer)' };
  if ('line' in truth) {
    const flat = summary.replace(/\s+/g, ' ');
    if (new RegExp(`(^|[^\\w./-])\\.?/?${escape(truth.path)}:${truth.line}(?!\\d)`).test(flat)) return { score: 1, got: `${truth.path}:${truth.line}` };
    const named = pathsIn(flat).includes(truth.path);
    return { score: named ? 0.5 : 0, got: flat.slice(0, 120) };
  }
  if ('count' in truth) {
    const n = /\d[\d,]*/.exec(summary);
    const got = n ? Number(n[0].replace(/,/g, '')) : undefined;
    return { score: got === truth.count ? 1 : 0, got: got === undefined ? '(no number)' : String(got) };
  }
  let got = pathsIn(summary);
  if (!got.length) got = pathsIn(details);
  const hit = got.filter((p) => truth.files.includes(p)).length;
  const precision = got.length ? hit / got.length : 0;
  const recall = truth.files.length ? hit / truth.files.length : got.length ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { score: !truth.files.length && !got.length ? 1 : f1, got: `${hit}/${truth.files.length} found, ${got.length - hit} extra` };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface EvalRow {
  question: string;
  kind: EvalKind;
  worker: string;
  run: string;
  state: string;
  score: number;
  got: string;
  seconds?: number;
  tokens?: number;
}

export interface EvalSummary {
  worker: string;
  questions: number;
  failed: number;
  score: number;
  byKind: Partial<Record<EvalKind, number>>;
  medianSeconds?: number;
  medianTokens?: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: (number | undefined)[]) => {
  const s = a.filter((x): x is number => x !== undefined).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

/** One line per worker, best first: its mean score in all and per kind, failures, and median time and tokens. */
export function summarize(rows: EvalRow[]): EvalSummary[] {
  const by = new Map<string, EvalRow[]>();
  for (const r of rows) by.set(r.worker, [...(by.get(r.worker) ?? []), r]);
  return [...by.entries()]
    .map(([worker, rs]) => ({
      worker,
      questions: rs.length,
      failed: rs.filter((r) => r.state !== 'done').length,
      score: mean(rs.map((r) => r.score)),
      byKind: Object.fromEntries(KINDS.filter((k) => rs.some((r) => r.kind === k)).map((k) => [k, mean(rs.filter((r) => r.kind === k).map((r) => r.score))])),
      medianSeconds: median(rs.map((r) => r.seconds)),
      medianTokens: median(rs.map((r) => r.tokens)),
    }))
    .sort((a, b) => b.score - a.score || (a.medianSeconds ?? 1e9) - (b.medianSeconds ?? 1e9));
}

const pct = (x: number | undefined) => (x === undefined ? '-' : `${Math.round(x * 100)}%`);

/** The eval as text: one block per question, then the table. */
export function formatEval(rows: EvalRow[], group: string): string {
  const out = [`pitroom eval "${group}": ${new Set(rows.map((r) => r.question)).size} questions × ${new Set(rows.map((r) => r.worker)).size} workers`, ''];
  for (const r of rows) out.push(`  ${pct(r.score).padStart(4)}  ${r.question.padEnd(16)} ${r.worker.padEnd(28)} ${r.state === 'done' ? r.got : `(${r.state})`}`);
  out.push('', '| Worker | Score | Definition | Count | List | Failed | Median time | Median tokens |', '|---|---|---|---|---|---|---|---|');
  for (const s of summarize(rows)) {
    out.push(`| ${s.worker} | **${pct(s.score)}** | ${pct(s.byKind.definition)} | ${pct(s.byKind.count)} | ${pct(s.byKind.set)} | ${s.failed}/${s.questions} | ${s.medianSeconds ?? '-'} s | ${s.medianTokens === undefined ? '-' : `${Math.round(s.medianTokens / 1000)}k`} |`);
  }
  out.push('', `Every run is in the history: pitroom wait -g ${group}, or the dashboard's group picker.`);
  return out.join('\n');
}
