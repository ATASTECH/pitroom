// Starts any worker CLI the same way, so no adapter can skip a safeguard:
// stdin is closed (several CLIs block on, or read prompts from, an open pipe),
// $PWD matches the working directory (some CLIs trust $PWD over the real cwd),
// the git guard is first on PATH, recursion is flagged, and timeouts/signals
// are handled here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Invocation } from '../backends/types.js';
import { guardEnv } from '../vcs/guard.js';

export interface ProcessResult {
  code: number | null;
  timedOut: boolean;
  stopped: boolean;
  /** Set when the executable could not be started at all. */
  spawnError?: string;
}

export async function spawnWorker(
  inv: Invocation,
  opts: { cwd: string; stdoutFile: string; stderrFile: string; timeoutSec: number },
): Promise<ProcessResult> {
  const out = fs.openSync(opts.stdoutFile, 'w');
  const err = fs.openSync(opts.stderrFile, 'w');
  const res: ProcessResult = { code: null, timedOut: false, stopped: false };
  const child = spawn(inv.command, inv.args, {
    cwd: opts.cwd,
    stdio: ['ignore', out, err],
    // OpenCode v2 takes its workspace from $PWD, not the process cwd: without this a worker
    // started in an isolated copy would read and edit the directory pitroom was launched from.
    env: guardEnv({ ...process.env, ...inv.env, PWD: opts.cwd, PITROOM_ACTIVE: '1' }),
  });
  const stop = () => {
    res.stopped = true;
    child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let killer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    res.timedOut = true;
    child.kill('SIGTERM');
    killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  }, opts.timeoutSec * 1000);
  res.code = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      res.spawnError = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${inv.command} not found` : e.message;
      resolve(127);
    });
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  if (killer) clearTimeout(killer);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  fs.closeSync(out);
  fs.closeSync(err);
  return res;
}
