// Parses `codex exec --json` JSONL into a ParsedRun.
//   thread.started {thread_id}                      → session
//   item.completed {item: agent_message|command_execution|file_change|mcp_tool_call|web_search|reasoning|todo_list}
//   item.completed {item: {type: "error"}}          → a warning (deprecated config, skills budget…), not a failure
//   turn.completed {usage}                          → tokens (cached ⊂ input, reasoning ⊂ output)
//   error / turn.failed {error: {message}}          → the failure; message is often a JSON API error
import { MAX_STEPS, type ParsedRun, type Usage, type Step } from '../types.js';

const WORK = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
const TOOLS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

export function parseEvents(jsonl: string): ParsedRun {
  const usage: Usage = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, steps: 0, toolCalls: 0, denied: 0,
  };
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const timeline: Step[] = [];
  let sessionId: string | undefined;
  let finalText = '';
  let lastActivity: string | undefined;
  let error: string | undefined;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // torn last line while streaming
    }
    switch (e.type) {
      case 'thread.started':
        sessionId ??= e.thread_id;
        break;
      case 'item.completed': {
        const it = e.item ?? {};
        if (!WORK.has(it.type)) break;
        usage.steps++;
        if (TOOLS.has(it.type)) {
          usage.toolCalls++;
          tools[it.type] = (tools[it.type] ?? 0) + 1;
        }
        if (it.type === 'agent_message' && String(it.text ?? '').trim()) {
          finalText = String(it.text).trim();
          lastActivity = `says: ${oneLine(finalText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(finalText, 600) });
        } else if (it.type === 'command_execution') {
          if (it.status === 'declined' || /operation not permitted|sandbox/i.test(String(it.aggregated_output ?? ''))) usage.denied++;
          lastActivity = `shell ${oneLine(String(it.command ?? ''), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: 'shell', name: 'shell', text: clip(String(it.command ?? '').replace(/^\/bin\/\w+ -lc /, ''), 240), ok: it.exit_code === 0 });
        } else if (it.type === 'file_change') {
          const paths = (it.changes ?? []).map((c: any) => String(c.path));
          if (it.status !== 'failed' && it.status !== 'declined') edits.push(...paths);
          else usage.denied++;
          lastActivity = `edit ${oneLine(paths.join(', '), 60)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: 'edit', name: 'edit', text: clip(paths.join(', '), 240), ok: it.status !== 'failed' && it.status !== 'declined' });
        }
        break;
      }
      case 'turn.completed': {
        const u = e.usage ?? {};
        const cached = num(u.cached_input_tokens);
        const reasoning = num(u.reasoning_output_tokens);
        usage.input += Math.max(0, num(u.input_tokens) - cached);
        usage.cacheRead += cached;
        usage.cacheWrite += num(u.cache_write_input_tokens);
        usage.output += Math.max(0, num(u.output_tokens) - reasoning);
        usage.reasoning += reasoning;
        usage.total += num(u.input_tokens) + num(u.output_tokens);
        break;
      }
      case 'error':
        error = describe(e.message);
        break;
      case 'turn.failed':
        error = describe(e.error?.message ?? e.message);
        break;
    }
  }
  // cost stays undefined: Codex does not report it.
  return { sessionId, finalText, usage, tools, edits, lastActivity, timeline, error };
}

/** Codex wraps API errors as a JSON string; keep the message plus type and status. */
function describe(raw: unknown): string {
  const s = String(raw ?? 'unknown Codex error');
  try {
    const j = JSON.parse(s);
    const inner = j.error ?? j;
    const tags = [inner.type, j.status && `HTTP ${j.status}`].filter(Boolean);
    return `${inner.message ?? s}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
  } catch {
    return s;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
