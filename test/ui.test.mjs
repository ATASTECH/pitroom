// The dashboard in a real browser: system Chrome driven over the DevTools protocol (no extra dependency).
// Skipped when Chrome is not installed; set CHROME=/path/to/chrome to point at one.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sandbox, scratchDir } from './helpers.mjs';

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chrome = CANDIDATES.find((p) => fs.existsSync(p));
const skip = chrome ? false : 'Chrome was not found (set CHROME=/path/to/chrome)';
const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let s, url, proc, ws, ids = {};
let seq = 0;
const waiting = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
/** Polls the page until `expression` is truthy; the message says what was being waited for. */
async function until(expression, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await evaluate(expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
const open = async (hash = '') => {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url: `${url}${hash}` });
  await until("document.querySelector('[role=tab]') !== null", 'the page to render');
};
const click = (expression) => evaluate(`(${expression})?.click()`);
const key = (name, code, vk) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk }).then(() =>
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk }));
const CARD_BODY = `[...document.querySelectorAll('[data-slot="expandable-card-body"]')]`;
const cardWith = (text) => `${CARD_BODY}.find((e) => e.textContent.includes(${JSON.stringify(text)}))`;
const modal = () => evaluate("document.querySelector('[aria-label=\"Close\"]') !== null");

before(async () => {
  if (skip) return;
  s = sandbox();
  // a read run and an isolate run that adds a TypeScript file and edits a text file
  const research = s.run(['run', 'list the files in this project']);
  assert.equal(research.status, 0, research.stderr);
  ids.research = RUN_ID.exec(research.stdout)[0];
  const change = s.run(['run', '--isolate', 'add a greeting helper'], {
    MOCK_ACTIONS: 'write:greet.ts:export const greeting: string = "hello";;append:app.txt:worker line;answer:SUMMARY: added greet.ts',
  });
  assert.equal(change.status, 0, change.stderr + change.stdout);
  ids.change = RUN_ID.exec(change.stdout)[0];
  // another worker disputes the research answer
  const audit = s.run(['audit', ids.research, '-W', 'opencode:mock/other'], {
    MOCK_ACTIONS: 'answer:AUDIT: DISAGREE\nCHECKED: 1\nDISPUTED:\n- the file list is incomplete (app.txt:1)',
  });
  assert.equal(audit.status, 0, audit.stderr + audit.stdout);
  const start = s.run(['dash', '--detach', '--port', '0']);
  assert.equal(start.status, 0, start.stderr);
  url = start.stdout.trim().split('\n')[0];

  const profile = scratchDir('pitroom-chrome-');
  proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await sleep(100);
    }
  }
  assert.ok(port, 'Chrome did not start');
  let tab;
  for (let i = 0; i < 50 && !tab; i++) {
    try {
      tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      await sleep(100);
    }
  }
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const w = d.id && waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    if (d.error) w.reject(new Error(d.error.message)); else w.resolve(d.result);
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
});

after(async () => {
  try { ws?.close(); } catch { /* closed */ }
  if (proc) {
    // Chrome writes to its profile while it shuts down: let it finish before the directory is removed
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try { proc.kill(); } catch { /* gone */ }
    await Promise.race([exited, sleep(5000)]);
  }
  if (s) s.run(['dash', '--stop']);
});

test('ui: the Live tab lists runs; a card opens, and closes with its X and with Escape', { skip }, async () => {
  await open();
  await until(`${cardWith('list the files')} !== undefined`, 'the research card');
  assert.equal(await modal(), false, 'no card is open at first');

  await click(cardWith('list the files'));
  await until("document.querySelector('[aria-label=\"Close\"]') !== null", 'the card to open');
  assert.match(await evaluate('document.body.innerText'), /list the files in this project/);
  await click("document.querySelector('[aria-label=\"Close\"]')");
  await until("document.querySelector('[aria-label=\"Close\"]') === null", 'the X to close the card');

  await click(cardWith('list the files'));
  await until("document.querySelector('[aria-label=\"Close\"]') !== null", 'the card to open again');
  await key('Escape', 'Escape', 27);
  await until("document.querySelector('[aria-label=\"Close\"]') === null", 'Escape to close the card');
});

test('ui: a #run-id link pins that run open, and closing it clears the hash', { skip }, async () => {
  await open(`#${ids.research}`);
  await until("document.querySelector('[aria-label=\"Close\"]') !== null", 'the pinned card');
  assert.match(await evaluate('document.body.innerText'), /list the files in this project/);
  assert.equal(await evaluate('location.hash'), `#${ids.research}`);
  await click("document.querySelector('[aria-label=\"Close\"]')");
  await until("document.querySelector('[aria-label=\"Close\"]') === null", 'the pinned card to close');
  assert.equal(await evaluate('location.hash'), '', 'the hash is cleared');

  await open('#20200101-000000-0000');
  await sleep(600);
  assert.equal(await modal(), false, 'an unknown run id opens nothing');
  assert.equal(await evaluate('location.hash'), '', 'and its hash is dropped');
});

test('ui: an isolate run shows its changed files, and a file opens into a highlighted diff', { skip }, async () => {
  await open(`#${ids.change}`);
  await until("document.querySelector('[aria-label=\"Close\"]') !== null", 'the pinned card');
  const changes = "[...document.querySelectorAll('button[aria-expanded]')].find((b) => /^Changes/.test(b.textContent))";
  await until(`${changes} !== undefined`, 'the Changes section');
  assert.match(await evaluate(`${changes}.textContent`), /Changes · 2 files/i);
  await click(changes);
  const files = "[...document.querySelectorAll('[data-slot=\"file-diff\"]')].filter((f) => f.closest('section')?.querySelector('h4')?.textContent.startsWith('Changes'))";
  await until(`${files}.length === 2`, 'two file rows');
  const row = `${files}.find((f) => f.textContent.includes('greet.ts'))`;
  assert.match(await evaluate(`${row}.textContent`), /greet\.ts.*A.*\+1/s, 'an added file with one added line');
  assert.equal(await evaluate(`${row}.querySelector('[data-slot="file-diff-viewport"]')`), null, 'collapsed until opened');

  await click(`${row}.querySelector('button')`);
  await until(`${row}.querySelector('[data-slot="file-diff-viewport"]') !== null`, 'the diff to open');
  assert.match(await evaluate(`${row}.querySelector('[data-slot="file-diff-viewport"]').innerText`), /export const greeting: string = "hello";/);
  // Shiki colours the tokens: they carry their theme colours as CSS variables, several different ones in this line
  const colours = await until(
    `(() => { const c = new Set([...${row}.querySelectorAll('[data-slot="file-diff-viewport"] span[style*="--agent-code-light"]')].map((e) => e.style.getPropertyValue('--agent-code-light')).filter((v) => v && v !== 'currentColor')); return c.size >= 3 ? c.size : 0; })()`,
    'syntax-highlighted tokens',
  );
  assert.ok(colours >= 3, `the diff uses several token colours (${colours})`);
  assert.equal(await evaluate(`${row}.querySelector('button').getAttribute('aria-expanded')`), 'true');
  await click(`${row}.querySelector('button')`);
  await until(`${row}.querySelector('[data-slot="file-diff-viewport"]') === null`, 'the diff to close');
});

test('ui: the Stats tab shows each worker with its logo and the totals', { skip }, async () => {
  await open('#stats');
  await until("document.body.innerText.includes('Statistics')", 'the Stats page');
  const row = await until(
    "[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('opencode'))?.querySelector('svg[role=\"img\"]')?.getAttribute('aria-label')",
    'the OpenCode row with its logo',
  );
  assert.equal(row, 'OpenCode');
  const text = await evaluate('document.body.innerText');
  assert.match(text, /RUNS\s*\n?\s*2/i, 'both runs are counted');
  await click("[...document.querySelectorAll('[role=tab]')].find((e) => e.textContent === 'History')");
  await until("document.body.innerText.includes('add a greeting helper')", 'the History tab to list the isolate run');
});

test('ui: an audited run carries the audit\'s verdict, its disputed claims, and a Stats count', async () => {
  await open();
  await until(`${cardWith('list the files')} !== undefined`, 'the research card');
  assert.match(await evaluate(`${cardWith('list the files')}.parentElement.innerText`), /audited · disagrees/, 'the badge on the audited run');
  assert.match(await evaluate('document.body.innerText'), /Audit disagrees/, 'and the audit run\'s own card');
  await click(cardWith('list the files'));
  await until("document.querySelector('[aria-label=\"Close\"]') !== null", 'the card to open');
  await until("document.body.innerText.includes('the file list is incomplete')", 'the disputed claim in the card');
  await key('Escape', 'Escape', 27);

  await open('#stats');
  const audited = await until(
    "[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('opencode'))?.querySelector('td[title*=\"audited answers\"]')?.textContent",
    'the Audited column',
  );
  assert.equal(audited, '0/1', 'one audited answer, none confirmed');
  assert.match(await evaluate('document.body.innerText'), /RUNS\s*\n?\s*2/i, 'the audit is not counted as a run');
});
