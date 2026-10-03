import claude from '@/assets/mascots/claude.gif';
import codex from '@/assets/mascots/codex.gif';
import gemini from '@/assets/mascots/gemini.gif';
import opencode from '@/assets/mascots/opencode.gif';
import { cn } from '@/lib/utils';

const MASCOTS: Record<string, string> = { claude, codex, gemini, opencode };
const TITLES: Record<string, string> = { opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI' };

/**
 * Which tool a run used: its animated pixel mascot (CodeIsland, MIT) while the worker is active, its mark
 * (OpenCode from svgl; Codex, Claude Code and Gemini from LobeHub icons) once it has stopped.
 */
export function WorkerIcon({ backend, active, className }: { backend: string; active?: boolean; className?: string }) {
  const title = TITLES[backend];
  if (!title) return null;
  const mascot = active ? MASCOTS[backend] : undefined;
  if (mascot) return <img src={mascot} alt={title} title={title} draggable={false} className="size-8 shrink-0 [image-rendering:pixelated]" />;
  return (
    <svg viewBox={backend === 'opencode' ? '0 0 512 512' : '0 0 24 24'} role="img" aria-label={title} className={cn('size-5 shrink-0', backend === 'opencode' && 'ring-1 ring-foreground/20', className)}>
      <title>{title}</title>
      {backend === 'opencode' && (
        <>
          <rect width="512" height="512" rx="96" className="fill-[#131010]" />
          <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
          <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="white" />
        </>
      )}
      {backend === 'codex' && (
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
      )}
      {backend === 'gemini' && (
        <path fill="#4285F4" fillRule="evenodd" d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" />
      )}
      {backend === 'claude' && (
        <path fill="#D97757" fillRule="evenodd" clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
      )}
    </svg>
  );
}
