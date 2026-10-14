// Small text helpers the event parsers share.

/** At most `n` characters, with an ellipsis when cut. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A finite number, or 0. */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Whitespace collapsed to single spaces, at most `max` characters. */
export function oneLine(s: string, max = 80): string {
  return clip(s.replace(/\s+/g, ' ').trim(), max);
}
