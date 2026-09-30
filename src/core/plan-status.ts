// `pitroom plan status|note`: where a plan's execution stands, rebuilt from the
// run records (they survive the primary agent's context compaction) and the
// primary's notes. Notes live in Pitroom's state directory, never in the project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from './answers.js';
import { type Plan, loadPlan, planName } from './plan.js';
import { type RunMeta, freshMeta, home, listRunIds } from './store.js';

export interface Note {
  at: string;
  text: string;
}

export interface TaskState {
  step: number;
  title: string;
  /** Implementer runs for this task: the first, its follow-ups and fresh attempts. */
  runs: number;
  last?: { id: string; state: string; status?: string };
  review?: { id: string; state: string; kind: string; verdict?: Verdict };
  applied: boolean;
  /** The latest note that starts with "Task N:". */
  note?: string;
}

export interface PlanStatus {
  plan: Plan;
  tasks: TaskState[];
  rulings: Note[];
  notesFile: string;
}

export function notesFile(plan: Plan): string {
  const id = crypto.createHash('sha1').update(plan.file).digest('hex').slice(0, 12);
  return path.join(home(), 'plans', id, 'notes.md');
}

export function readNotes(plan: Plan): Note[] {
  const f = notesFile(plan);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (.*)$/.exec(l);
      return m ? { at: m[1]!, text: m[2]! } : { at: '', text: l };
    });
}

export function addNote(planFile: string, text: string): string {
  const plan = loadPlan(planFile);
  const f = notesFile(plan);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# plan: ${plan.file}\n`);
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(f, `${at} ${text.replace(/\s+/g, ' ').trim()}\n`);
  return f;
}

export function planStatus(planFile: string): PlanStatus {
  const plan = loadPlan(planFile);
  const runs: RunMeta[] = [];
  for (const id of listRunIds()) {
    try {
      const m = freshMeta(id);
      if (m.plan?.file === plan.file) runs.push(m);
    } catch {
      // a record being written right now
    }
  }
  const notes = readNotes(plan);
  const tasks = plan.tasks.map((t): TaskState => {
    const impl = runs.filter((m) => m.plan!.step === t.step && !m.reviewOf);
    const rev = runs.filter((m) => m.plan!.step === t.step && m.reviewOf).at(-1);
    const last = impl.at(-1);
    return {
      step: t.step,
      title: t.title,
      runs: impl.length,
      last: last && { id: last.id, state: last.state, status: last.taskStatus },
      review: rev && { id: rev.id, state: rev.state, kind: rev.reviewKind ?? 'task', verdict: rev.verdict },
      applied: impl.some((m) => m.applied || (m.mode === 'write' && m.state === 'done' && !m.reverted && !!m.changes?.length)),
      note: [...notes].reverse().find((n) => n.text.startsWith(`Task ${t.step}:`))?.text,
    };
  });
  return { plan, tasks, rulings: notes.filter((n) => /\bRuling:/.test(n.text)), notesFile: notesFile(plan) };
}

const cell = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function formatPlanStatus(s: PlanStatus): string {
  const head = ['TASK', 'STATE', 'STATUS', 'REVIEW', 'ROUNDS', 'APPLIED', 'TITLE', 'NOTE'];
  const rows = s.tasks.map((t) => {
    const v = t.review?.verdict;
    const review = v ? `${v.spec}/${v.quality} (c${v.critical} i${v.important} m${v.minor})` : (t.review?.state ?? '-');
    return [
      String(t.step),
      t.last?.state ?? '-',
      t.last?.status ?? '-',
      review,
      t.runs ? String(t.runs - 1) : '-',
      t.runs ? (t.applied ? 'yes' : 'no') : '-',
      cell(t.title, 32),
      cell(t.note ?? '', 60),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  const rulings = s.rulings.length ? s.rulings.map((n) => `  ${n.at} ${n.text}`).join('\n') : '  none';
  return [
    `plan ${s.plan.file} · ${s.plan.title || planName(s.plan.file)} · ${s.tasks.length} tasks`,
    '',
    fmt(head),
    ...rows.map(fmt),
    '',
    `Rulings:\n${rulings}`,
    `notes: ${s.notesFile}`,
  ].join('\n');
}
