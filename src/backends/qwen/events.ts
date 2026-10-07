// Parses `qwen --output-format stream-json` into a ParsedRun. Qwen Code's stream has the shape of Claude Code's:
//   {type: system, subtype: init, session_id, model, tools, permission_mode}
//   {type: system, subtype: retry, data: {attempt, maxRetries, delayMs}}        (a rate limit being waited out)
//   {type: stream_event, event: {…}}                                            (UI state; skipped)
//   {type: assistant, message: {id, model, content: [text | tool_use], usage}}  ("[API Error: …]" text = an error)
//   {type: user, message: {content: [tool_result {tool_use_id, is_error, content}]}}
//   {type: result, subtype, is_error, result, usage, permission_denials, error: {message}}
import { MAX_STEPS, type ParsedRun, type Step, type Usage } from '../types.js';

const EDIT_TOOLS = new Set(['write_file', 'edit', 'notebook_edit']);
const SHELL = 'run_shell_command';
const DENIED = /permission was declined|denied by permission rules|requires permission|not allowed/i;
const API_ERROR = /^\[API Error: /;

export function parseEvents(jsonl: string): ParsedRun {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, toolCalls: 0, denied: 0 };
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const pendingEdits = new Map<string, string>();
  const timeline: Step[] = [];
  const stepOf = new Map<string, Step>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let lastText = '';
  let finalText: string | undefined;
  let lastActivity: string | undefined;
  let error: string | undefined;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // torn last line while streaming, or a line that is not an event
    }
    sessionId ??= e.session_id;
    if (e.type === 'system' && e.subtype === 'init') {
      model = e.model;
    } else if (e.type === 'system' && e.subtype === 'retry') {
      lastActivity = `waiting to retry (attempt ${e.data?.attempt ?? '?'} of ${e.data?.maxRetries ?? '?'})`;
    } else if (e.type === 'assistant') {
      const content: any[] = e.message?.content ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join(' ').trim();
      // A failed request comes back as an assistant message "[API Error: …]" with no tokens: not work done
      if (API_ERROR.test(text)) {
        error = apiError(text);
        continue;
      }
      usage.steps++;
      for (const c of content) {
        if (c.type === 'text' && String(c.text ?? '').trim()) {
          lastText = String(c.text).trim();
          lastActivity = `says: ${oneLine(lastText)}`;
          if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(lastText, 600) });
        } else if (c.type === 'tool_use') {
          usage.toolCalls++;
          tools[c.name] = (tools[c.name] ?? 0) + 1;
          const target = c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? c.input?.command ?? c.input?.url;
          lastActivity = `${c.name} ${target ? oneLine(String(target), 60) : ''}`.trim();
          if (EDIT_TOOLS.has(c.name) && c.input?.file_path) pendingEdits.set(String(c.id), String(c.input.file_path));
          if (timeline.length < MAX_STEPS) {
            const step: Step = { kind: EDIT_TOOLS.has(c.name) ? 'edit' : c.name === SHELL ? 'shell' : 'tool', name: c.name, text: clip(String(target ?? ''), 240) };
            timeline.push(step);
            stepOf.set(String(c.id), step);
          }
        }
      }
    } else if (e.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        const step = stepOf.get(String(c.tool_use_id));
        if (step) step.ok = !c.is_error;
        if (c.is_error) {
          if (DENIED.test(text)) usage.denied++;
        } else if (pendingEdits.has(String(c.tool_use_id))) {
          edits.push(pendingEdits.get(String(c.tool_use_id))!);
        }
      }
    } else if (e.type === 'result') {
      // the run's totals over all its requests (the per-message usage is one request's)
      const u = e.usage ?? {};
      usage.input += Math.max(0, num(u.input_tokens) - num(u.cache_read_input_tokens));
      usage.cacheRead += num(u.cache_read_input_tokens);
      usage.output += num(u.output_tokens);
      usage.total += num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens);
      usage.denied = Math.max(usage.denied, Array.isArray(e.permission_denials) ? e.permission_denials.length : 0);
      if (e.is_error) {
        error ??= apiError(String(e.error?.message ?? e.result ?? e.subtype ?? 'Qwen Code error'));
      } else if (typeof e.result === 'string') {
        finalText = e.result.trim();
      }
    }
  }
  return { sessionId, model, finalText: finalText ?? (error ? '' : lastText), usage, tools, edits, lastActivity, timeline, error };
}

/** "[API Error: 429 You exceeded …]\nPossible quota …" → "429 You exceeded … Possible quota …". */
const apiError = (text: string) => text.replace(API_ERROR, '').replace(/\](?=\s*(\n|$))/, '').replace(/\s+/g, ' ').trim() || text;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const oneLine = (s: string, max = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
