// Small helpers the adapters share: text for the event parsers, regexes, and a target's model#effort.

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

/** `s` as a literal inside a regular expression. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "gpt-5.6-sol#low" → model and reasoning effort. */
export function splitModel(model: string | undefined): { model?: string; effort?: string } {
  if (!model) return {};
  const [m, effort] = model.split('#');
  return { model: m || undefined, effort: effort || undefined };
}
