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
    const done = group.filter((m) => m.state === 'done').length;
    const worse = group.length - done;
    return {
      title: `Pitroom ${worse ? '⚠' : '✔'} group ${meta.group}`,
      body: `${group.length} runs ended: ${done} done${worse ? `, ${worse} not done` : ''}`,
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
  const seconds = (Date.parse(meta.endedAt ?? '') - Date.parse(meta.startedAt)) / 1000;
  if (Number.isFinite(seconds) && seconds < eff.notifyAfter.value) return false;
  if (!meta.group) return true;
  const group = safeGroup(meta.group);
  // a group is announced when its last run has ended (see claimGroup for two ending together)
  return group.length > 0 && group.every((m) => TERMINAL.includes(m.state));
}

/** The first of the runs that end together to ask says the group's notice; the others find it taken (one file, made exclusively). */
function claimGroup(group: string): boolean {
  try {
    const ids = groupIds(group).sort();
    const dir = path.join(home(), 'notified');
    fs.mkdirSync(dir, { recursive: true });
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
      child = spawn('notify-send', [notice.title, notice.body], { env, detached: true, stdio: 'ignore' });
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
