// Parses `agy -p … --output-format stream-json` into a ParsedRun. The events, as agy 1.3.5 writes them (and its
// headless docs describe them):
//   {event: init, conversation_id, init: {model?, cwd, tools, permission_mode}}
//   {event: step_update, step_update: {conversation_id, step_index, state: ACTIVE | DONE | ERROR, step_type,
//                                      tool_name?, text_delta?, tool_info?: {name, parameters, output?, error?}, usage?}}
//     step_type: user_input | agent_response | tool | checkpoint | error_message; text arrives in text_delta chunks;
//     a failed or refused tool call ends in state ERROR with error: {type, message}
//   {event: result, result: {conversation_id, status, response, error?, num_turns, denied_actions?,
//    usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}}
// Tool names are agy's own (run_command, view_file, write_to_file, replace_file_content, …) with parameters such as
// CommandLine, TargetFile and AbsolutePath. Every field is read tolerantly (older spellings with `type` and the payload
// at the top level too). Lines that are not JSON are skipped.
import { MAX_STEPS, type ParsedRun, type Step, type Usage } from '../types.js';
import { clip, num, oneLine } from '../text.js';

const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'write_file']);
const SHELL = 'run_command';
const DENIED = /soft-denied|permission|denied|not allowed|blocked|refus|requires approval/i;
const FAILED = /error|fail|denied|cancel|reject/i;
const OK = /^(success|succeeded|ok|done|completed?)$/i;

export function parseEvents(jsonl: string): ParsedRun {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, toolCalls: 0, denied: 0 };
  const stepUsage: unknown[] = [];
  const usageSeen = new Set<string>();
  const tools: Record<string, number> = {};
  const edits: string[] = [];
  const timeline: Step[] = [];
  // per step index: the text said so far, the timeline entry, and whether the step was already finished
  const said = new Map<string, string>();
  const stepOf = new Map<string, Step>();
  const toolSeen = new Set<string>();
  const done = new Set<string>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let lastText = '';
  let response: string | undefined;
  let lastActivity: string | undefined;
  let error: string | undefined;
  // an `error` event: agy may retry after one, so it is the run's error only when no result follows
  let streamError: string | undefined;
  let resultSeen = false;
  let haveResultUsage = false;
  // steps without an index: the open one of each kind, so its ACTIVE and DONE updates are one step
  const open = new Map<string, string>();
  let unnamed = 0;
  let turns = 0;
  let inTurn = false;

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
      continue; // torn last line while streaming, or a log line
    }
    if (!e || typeof e !== 'object') continue;
    const type = String(e.event ?? e.type ?? '').toLowerCase();
    // the event's payload sits under its own name ({event: "result", result: {…}})
    const body = (name: string) => (e[name] && typeof e[name] === 'object' ? e[name] : e);
    if (type === 'init') {
      sessionId ??= id(e.conversation_id ?? e.session_id ?? body('init').conversation_id);
      model ??= id(body('init').model);
    } else if (type === 'step_update') {
      const s = body('step_update');
      sessionId ??= id(s.conversation_id);
      const kind = String(s.step_type ?? '').toLowerCase();
      const state = String(s.state ?? '').toUpperCase();
      const failedStep = state === 'ERROR';
      const finished = state === 'DONE' || failedStep;
      let key = s.step_index ?? s.step_id;
      if (key === undefined || key === null) {
        key = open.get(kind) ?? `${kind}#${unnamed++}`;
        if (finished) open.delete(kind);
        else open.set(kind, key);
      }
      key = String(key);
      if (kind === 'agent_response') {
        startTurn();
        const text = (said.get(key) ?? '') + str(s.text_delta);
        said.set(key, text);
        if (finished && !done.has(key)) {
          done.add(key);
          const t = text.trim();
          if (t) {
            lastText = t;
            lastActivity = `says: ${oneLine(t)}`;
            if (timeline.length < MAX_STEPS) timeline.push({ kind: 'say', text: clip(t, 600) });
          }
        }
      } else if (kind === 'tool') {
        const info = s.tool_info && typeof s.tool_info === 'object' ? s.tool_info : {};
        const name = String(info.name ?? info.tool_name ?? s.tool_name ?? 'tool');
        const p = info.parameters ?? info.args ?? info.arguments ?? s.parameters ?? {};
        if (!toolSeen.has(key)) {
          toolSeen.add(key);
          startTurn();
          lastText = ''; // the answer is the text after the last tool call, not narration before it
          usage.toolCalls++;
          tools[name] = (tools[name] ?? 0) + 1;
          const target = p.CommandLine ?? p.command ?? p.TargetFile ?? p.AbsolutePath ?? p.file_path ?? p.path ?? p.SearchPath ?? p.Query ?? p.query ?? p.Url ?? p.url;
          lastActivity = `${name} ${target ? oneLine(String(target), 60) : ''}`.trim();
          if (timeline.length < MAX_STEPS) {
            const step: Step = { kind: EDIT_TOOLS.has(name) ? 'edit' : name === SHELL ? 'shell' : 'tool', name, text: clip(String(target ?? ''), 240) };
            timeline.push(step);
            stepOf.set(key, step);
          }
        }
        if (finished && !done.has(key)) {
          done.add(key);
          inTurn = false;
          const problem = `${errText(info.error)} ${str(info.status ?? s.status)}`.trim();
          const ok = !failedStep && (!problem || OK.test(problem) || !FAILED.test(problem));
          const step = stepOf.get(key);
          if (step) step.ok = ok;
          if (!ok && DENIED.test(`${problem} ${str(info.output)}`)) usage.denied++;
          const file = p.TargetFile ?? p.AbsolutePath ?? p.file_path ?? p.path;
          if (ok && EDIT_TOOLS.has(name) && file) edits.push(String(file));
        }
      }
      // a step's own usage, once per step however often its DONE update repeats
      if (finished && s.usage && typeof s.usage === 'object' && !usageSeen.has(`${kind}:${key}`)) {
        usageSeen.add(`${kind}:${key}`);
        stepUsage.push(s.usage);
      }
    } else if (type === 'result') {
      const r = body('result');
      sessionId ??= id(r.conversation_id);
      model ??= id(r.model);
      if (typeof r.response === 'string') response = r.response.trim();
      if (r.usage && typeof r.usage === 'object') {
        add(usage, r.usage);
        haveResultUsage = true;
      }
      // tool calls agy refused for want of a grant a headless run cannot ask for
      if (Array.isArray(r.denied_actions)) usage.denied = Math.max(usage.denied, r.denied_actions.length);
      resultSeen = true;
      const status = str(r.status);
      const message = errText(r.error);
      // A successful status wins over an error field beside it (an empty `{}`, or an earlier attempt's error).
      if (status ? !OK.test(status) : !!message) {
        error ??= message || (/^waiting$/i.test(status)
          ? 'agy stopped waiting for an approval a headless run cannot give'
          : `agy ended with status ${status}`);
      }
    } else if (type === 'error') {
      streamError ??= (typeof e.message === 'string' && e.message) || errText(e.error) || 'Antigravity CLI error';
    }
  }
  // An error the run never recovered from: no result came, or the result has no answer.
  if (streamError && (!resultSeen || !response)) error ??= streamError;
  // Without a result (a run cut short), the tokens are the sum of the finished steps' own usage.
  if (!haveResultUsage) for (const u of stepUsage) add(usage, u);
  usage.steps = turns;
  const finalText = error ? '' : response || lastText;
  return { sessionId, model, finalText, usage, tools, edits, lastActivity, timeline, error };
}

/** Adds a usage object as agy reports it; cached input is part of input_tokens. */
function add(u: Usage, r: any): void {
  const cached = num(r.cache_read_tokens ?? r.cached_tokens);
  const input = num(r.input_tokens);
  u.cacheRead += cached;
  u.input += Math.max(0, input - cached);
  u.output += num(r.output_tokens);
  u.reasoning += num(r.thinking_tokens ?? r.reasoning_tokens);
  u.total += num(r.total_tokens) || input + num(r.output_tokens) + num(r.thinking_tokens ?? r.reasoning_tokens);
}

const id = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** An error's text: a string, an object's `message` (with its `code`), or the object itself; an empty object is no error. */
function errText(v: any): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object' || !Object.keys(v).length) return '';
  const code = typeof v.code === 'string' || typeof v.code === 'number' ? String(v.code) : '';
  const message = typeof v.message === 'string' ? v.message : typeof v.reason === 'string' ? v.reason : '';
  return [code, message].filter(Boolean).join(': ') || JSON.stringify(v);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
