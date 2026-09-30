// Implementation plans (docs/pitroom/plans/*.md, written with pitroom-writing-plans):
// the parts one worker needs for one task, so the primary never pastes plan text
// through its own context. Headings inside fenced code blocks are content.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';

export interface PlanTask {
  step: number;
  title: string;
  /** The whole task section, heading included. */
  text: string;
  /** From a `**Worker:** <tier>` line in the task. */
  tier?: string;
}

export interface Plan {
  file: string;
  title: string;
  /** Everything between the title and the first section (goal, architecture, spec…). */
  header: string;
  /** Body of the "Global Constraints" section; "" when the plan has none. */
  constraints: string;
  tasks: PlanTask[];
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;

/** Headings and thematic breaks outside fenced code blocks, and which lines are fenced. */
function structure(lines: string[]): { headings: Heading[]; rules: number[]; fenced: boolean[] } {
  const headings: Heading[] = [];
  const rules: number[] = [];
  const fenced: boolean[] = [];
  let open: string | undefined; // the opening fence, e.g. "````"
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (f) {
      fenced[i] = true;
      const mark = f[1]!;
      if (!open) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !f[2]!.trim()) open = undefined;
      return;
    }
    fenced[i] = !!open;
    if (open) return;
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ line: i, level: h[1]!.length, text: h[2]! });
    else if (RULE.test(l)) rules.push(i);
  });
  return { headings, rules, fenced };
}

export function parsePlan(text: string, file = ''): Plan {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const { headings, rules, fenced } = structure(lines);
  /** The line where the block after `line` ends: the next heading or rule. */
  const after = (line: number) =>
    Math.min(headings.find((h) => h.line > line)?.line ?? lines.length, rules.find((r) => r > line) ?? lines.length);

  const titleHeading = headings.find((h) => h.level === 1);
  const start = titleHeading ? titleHeading.line + 1 : 0;
  const header = lines
    .slice(start, after(start - 1))
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim();

  const gc = headings.find((h) => /^global constraints\b/i.test(h.text));
  const constraints = gc ? lines.slice(gc.line + 1, after(gc.line)).join('\n').trim() : '';

  const tasks: PlanTask[] = [];
  for (const h of headings) {
    const m = /^Task\s+(\d+)\b\s*[:.)\-–—]?\s*(.*)$/i.exec(h.text);
    if (!m) continue;
    const end = headings.find((o) => o.line > h.line && o.level <= h.level)?.line ?? lines.length;
    const body = lines.slice(h.line, end).join('\n').replace(/(\n\s*(?:---|\*\*\*|___)\s*)+$/, '').trimEnd();
    // The task's own `**Worker:**` line; one inside a fence is an example (e.g. in a skill's text).
    const unfenced = lines.slice(h.line, end).filter((_, j) => !fenced[h.line + j]).join('\n');
    const tier = /^\s*[-*]?\s*\*\*Worker:\*\*\s*`?([\w-]+)`?/m.exec(unfenced)?.[1]?.toLowerCase();
    tasks.push({ step: Number(m[1]), title: m[2]!.trim(), text: body, ...(tier ? { tier } : {}) });
  }
  return { file, title: titleHeading?.text ?? '', header, constraints, tasks };
}

export function loadPlan(file: string): Plan {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new UserError(`plan not found: ${file}`);
  const plan = parsePlan(fs.readFileSync(abs, 'utf8'), fs.realpathSync(abs));
  if (!plan.tasks.length) throw new UserError(`${file} has no "Task N" headings (see pitroom-writing-plans)`);
  return plan;
}

export function planTask(plan: Plan, step: number): PlanTask {
  const t = plan.tasks.find((x) => x.step === step);
  if (!t) throw new UserError(`no Task ${step} in ${plan.file}; it has ${plan.tasks.map((x) => `Task ${x.step}`).join(', ')}`);
  return t;
}

/** What an implementer and its reviewers read: the plan's context, its constraints and one task. */
export function brief(plan: Plan, task: PlanTask): string {
  return `${[
    `# ${plan.title || planName(plan.file)}`,
    plan.header,
    '## Global Constraints',
    plan.constraints || '(none stated in the plan)',
    task.text,
  ]
    .filter(Boolean)
    .join('\n\n')}\n`;
}

/** The plan's file name without .md: its runs' default group. */
export const planName = (file: string): string => path.basename(file).replace(/\.md$/i, '');
