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
  /** Stopped because `overCap` said the run reached its cost cap (--max-cost). */
  capped?: boolean;
}

/** How often a run's cost is checked against its cap while the worker runs. */
const CAP_CHECK_MS = 1000;

export async function spawnWorker(
  inv: Invocation,
  opts: { cwd: string; stdoutFile: string; stderrFile: string; timeoutSec: number; overCap?: () => boolean },
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
  const end = () => {
    child.kill('SIGTERM');
    killer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
  };
  const timer = setTimeout(() => {
    res.timedOut = true;
    end();
  }, opts.timeoutSec * 1000);
  const capWatch = opts.overCap
    ? setInterval(() => {
        if (res.capped || !opts.overCap!()) return;
        res.capped = true;
        end();
      }, CAP_CHECK_MS)
    : undefined;
  res.code = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      // ENOENT is also what spawn says when the working directory is missing: say which.
      res.spawnError = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? fs.existsSync(opts.cwd) ? `${inv.command} not found` : `the working directory ${opts.cwd} does not exist`
        : e.message;
      resolve(127);
    });
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  if (capWatch) clearInterval(capWatch);
  if (killer) clearTimeout(killer);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  fs.closeSync(out);
  fs.closeSync(err);
  return res;
}
