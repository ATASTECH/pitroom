// Parses `gemini --output-format stream-json` into a ParsedRun. The events (Gemini CLI's own types):
//   {type: init, session_id, model}
//   {type: message, role: user | assistant, content, delta?}       (assistant text arrives in delta chunks)
//   {type: tool_use, tool_name, tool_id, parameters}
//   {type: tool_result, tool_id, status: success | error, output?, error?: {type, message}}
//   {type: error, severity: warning | error, message}
//   {type: result, status: success | error, error?, stats?: {total_tokens, input_tokens, output_tokens, cached, input, tool_calls, models}}
// Lines that are not JSON (output of a user's hooks, a banner) are skipped.
import { MAX_STEPS, type ParsedRun, type Step, type Usage } from '../types.js';

const EDIT_TOOLS = new Set(['replace', 'write_file', 'edit']);
const DENIED = /policy|permission|not allowed|denied|blocked|disallowed|refus/i;

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
  let sessionId: string | undefined;
  let model: string | undefined;
  let text = '';
  let lastText = '';
  let lastActivity: string | undefined;
  let error: string | undefined;
  let turns = 0;
  let inTurn = false;

  // The assistant's text so far becomes one step (and the candidate for the final answer).
  const flush = () => {
    const said = text.trim();
    text = '';
    if (!said) return;
    lastText = said;
    lastActivity = `says: ${oneLine(said)}`;
    if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(said, 600) });
  };
  const startTurn = () => {
    if (!inTurn) turns++;
    inTurn = true;
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // torn last line while streaming, or a hook's output
    }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'init') {
      sessionId ??= e.session_id;
      model ??= e.model;
    } else if (e.type === 'message') {
      if (e.role !== 'assistant') continue;
      startTurn();
      if (!e.delta && text) flush();
      text += String(e.content ?? '');
    } else if (e.type === 'tool_use') {
      flush();
      startTurn();
      const name = String(e.tool_name ?? 'tool');
      const p = e.parameters ?? {};
      usage.toolCalls++;
      tools[name] = (tools[name] ?? 0) + 1;
      const target = p.file_path ?? p.absolute_path ?? p.path ?? p.dir_path ?? p.pattern ?? p.command ?? p.query ?? p.url ?? p.prompt;
      lastActivity = `${name} ${target ? oneLine(String(target), 60) : ''}`.trim();
      const file = p.file_path ?? p.absolute_path ?? p.path;
      if (EDIT_TOOLS.has(name) && file) pendingEdits.set(String(e.tool_id), String(file));
      if (timeline.length < MAX_STEPS) {
        const step: Step = { kind: EDIT_TOOLS.has(name) ? 'edit' : name === 'run_shell_command' ? 'shell' : 'tool', name, text: clip(String(target ?? ''), 240) };
        timeline.push(step);
        stepOf.set(String(e.tool_id), step);
      }
    } else if (e.type === 'tool_result') {
      inTurn = false;
      const ok = e.status === 'success';
      const step = stepOf.get(String(e.tool_id));
      if (step) step.ok = ok;
      if (!ok && DENIED.test(`${e.error?.type ?? ''} ${e.error?.message ?? ''}`)) usage.denied++;
      if (ok && pendingEdits.has(String(e.tool_id))) edits.push(pendingEdits.get(String(e.tool_id))!);
    } else if (e.type === 'error') {
      if (e.severity === 'error') error ??= String(e.message ?? 'Gemini CLI error');
    } else if (e.type === 'result') {
      const s = e.stats ?? {};
      const cached = num(s.cached);
      usage.cacheRead += cached;
      usage.input += s.input !== undefined ? num(s.input) : Math.max(0, num(s.input_tokens) - cached);
      usage.output += num(s.output_tokens);
      usage.total += num(s.total_tokens) || num(s.input_tokens) + num(s.output_tokens);
      usage.toolCalls = Math.max(usage.toolCalls, num(s.tool_calls));
      model ??= Object.keys(s.models ?? {})[0];
      if (e.status === 'error') error ??= String(e.error?.message ?? e.error?.type ?? 'Gemini CLI error');
    }
  }
  flush();
  usage.steps = turns;
  return { sessionId, model, finalText: error ? '' : lastText, usage, tools, edits, lastActivity, timeline, error };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
