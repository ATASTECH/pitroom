// Prompt templates for plan work live inside the skills, so agents and the CLI
// read the same text: skills/<skill>/<name>.md with `{{NAME}}` placeholders and
// an optional leading <!-- comment --> for humans that is not sent to workers.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { packageRoot } from './install.js';

export type TemplateName = 'implementer' | 'task-reviewer' | 're-review' | 'code-reviewer';

const FILES: Record<TemplateName, string> = {
  implementer: 'pitroom-driven-development/implementer-prompt.md',
  'task-reviewer': 'pitroom-driven-development/task-reviewer-prompt.md',
  're-review': 'pitroom-driven-development/re-review-prompt.md',
  'code-reviewer': 'pitroom-review/code-reviewer.md',
};

export function loadTemplate(name: TemplateName, root = packageRoot()): string {
  const file = path.join(root, 'skills', FILES[name]);
  if (!fs.existsSync(file)) throw new UserError(`template missing: ${file} (broken install? run pitroom doctor)`, 3);
  return fs.readFileSync(file, 'utf8').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
}

/** Fills every `{{KEY}}`; values are inserted literally and never re-scanned. */
export function fill(template: string, values: Record<string, string>): string {
  const missing = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!).filter((k) => !(k in values));
  if (missing.length) throw new UserError(`no value for template placeholder(s): ${[...new Set(missing)].join(', ')}`, 3);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key]!);
}
