// Private CLI homes: some workers run with a settings folder of Pitroom's own (Gemini CLI, Antigravity), written
// when invoked and shared by every worker of that CLI, with links to the user's sign-in files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes `body` to `file` only when it differs, through a temporary file renamed over it: a worker starting at the
 * same moment reads the old file or the new one, never half of one. On Windows a file another process has open
 * cannot be replaced (EPERM, EBUSY): the rename is retried for a moment, then the file is written in place.
 */
export function writeIfChanged(file: string, body: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === body) return;
  } catch {
    // not written yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body);
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
      if (busy && tries < 10) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      fs.rmSync(tmp, { force: true });
      if (!busy) throw e;
      fs.writeFileSync(file, body);
      return;
    }
  }
}

/**
 * Links the user's file `from` into `dir` under its own name. A link that dangles or points elsewhere is replaced;
 * a real file there is the CLI's own (a sign-in it refreshed in place) and is left alone. Best effort: without the
 * link the worker asks to sign in, and fails with an auth error that doctor explains.
 */
export function linkInto(dir: string, from: string): void {
  const to = path.join(dir, path.basename(from));
  try {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(to);
    } catch {
      // nothing there yet
    }
    if (st && !st.isSymbolicLink()) return;
    if (st) {
      if (fs.readlinkSync(to) === from && fs.existsSync(from)) return;
      fs.unlinkSync(to);
    }
    if (fs.existsSync(from)) fs.symlinkSync(from, to);
  } catch {
    // see above
  }
}
