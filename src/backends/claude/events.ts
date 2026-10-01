// Parses `claude -p --output-format stream-json --verbose` into a ParsedRun.
//   {type: system, subtype: init, session_id, model, tools}
//   {type: assistant, message: {id, content: [text | tool_use]}}   (is_api_error_message → an error, not work)
//   {type: user, message: {content: [tool_result {tool_use_id, is_error, content}]}}
//   {type: result, result, is_error, total_cost_usd, usage, permission_denials, terminal_reason}
import { MAX_STEPS, type ParsedRun, type Usage, type Step } from '../types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DENIED = /permission|not allowed|denied|blocked|disallowed/i;

export function parseEvents(jsonl: string): ParsedRun {
  const usage: Usage = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, steps: 0, toolCalls: 0, denied: 0,
  };
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const pendingEdits = new Map<string, string>();
  const timeline: Step[] = [];
  const stepOf = new Map<string, Step>();
  const steps = new Set<string>();
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
      continue; // torn last line while streaming
    }
    sessionId ??= e.session_id;
    if (e.type === 'system' && e.subtype === 'init') {
      model = e.model;
    } else if (e.type === 'assistant') {
      const content: any[] = e.message?.content ?? [];
      if (e.is_api_error_message || e.error) {
        error = content.map((c) => c.text).filter(Boolean).join(' ') || String(e.error);
        if (e.error) error = `${error} [${e.error}]`;
        continue;
      }
      steps.add(String(e.message?.id ?? e.uuid ?? steps.size));
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
          if (EDIT_TOOLS.has(c.name) && c.input?.file_path) pendingEdits.set(c.id, String(c.input.file_path));
          if (timeline.length < MAX_STEPS) {
            const step: Step = { kind: EDIT_TOOLS.has(c.name) ? 'edit' : c.name === 'Bash' ? 'shell' : 'tool', name: c.name, text: clip(String(target ?? ''), 240) };
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
        } else if (pendingEdits.has(c.tool_use_id)) {
          edits.push(pendingEdits.get(c.tool_use_id)!);
        }
      }
    } else if (e.type === 'result') {
      const u = e.usage ?? {};
      usage.input += num(u.input_tokens);
      usage.cacheRead += num(u.cache_read_input_tokens);
      usage.cacheWrite += num(u.cache_creation_input_tokens);
      usage.reasoning += num(u.output_tokens_details?.thinking_tokens);
      usage.output += Math.max(0, num(u.output_tokens) - num(u.output_tokens_details?.thinking_tokens));
      usage.total += num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
      usage.cost = (usage.cost ?? 0) + num(e.total_cost_usd);
      usage.denied = Math.max(usage.denied, Array.isArray(e.permission_denials) ? e.permission_denials.length : 0);
      if (e.is_error) {
        const tags = [e.terminal_reason, e.api_error_status && `HTTP ${e.api_error_status}`].filter(Boolean);
        error ??= `${String(e.result ?? e.subtype ?? 'Claude Code error')}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
      } else if (typeof e.result === 'string') {
        finalText = e.result.trim();
      }
    }
  }
  usage.steps = steps.size;
  return { sessionId, model, finalText: finalText ?? (error ? '' : lastText), usage, tools, edits, lastActivity, timeline, error };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
