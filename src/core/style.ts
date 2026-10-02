// Terminal colours for the CLI's own output (doctor, init, status tables). Off when the output is not a terminal
// (pipes, files, agents' tool output), when NO_COLOR is set or the terminal is dumb; FORCE_COLOR turns it on.
const enabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
};

const wrap = (open: number, close: number) => (text: string) => (enabled() ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);

/** The coloured state word of a run, as the tables and reports print it. */
export function stateColour(state: string, text: string = state): string {
  if (state === 'done') return green(text);
  if (state === 'running') return blue(text);
  if (state === 'queued') return yellow(text);
  if (state === 'failed') return red(text);
  if (state === 'timeout') return yellow(text);
  return dim(text);
}

/** Wraps `text` to the terminal's width with a hanging indent. Left alone when the output is not a terminal. */
export function wrapText(text: string, indent: number): string {
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  if (!columns || text.length + indent <= columns) return text;
  const width = Math.max(40, Math.min(columns, 110) - indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}
