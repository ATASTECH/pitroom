// A desktop notification when a run that went to the background has ended, so a long job does not have to be watched.
// Off by default (config `notify`, env PITROOM_NOTIFY=1). Quick runs and audits are left out, and a group of runs (a
// crew) says so once, when its last run ends. The built-in notifier uses what the system has (macOS: osascript, Linux:
// notify-send; none for Windows yet); `notifyCommand` runs a command of your own instead (ntfy, a chat webhook, a sound).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effective } from './config.js';
import { groupIds } from './group.js';
import { type RunMeta, TERMINAL, home, readMeta } from './store.js';
import { elapsed, kind, what } from './ui.js';

const MARK: Record<string, string> = { done: '✔', failed: '✘', timeout: '⏱', stopped: '■' };

export interface Notice {
  title: string;
  body: string;
}

/** What to say about a run that ended, or about its whole group when it was the last of it. */
export function noticeFor(meta: RunMeta): Notice {
  const group = meta.group ? safeGroup(meta.group) : [];
  if (group.length > 1) {
    const count = (state: string) => group.filter((m) => m.state === state).length;
    const worse = group.length - count('done');
    const parts = [`${count('done')} done`, ...['failed', 'timeout', 'stopped'].filter(count).map((s) => `${count(s)} ${s}`)];
    const changed = group.reduce((n, m) => n + (m.changes?.length ?? 0), 0);
    return {
      title: `Pitroom ${worse ? '⚠' : '✔'} group ${meta.group}`,
      body: `${group.length} runs ended: ${parts.join(', ')}${changed ? ` · ${changed} file${changed === 1 ? '' : 's'} changed` : ''}`,
    };
  }
  const changed = meta.changes?.length ? ` · ${meta.changes.length} file${meta.changes.length === 1 ? '' : 's'} changed` : '';
  return { title: `Pitroom ${MARK[meta.state] ?? '•'} ${kind(meta)} ${meta.state}`, body: `${what(meta)} · ${elapsed(meta)}${changed}` };
}

function safeGroup(name: string): RunMeta[] {
  try {
    return groupIds(name).map((id) => readMeta(id));
  } catch {
    return [];
  }
}

/** Whether this ended run should be announced: background, not an audit, long enough, and last of its group. */
export function shouldNotify(meta: RunMeta): boolean {
  const eff = effective();
  if (!eff.notify.value || !meta.background || meta.auditOf || !TERMINAL.includes(meta.state)) return false;
  // A group is announced when its last run has ended (see claimGroup for two ending together) and judged as a whole:
  // from the earliest start to the last end, and by its worst run.
  const runs = meta.group ? safeGroup(meta.group) : [meta];
  if (!runs.length || !runs.every((m) => TERMINAL.includes(m.state))) return false;
  // Not worth announcing: everything went well and quickly. A failure is always worth it (stopping a run was the user's own doing).
  if (runs.every((m) => m.state === 'done' || m.state === 'stopped')) {
    const start = Math.min(...runs.map((m) => Date.parse(m.startedAt)));
    const end = Math.max(...runs.map((m) => Date.parse(m.endedAt ?? '')));
    if (Number.isFinite(end - start) && (end - start) / 1000 < eff.notifyAfter.value) return false;
    if (runs.every((m) => m.state === 'stopped')) return false;
  }
  return true;
}

/** The first of the runs that end together to ask says the group's notice; the others find it taken (one file, made exclusively). */
function claimGroup(group: string): boolean {
  try {
    const ids = groupIds(group).sort();
    if (ids.length < 2) return true; // a group of one has no one to race with
    const dir = path.join(home(), 'notified');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      // claims are tiny; the old ones go (a run that long ago cannot race with this one)
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 30 * 86_400_000) fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.writeFileSync(path.join(dir, crypto.createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 16)), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/** Sends it; never throws and never waits (a notifier that is missing or slow must not hold up a run). */
export function send(notice: Notice, meta: Pick<RunMeta, 'id' | 'state'>): void {
  const command = effective().notifyCommand.value;
  const env = { ...process.env, PITROOM_NOTIFY_TITLE: notice.title, PITROOM_NOTIFY_BODY: notice.body, PITROOM_NOTIFY_RUN: meta.id, PITROOM_NOTIFY_STATE: meta.state };
  try {
    let child;
    if (command) {
      // the text goes in through the environment, never into the command line
      child = spawn(command, { shell: true, env, detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', notice.title, notice.body], { env, detached: true, stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      // `--`: a task text such as `--help` or `-u critical` is a word to show, not an option. notify-send reads Pango markup, so
      // the text is escaped.
      const plain = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      child = spawn('notify-send', ['--', plain(notice.title), plain(notice.body)], { env, detached: true, stdio: 'ignore' });
    } else {
      return; // no built-in notifier here: set notifyCommand
    }
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // a notification is a convenience
  }
}

/** Called when a run has ended. */
export function notifyEnded(meta: RunMeta): void {
  try {
    if (shouldNotify(meta) && (!meta.group || claimGroup(meta.group))) send(noticeFor(meta), meta);
  } catch {
    // never fail a run over a notification
  }
}
