#!/usr/bin/env node
// Fake `cursor-agent` for end-to-end tests: writes a stream in the shape Cursor CLI 2026.05.09 does (see
// ../events) and logs every invocation (argv, cwd, HOME, CURSOR_CONFIG_DIR, its cli-config.json) to $MOCK_LOG.
//   MOCK_ANSWER=text       the final answer (default "SUMMARY: mock answer")
//   MOCK_WRITE=file:text   write <file> in the workspace first (an edit)
//   MOCK_FAIL=message      print it on stderr and exit 1, as Cursor does for a model or sign-in problem
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const workspace = opt('--workspace') ?? process.cwd();
const configDir = process.env.CURSOR_CONFIG_DIR;
if (process.env.MOCK_LOG) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(configDir ?? '', 'cli-config.json'), 'utf8'));
  } catch {
    config = undefined;
  }
  fs.appendFileSync(process.env.MOCK_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), home: process.env.HOME, configDir, config })}\n`);
}
if (process.env.MOCK_FAIL) {
  process.stderr.write(`${process.env.MOCK_FAIL}\n`);
  process.exit(1);
}
const session = opt('--resume') ?? 'chat-mock-1';
const out = (e) => console.log(JSON.stringify({ ...e, session_id: session }));
out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: workspace, model: 'Auto', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: argv.at(-1) }] } });
if (process.env.MOCK_WRITE) {
  const [file, ...text] = process.env.MOCK_WRITE.split(':');
  const target = path.join(workspace, file);
  const call = { call_id: 'call-1', tool_call: { editToolCall: { args: { path: target } } }, timestamp_ms: Date.now() };
  out({ type: 'tool_call', subtype: 'started', ...call });
  fs.writeFileSync(target, `${text.join(':')}\n`);
  out({ type: 'tool_call', subtype: 'completed', ...call, tool_call: { editToolCall: { args: { path: target }, result: { success: { path: target, linesAdded: 1 } } } } });
}
const answer = process.env.MOCK_ANSWER ?? 'SUMMARY: mock answer';
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } });
