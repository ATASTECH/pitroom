// Parses `opencode run --format json` NDJSON events into a ParsedRun.
// Handles OpenCode v2 (tool "shell", no tokens.total, errors as {type, message, status})
// and the v1 shapes (tool "bash", tokens.total, errors as {name, data.message}).
import { MAX_STEPS, type ParsedRun, type Step, type Usage } from '../types.js';

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const DENIED = /rule which prevents you|permission denied|permission\.rejected/i;

export function parseEvents(ndjson: string): ParsedRun {
  const usage: Usage = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, cost: 0, steps: 0, toolCalls: 0, denied: 0,
  };
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const timeline: Step[] = [];
  const textByMessage = new Map<string, string[]>();
  let sessionId: string | undefined;
  let lastActivity: string | undefined;
  let error: string | undefined;

  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // partial line while the run is still streaming
    }
    sessionId ??= e.sessionID ?? e.part?.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case 'text': {
        const text = String(p.text ?? '');
        if (!text.trim()) break;
        const key = String(p.messageID ?? '');
        if (!textByMessage.has(key)) textByMessage.set(key, []);
        textByMessage.get(key)!.push(text);
        lastActivity = `says: ${oneLine(text)}`;
        if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(text.trim(), 600), at: stamp(e.timestamp) });
        break;
      }
      case 'tool_use': {
        const name = String(p.tool ?? 'tool');
        const st = p.state ?? {};
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        if (st.status === 'error' && DENIED.test(String(st.error ?? ''))) usage.denied++;
        if (st.status === 'completed' && EDIT_TOOLS.has(name)) {
          edits.push(String(st.input?.filePath ?? st.input?.path ?? name));
        }
        lastActivity = `${name} ${describe(st.input)}`.trim();
        if (timeline.length < MAX_STEPS) {
          const kind = EDIT_TOOLS.has(name) ? 'edit' : /^(bash|shell)$/.test(name) ? 'shell' : 'tool';
          // the full path or pattern, not the shortened description: the dashboard shortens it for display
          const text = kind === 'shell' ? String(st.input?.command ?? '') : String(st.input?.filePath ?? st.input?.path ?? st.input?.pattern ?? st.input?.url ?? '') || describe(st.input);
          timeline.push({ kind, name, text: clip(text, 240), ok: st.status === 'completed' ? true : st.status === 'error' ? false : undefined, at: stamp(e.timestamp) });
        }
        break;
      }
      case 'step_finish': {
        const t = p.tokens ?? {};
        usage.steps++;
        usage.input += num(t.input);
        usage.output += num(t.output);
        usage.reasoning += num(t.reasoning);
        usage.cacheRead += num(t.cache?.read);
        usage.cacheWrite += num(t.cache?.write);
        usage.total += num(t.total) || num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read);
        usage.cost = (usage.cost ?? 0) + num(p.cost);
        break;
      }
      case 'error': {
        error = describeError(e.error);
        break;
      }
    }
  }

  // The answer is the text of the last message that said anything; earlier
  // "let me look at…" narration is dropped to keep the primary's context small.
  const groups = [...textByMessage.values()];
  const finalText = (groups[groups.length - 1] ?? []).join('\n').trim();
  return { sessionId, finalText, usage, tools, edits, lastActivity, timeline, error };
}

/** One line that keeps what failure classification needs: message, error type, HTTP status. */
function describeError(err: any): string {
  if (!err || typeof err !== 'object') return 'unknown OpenCode error';
  const message = String(err.data?.message ?? err.message ?? err.name ?? 'unknown OpenCode error');
  let inner: string | undefined;
  try {
    inner = JSON.parse(err.response?.body ?? '{}')?.error?.type;
  } catch {
    /* body is not JSON */
  }
  const tags = [err.type, inner, err.status && `HTTP ${err.status}`].filter(Boolean);
  return tags.length ? `${message} [${tags.join(', ')}]` : message;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const stamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function describe(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v ? oneLine(String(v), 60) : '';
}
