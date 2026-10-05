// Replacing a file by renaming a finished temp file over it. On Windows that fails with EPERM, EBUSY or
// EACCES while another process (`pitroom watch`, the dashboard, a status line) has the target open for
// reading; the other side lets go within milliseconds, so try again a few times.
import fs from 'node:fs';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function renameOver(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || !BUSY.has((e as NodeJS.ErrnoException).code ?? '') || attempt >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // sleeps this thread 25 ms
    }
  }
}
