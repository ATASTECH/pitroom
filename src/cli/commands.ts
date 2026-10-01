// One function per `pitroom` command. Each returns the process exit code.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configPath, effective, loadConfig } from '../core/config.js';
import { DeletionRefused, UserError } from '../core/errors.js';
import { groupIds, headline, table, waitMany, watch } from '../core/group.js';
import { install, uninstall } from '../core/install.js';
import { badgeUrl, card, compact, primaryPrice, readLedger, totals, usd } from '../core/receipt.js';
import { addNote, formatPlanStatus, planStatus } from '../core/plan-status.js';
import { formatReport, progress } from '../core/report.js';
import { TEMPLATE, pickReviewer, rangeReview, runReview, writePackage } from '../core/review.js';
import { fill, loadTemplate } from '../core/templates.js';
import { formatModels, modelTable } from '../core/models.js';
import { dashCommand } from '../core/dash.js';
import { hookCards, statusLine } from '../core/ui.js';
import { applyRun, discardRun, execute, prepareRun, revertRun, startInBackground } from '../core/run.js';
import {
  type RunMeta, TERMINAL, freshMeta, isActive, isAlive, listRunIds, readMeta, resolveRun, runDir, runFile, writeMeta,
} from '../core/store.js';
import { type Parsed, exitCodeFor, flag, has, parseDuration, planStep, readTask, runOptions } from './args.js';

/** Runs a prepared run in the foreground, or starts it in the background with --bg. */
async function launch(p: Parsed, meta: RunMeta): Promise<number> {
  if (has(p, 'bg')) {
    startInBackground(meta);
    console.log(
      has(p, 'json')
        ? JSON.stringify(meta, null, 2)
        : `pitroom started ${meta.mode} run ${meta.id} in background${meta.group ? ` (group ${meta.group})` : ''}\n` +
            `   wait:   pitroom wait ${meta.id}\n   status: pitroom status ${meta.id}`,
    );
    return 0;
  }
  const done = await execute(meta);
  console.log(has(p, 'json') ? JSON.stringify(done, null, 2) : formatReport(done));
  return exitCodeFor(done);
}

export async function cmdRun(p: Parsed): Promise<number> {
  const opts = { ...runOptions(p, readTask(p)), plan: planStep(p) };
  if (!opts.task.trim() && !opts.plan) throw new UserError('no task given (pitroom "find where X is handled")');
  return launch(p, prepareRun(opts));
}

/** A read-only review of a run's change, of a fix round, or of a commit range. */
export async function cmdReview(p: Parsed): Promise<number> {
  const range = flag(p, 'range');
  if (range && p.positional.length) throw new UserError('review takes a run or --range A..B, not both');
  if (flag(p, 'plan') && !range) throw new UserError("--plan goes with --range (a run's review already knows its plan)");
  if (has(p, 'write') || has(p, 'isolate')) throw new UserError('reviews are read-only; drop -w/-i');
  if (has(p, 'continue')) throw new UserError('to review a follow-up, pass its run id: pitroom review <run>');
  const job = range ? rangeReview(range, flag(p, 'dir') ?? process.cwd(), flag(p, 'plan')) : runReview(resolveRun(p.positional[0]));
  const packageFile = writePackage(job);
  let meta: RunMeta;
  try {
    meta = prepareRun({
      ...runOptions(p, fill(loadTemplate(TEMPLATE[job.kind]), { PACKAGE_FILE: packageFile })),
      mode: 'read',
      dir: job.dir,
      worker: flag(p, 'worker') ?? (flag(p, 'tier') ? undefined : pickReviewer(job)),
      group: flag(p, 'group') ?? job.group,
      review: { of: job.of, kind: job.kind, packageFile, plan: job.plan },
    });
    // The reviewer defaults to another backend than the implementer; when none
    // differs it falls back to the default worker, possibly the same model
    // grading itself. Say so on the report, but only for automatic picks: an
    // explicitly named reviewer (-W/--tier) and range reviews need no warning.
    // A configured `review` tier is the user's own choice, so it needs no warning.
    const automatic = !range && !flag(p, 'worker') && !flag(p, 'tier') && !effective().tiers.value.review;
    if (automatic && job.implementer && meta.worker.backend === job.implementer.backend) {
      meta.warnings.push(
        `reviewer runs on the same backend as the implementer (${job.implementer.backend}); configure tiers "standard" or "capable" for a second model`,
      );
      writeMeta(meta);
    }
  } catch (e) {
    fs.rmSync(packageFile, { force: true });
    throw e;
  }
  fs.writeFileSync(runFile(meta.id, 'package.md'), job.package);
  return launch(p, meta);
}

/** `pitroom plan status PLAN` / `pitroom plan note PLAN "Task N: …"`. */
export function cmdPlan(p: Parsed): number {
  const [sub, file, ...rest] = p.positional;
  if (sub === 'status' && file) {
    const s = planStatus(file);
    console.log(
      has(p, 'json')
        ? JSON.stringify({ plan: s.plan.file, title: s.plan.title, tasks: s.tasks, rulings: s.rulings, notesFile: s.notesFile }, null, 2)
        : formatPlanStatus(s),
    );
    return 0;
  }
  if (sub === 'note' && file && rest.length) {
    console.log(`noted in ${addNote(file, rest.join(' '))}`);
    return 0;
  }
  throw new UserError('usage: pitroom plan status PLAN.md [--json] | pitroom plan note PLAN.md "Task N: …"');
}

/** Several tasks as one group of background workers. */
export function cmdCrew(p: Parsed): number {
  const file = flag(p, 'task-file');
  const tasks = (file ? fs.readFileSync(file, 'utf8').split(/^\s*---\s*$/m) : p.positional).map((t) => t.trim()).filter(Boolean);
  if (!tasks.length) throw new UserError('crew needs tasks: pitroom crew -g NAME "task 1" "task 2" (or --task-file with --- separators)');
  if (has(p, 'write') && tasks.length > 1) {
    throw new UserError('parallel --write runs would edit the same tree; use --isolate (each worker gets its own isolated copy)');
  }
  if (has(p, 'continue')) throw new UserError('--continue applies to a single run; use pitroom run --continue');
  if (has(p, 'plan') || has(p, 'step')) {
    throw new UserError("start plan tasks with pitroom run -i --plan PLAN --step N --bg (they share the plan's group)");
  }
  const group = flag(p, 'group') ?? `crew-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
  const metas = tasks.map((task) => startInBackground(prepareRun({ ...runOptions(p, task), group })));
  if (has(p, 'json')) {
    console.log(JSON.stringify({ group, runs: metas.map((m) => ({ id: m.id, mode: m.mode, task: m.task })) }, null, 2));
    return 0;
  }
  console.log(`pitroom crew "${group}": ${metas.length} ${metas[0]!.mode} workers started (max ${effective().maxParallel.value} at once)`);
  for (const m of metas) console.log(`   ${m.id}  ${m.task.replace(/\s+/g, ' ').slice(0, 70)}`);
  console.log(`   live:    pitroom watch -g ${group}        (agents: add --json)\n   results: pitroom wait -g ${group}`);
  return 0;
}

/** Runs named on the command line, or a group's, or a default. */
function selectIds(p: Parsed, fallback: () => string[]): string[] {
  const group = flag(p, 'group');
  if (group) {
    const ids = groupIds(group);
    if (!ids.length) throw new UserError(`no runs in group "${group}"`);
    return ids;
  }
  return p.positional.length ? p.positional.map((r) => resolveRun(r)) : fallback();
}

export function cmdStatus(p: Parsed): number {
  if (flag(p, 'group') || p.positional.length > 1) {
    const metas = selectIds(p, () => []).map((id) => freshMeta(id));
    console.log(table(metas));
    return metas.some((m) => isActive(m.state)) ? 75 : 0;
  }
  const meta = freshMeta(resolveRun(p.positional[0]));
  console.log(isActive(meta.state) ? progress(meta) : formatReport(meta));
  return exitCodeFor(meta);
}

export async function cmdWait(p: Parsed): Promise<number> {
  const ids = selectIds(p, () => [resolveRun(undefined)]);
  const { metas, timedOut } = await waitMany(ids, {
    any: has(p, 'any'),
    timeoutMs: parseDuration(flag(p, 'timeout') ?? '540') * 1000,
  });
  const finished = metas.filter((m) => TERMINAL.includes(m.state));
  const pending = metas.filter((m) => isActive(m.state));
  const parts = finished.map((m) =>
    has(p, 'brief') ? `pitroom ${m.state} · ${m.id} · ${headline(m) || m.error || m.task}` : formatReport(m),
  );
  for (const m of pending) parts.push(progress(m));
  if (pending.length) {
    const again = flag(p, 'group') ? `-g ${flag(p, 'group')}` : pending.map((m) => m.id).join(' ');
    parts.push(`── ${pending.length} still active: pitroom wait ${again}`);
  }
  console.log(parts.join(metas.length > 1 && !has(p, 'brief') ? '\n\n════════\n\n' : '\n'));
  if (pending.length && (timedOut || !has(p, 'any'))) return 75;
  return finished.map(exitCodeFor).find((c) => c !== 0) ?? 0;
}

export async function cmdWatch(p: Parsed): Promise<number> {
  const group = flag(p, 'group');
  const explicit = p.positional.map((r) => resolveRun(r));
  const initial = group ? groupIds(group) : explicit.length ? explicit : listRunIds().filter((id) => isActive(freshMeta(id).state));
  if (!initial.length) {
    console.log(group ? `no runs in group "${group}"` : 'nothing is running');
    return 0;
  }
  const brief = has(p, 'brief');
  const { metas, timedOut } = await watch(group ? () => groupIds(group) : () => initial, {
    json: !brief && (has(p, 'json') || !process.stdout.isTTY),
    brief,
    intervalMs: parseDuration(flag(p, 'interval') ?? '2') * 1000,
    timeoutMs: flag(p, 'timeout') ? parseDuration(flag(p, 'timeout')!) * 1000 : 0,
    write: (s) => process.stdout.write(s),
  });
  if (timedOut) return 75;
  return metas.some((m) => m.state !== 'done') ? 1 : 0;
}

/** A live page of the runs, for agent apps that show neither hooks nor a status line. */
export async function cmdDash(p: Parsed): Promise<number> {
  const port = flag(p, 'port');
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) <= 65535)) throw new UserError('--port takes a number from 0 to 65535 (0 picks a free one)');
  return dashCommand({
    port: port === undefined ? undefined : Number(port),
    idleMs: flag(p, 'idle') ? parseDuration(flag(p, 'idle')!) * 1000 : undefined,
    detach: has(p, 'detach'),
    stop: has(p, 'stop'),
    open: has(p, 'open'),
    serve: has(p, 'serve'),
    log: (s) => console.log(s),
  });
}

export function cmdShow(p: Parsed): number {
  const meta = freshMeta(resolveRun(p.positional[0]));
  const dump = (name: string) => {
    const f = runFile(meta.id, name);
    process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `(no ${name})\n`);
  };
  if (has(p, 'patch')) dump('changes.patch');
  else if (has(p, 'events')) dump('events.jsonl');
  else if (has(p, 'json')) console.log(JSON.stringify(meta, null, 2));
  else if (isActive(meta.state)) console.log(progress(meta));
  else console.log(formatReport(meta, undefined, has(p, 'full') ? Infinity : 400));
  return 0;
}

export function cmdLs(p: Parsed): number {
  const group = flag(p, 'group');
  let ids = group ? groupIds(group) : listRunIds();
  if (has(p, 'running')) ids = ids.filter((id) => isActive(freshMeta(id).state));
  const metas = ids.slice(-20).map((id) => freshMeta(id));
  if (!metas.length) {
    console.log(has(p, 'running') ? 'nothing is running' : 'no runs yet');
    return 0;
  }
  console.log(table(metas));
  return 0;
}

export function cmdApply(p: Parsed): number {
  const group = flag(p, 'group');
  if (!group) {
    console.log(applyRun(freshMeta(resolveRun(p.positional[0])), has(p, 'allow-delete')));
    return 0;
  }
  // Apply a group's isolated patches in start order; stop at the first conflict.
  const pending = groupIds(group)
    .map((id) => freshMeta(id))
    .filter((m) => m.mode === 'isolate' && m.state === 'done' && m.changes?.length && !m.applied && !m.discarded);
  if (!pending.length) throw new UserError(`group "${group}" has no finished isolate patches to apply`);
  for (const [i, m] of pending.entries()) {
    try {
      console.log(applyRun(m, has(p, 'allow-delete')));
    } catch (e) {
      const rest = pending.slice(i + 1).map((r) => r.id);
      console.log(`✘ ${m.id}: ${(e as Error).message}`);
      if (rest.length) console.log(`   not applied yet: ${rest.join(' ')}`);
      if (!(e instanceof DeletionRefused)) {
        console.log(`   resolve it (e.g. pitroom run --continue ${m.id} "rebase your change on the current tree"), then apply the rest`);
      }
      return 1;
    }
  }
  return 0;
}

export function cmdStop(p: Parsed): number {
  const ids = selectIds(p, () => [resolveRun(undefined)]);
  let stopped = 0;
  for (const id of ids) {
    const meta = freshMeta(id);
    if (!isActive(meta.state) || !isAlive(meta.pid)) continue;
    process.kill(meta.pid!, 'SIGTERM');
    console.log(`stopping ${meta.id} (${meta.state})`);
    stopped++;
  }
  if (!stopped) throw new UserError(ids.length === 1 ? `run ${ids[0]} is not active` : 'none of these runs is active');
  return 0;
}

function sinceMs(s: string | undefined): number | undefined {
  if (!s || s === 'all') return undefined;
  const m = /^(\d+)d$/.exec(s);
  if (!m) throw new UserError('--since takes 7d, 30d, … or all');
  return Date.now() - Number(m[1]) * 86_400_000;
}

const readStdin = () => (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));

/**
 * A host status line: `--then CMD` runs the user's own status line command first (with the
 * same stdin) and keeps its output, then Pitroom's line follows when it has something to say.
 */
export function cmdStatusline(p: Parsed): number {
  const input = readStdin();
  const lines: string[] = [];
  const then = flag(p, 'then');
  if (then) {
    const r = spawnSync('/bin/sh', ['-c', then], { input, encoding: 'utf8', timeout: 5000 });
    if (r.stdout?.trimEnd()) lines.push(r.stdout.trimEnd());
  }
  try {
    const own = statusLine();
    if (own) lines.push(own);
  } catch {
    // a status bar never shows an error
  }
  if (lines.length) console.log(lines.join('\n'));
  return 0;
}

/** A PostToolUse hook: a card shown to the user after each Bash `pitroom` command. */
export function cmdHookCard(): number {
  try {
    const cards = hookCards(readStdin());
    if (cards) {
      // systemMessage is for the user's screen where the host shows it; additionalContext reaches the
      // agent too, which tells the user when the host does not show hook messages.
      console.log(
        JSON.stringify({
          systemMessage: cards,
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Pitroom, for the user:\n${cards}` },
        }),
      );
    }
  } catch {
    // never block or clutter the host's tool call
  }
  return 0;
}

/** What each worker offers, next to your costs and your own usage. */
export function cmdModels(p: Parsed): number {
  const backend = p.positional[0];
  const table = modelTable({ backend, all: has(p, 'all') });
  console.log(has(p, 'json') ? JSON.stringify(table, null, 2) : formatModels(table));
  return 0;
}

export function cmdSavings(p: Parsed): number {
  const since = flag(p, 'since') ?? 'all';
  const t = totals(readLedger(sinceMs(since)));
  if (has(p, 'models')) {
    const by = new Map<string, { runs: number; tokens: number; returned: number; cost: number; saved: number }>();
    for (const e of readLedger(sinceMs(since))) {
      const key = `${e.backend ?? '?'}  ${e.model ?? '(default model)'}`;
      const a = by.get(key) ?? { runs: 0, tokens: 0, returned: 0, cost: 0, saved: 0 };
      by.set(key, { runs: a.runs + 1, tokens: a.tokens + e.tokens, returned: a.returned + e.returned, cost: a.cost + e.workerCost, saved: a.saved + e.saved });
    }
    const width = Math.max(12, ...[...by.keys()].map((k) => k.length));
    console.log(`${'worker  model'.padEnd(width)}  ${'runs'.padStart(5)} ${'processed'.padStart(10)} ${'returned'.padStart(9)} ${'cost'.padStart(8)} ${'saved'.padStart(8)}`);
    for (const [key, a] of [...by].sort((x, y) => y[1].runs - x[1].runs)) {
      console.log(`${key.padEnd(width)}  ${String(a.runs).padStart(5)} ${compact(a.tokens).padStart(10)} ${compact(a.returned).padStart(9)} ${usd(a.cost).padStart(8)} ${usd(a.saved).padStart(8)}`);
    }
    return 0;
  }
  const period = since === 'all' ? 'all time' : `last ${since.replace('d', ' days')}`;
  if (has(p, 'json')) {
    console.log(JSON.stringify({ period, ...t, price: primaryPrice() }, null, 2));
    return 0;
  }
  console.log(`pitroom savings · ${period}
  delegated tasks     ${t.runs}
  tokens offloaded    ${compact(t.tokens)}
  returned to primary ~${compact(t.returned)}${t.ratio ? `  (${Math.round(t.ratio)}× compression)` : ''}
  worker cost         ${usd(t.workerCost)}
  est. saved          ${usd(t.saved)}  (vs ${primaryPrice().name} list prices)`);
  const out = flag(p, 'card');
  if (out) {
    fs.writeFileSync(out, card(t, period));
    console.log(`card written to ${path.resolve(out)}`);
  }
  if (has(p, 'badge')) console.log(`![pitroom](${badgeUrl(t)})`);
  return 0;
}

export function cmdInstall(p: Parsed): number {
  for (const line of install({ copy: has(p, 'copy'), force: has(p, 'force') })) console.log(line);
  return 0;
}

export function cmdUninstall(): number {
  for (const line of uninstall()) console.log(line);
  return 0;
}

export function cmdConfig(p: Parsed): number {
  const { warnings } = loadConfig();
  const eff = effective();
  if (has(p, 'json')) {
    console.log(JSON.stringify({ path: configPath(), settings: eff, warnings }, null, 2));
    return 0;
  }
  console.log(`config file: ${configPath()}${fs.existsSync(configPath()) ? '' : ' (not present)'}`);
  for (const [key, s] of Object.entries(eff)) {
    const v = Array.isArray(s.value)
      ? s.value.join(', ') || '—'
      : s.value && typeof s.value === 'object'
        ? Object.entries(s.value).map(([k, m]) => `${k}=${m}`).join(', ') || '—'
      : s.value === undefined
        ? key === 'model'
          ? "the worker's default"
          : '—'
        : String(s.value);
    console.log(`  ${key.padEnd(15)} ${v}  (${s.source})`);
  }
  for (const w of warnings) console.log(`! ${w}`);
  return 0;
}

export function cmdClean(p: Parsed): number {
  const days = Number(flag(p, 'days') ?? 14);
  const cutoff = Date.now() - days * 86_400_000;
  const old = listRunIds().filter((id) => {
    const m = freshMeta(id);
    const pendingPatch = m.mode === 'isolate' && !m.applied && !m.discarded && m.changes?.length;
    return TERMINAL.includes(m.state) && Date.parse(m.startedAt) < cutoff && !pendingPatch;
  });
  if (!has(p, 'yes')) {
    console.log(`${old.length} run(s) older than ${days} days would be removed (unapplied isolate patches are kept). Re-run with --yes.`);
    return 0;
  }
  for (const id of old) {
    const m: RunMeta = readMeta(id);
    if (m.mode === 'isolate' && !m.discarded && !m.applied) discardRun(m);
    fs.rmSync(runDir(id), { recursive: true, force: true });
  }
  console.log(`removed ${old.length} run(s); the savings ledger is kept`);
  return 0;
}

export const cmdRevert = (p: Parsed) => (console.log(revertRun(freshMeta(resolveRun(p.positional[0])))), 0);
export const cmdDiscard = (p: Parsed) => (console.log(discardRun(freshMeta(resolveRun(p.positional[0])))), 0);
