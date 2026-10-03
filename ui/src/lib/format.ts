export const clock = (s: number) => {
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
};
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const usd = (n: number) => `$${n.toFixed(2)}`;
export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
/** "opencode (muse-spark)" → backend and model. */
export function splitWorker(w: string): { backend: string; model?: string } {
  const m = /^(\S+)(?: \((.*)\))?$/.exec(w);
  return { backend: m?.[1] ?? w, model: m?.[2] };
}
export const BACKEND_COLOR: Record<string, string> = { opencode: 'var(--info)', codex: 'var(--success)', claude: 'var(--brand)', gemini: 'var(--gemini)' };
