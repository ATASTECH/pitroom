// Parses `cursor-agent -p --output-format stream-json` into a ParsedRun, as Cursor CLI 2026.05.09 writes it:
//   {type: system, subtype: init, session_id, model}                       model: a display name ("Auto")
//   {type: user, message}                                                   the prompt
//   {type: thinking, subtype: delta | completed, text}                      reasoning, not kept
//   {type: assistant, message: {content: [{type: text, text}]}, timestamp_ms?}
//   {type: tool_call, subtype: started | completed, call_id, tool_call: {<name>ToolCall: {args, result?}}, timestamp_ms}
//      result: {success} | {error: {errorMessage}} | {rejected: {reason}} | {permissionDenied} | {failure} (a command that exited non-zero)
//   {type: result, subtype, is_error, result, usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}
// `result.result` joins every assistant message of the turn, narration included: the answer is the last message.
import { MAX_STEPS, type ParsedRun, type Step, type Usage } from '../types.js';
import { clip, num, oneLine } from '../text.js';

const EDITS = new Set(['edit', 'write', 'delete']);
/** A refusal by its permission rules, its mode, or a headless run that cannot ask: counted as denied. */
const REFUSED = new Set(['rejected', 'permissionDenied']);

/** The tool's name and what it worked on, from `{readToolCall: {args}}`. */
function toolOf(call: any): { name: string; args: any; result: any } {
  const key = Object.keys(call ?? {})[0] ?? 'unknown';
  const body = call?.[key] ?? {};
  return { name: key.replace(/ToolCall$/, ''), args: body.args ?? {}, result: body.result };
}

const target = (name: string, args: any): string =>
  String(name === 'mcp' ? args.name ?? '' : args.path ?? args.command ?? args.pattern ?? args.globPattern ?? args.url ?? args.query ?? '');

export function parseEvents(jsonl: string): ParsedRun {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, toolCalls: 0, denied: 0 };
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const timeline: Step[] = [];
  const stepOf = new Map<string, Step>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let lastText = '';
  let resultText: string | undefined;
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
    const at = typeof e.timestamp_ms === 'number' ? e.timestamp_ms : undefined;
    if (e.type === 'system' && e.subtype === 'init') {
      model = e.model;
    } else if (e.type === 'assistant') {
      const text = (e.message?.content ?? []).map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : '')).join('').trim();
      if (!text) continue;
      usage.steps++;
      lastText = text;
      lastActivity = `says: ${oneLine(text)}`;
      if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(text, 600), at });
    } else if (e.type === 'tool_call') {
      const { name, args, result } = toolOf(e.tool_call);
      const id = String(e.call_id ?? '');
      if (e.subtype === 'started') {
        usage.toolCalls++;
        tools[name] = (tools[name] ?? 0) + 1;
        const what = target(name, args);
        lastActivity = `${name} ${oneLine(what, 60)}`.trim();
        if (timeline.length < MAX_STEPS) {
          const step: Step = { kind: EDITS.has(name) ? 'edit' : name === 'shell' ? 'shell' : 'tool', name, text: clip(what, 240), at };
          timeline.push(step);
          stepOf.set(id, step);
        }
      } else if (e.subtype === 'completed') {
        const outcome = Object.keys(result ?? {})[0];
        const step = stepOf.get(id);
        if (step) step.ok = outcome === 'success';
        if (REFUSED.has(outcome ?? '') || (outcome === 'error' && /permission denied/i.test(String(result.error?.errorMessage ?? '')))) usage.denied++;
        if (outcome === 'success' && EDITS.has(name) && args.path) edits.push(String(args.path));
      }
    } else if (e.type === 'result') {
      const u = e.usage ?? {};
      usage.input += num(u.inputTokens);
      usage.output += num(u.outputTokens);
      usage.cacheRead += num(u.cacheReadTokens);
      usage.cacheWrite += num(u.cacheWriteTokens);
      usage.total += num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
      if (e.is_error) error ??= String(e.result || e.subtype || 'Cursor CLI error');
      else if (typeof e.result === 'string') resultText = e.result.trim();
    } else if (e.type === 'error') {
      error ??= String(e.message ?? e.error?.message ?? e.error ?? 'Cursor CLI error');
    }
  }
  return { sessionId, model, finalText: lastText || (error ? '' : (resultText ?? '')), usage, tools, edits, lastActivity, timeline, error };
}
