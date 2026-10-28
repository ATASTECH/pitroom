#!/usr/bin/env node
// The GitHub Action (action.yml at the repository's root): `pitroom review --range BASE..HEAD` on a pull request's
// commits, by a cheap worker, read-only. The review goes to the job summary and to one comment on the pull request,
// updated on each push, and the step fails on critical (or important) findings when `fail-on` says so.
//
// Inputs come as INPUT_* variables (action.yml maps them); GITHUB_* are the runner's own. The worker's answer is put in
// the comment inside a code fence, so nothing it writes is rendered as links, images or mentions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'pitroom.mjs');
const MARKER = '<!-- pitroom-review -->';
const env = process.env;
const input = (name, fallback = '') => (env[`INPUT_${name}`] ?? '').trim() || fallback;

/** A GitHub annotation, or a plain line outside Actions. */
const annotate = (level, message) => console.log(`::${level}::${message.replace(/\r?\n/g, '%0A')}`);
const append = (file, text) => file && fs.appendFileSync(file, text);

function event() {
  try {
    return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    return {};
  }
}

const pr = event().pull_request;
const range = input('RANGE') || (pr ? `${pr.base.sha}..${pr.head.sha}` : '');
const failOn = input('FAIL_ON', 'never');
const worker = input('WORKER');
if (!range) {
  annotate('error', 'Pitroom review: nothing to review. Give "range" ("A..B"), or run on a pull_request event.');
  process.exit(1);
}
if (!['critical', 'important', 'never'].includes(failOn)) {
  annotate('error', `Pitroom review: "fail-on" is critical, important or never, not "${failOn}".`);
  process.exit(1);
}

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
const r = cli(['review', '--range', range, '--json', ...(worker ? ['-W', worker] : [])]);
let meta;
try {
  meta = JSON.parse(r.stdout);
} catch {
  meta = undefined;
}

const verdict = meta?.verdict;
const finished = meta?.state === 'done' && verdict && verdict.spec !== 'unknown';
const short = (sha) => (/^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha);
const shownRange = range.split('..').map(short).join('..');
const who = meta ? (meta.ran ?? meta.worker) : undefined;
// the model named first: a run that failed may report another as its session's
const model = who && (who.model ?? meta.resolvedModel);
const workerText = who ? `${who.backend}${model ? ` (${model})` : ''}` : worker || 'the default worker';

let body;
if (finished) {
  const report = cli(['show', meta.id, '--full']).stdout.trimEnd();
  const fence = '`'.repeat(Math.max(3, ...[...report.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  body = [
    `### Pitroom review: SPEC ${verdict.spec.toUpperCase()} · QUALITY ${verdict.quality === 'approved' ? 'APPROVED' : 'NEEDS FIXES'}`,
    `**critical ${verdict.critical} · important ${verdict.important} · minor ${verdict.minor}** · \`${shownRange}\` reviewed by ${workerText} · run \`${meta.id}\``,
    '',
    '<details><summary>The review</summary>',
    '',
    `${fence}text`,
    report,
    fence,
    '</details>',
  ].join('\n');
} else {
  const why = meta?.error ?? (meta ? `the reviewer ended ${meta.state} without a verdict` : (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-3).join(' '));
  body = `### Pitroom review could not finish\n\`${shownRange}\` on ${workerText}: ${why.replace(/`/g, "'").slice(0, 500)}`;
}

append(env.GITHUB_STEP_SUMMARY, `${body}\n`);
if (meta) {
  append(env.GITHUB_OUTPUT, `run=${meta.id}\n`);
  if (finished) append(env.GITHUB_OUTPUT, `spec=${verdict.spec}\nquality=${verdict.quality}\ncritical=${verdict.critical}\nimportant=${verdict.important}\nminor=${verdict.minor}\n`);
}

/** One comment per pull request, updated on each run: found by the marker it starts with. */
async function comment(text) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo || !pr?.number) return;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pitroom-action', 'content-type': 'application/json' };
  const call = async (method, url, payload) => {
    const res = await fetch(url, { method, headers, body: payload && JSON.stringify(payload) });
    if (!res.ok) throw new Error(`${method} ${url.replace(api, '')}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  let mine;
  for (let page = 1; page <= 10 && !mine; page++) {
    const list = await call('GET', `${api}/repos/${repo}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    mine = list.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (list.length < 100) break;
  }
  const payload = { body: `${MARKER}\n${text}` };
  if (mine) await call('PATCH', `${api}/repos/${repo}/issues/comments/${mine.id}`, payload);
  else await call('POST', `${api}/repos/${repo}/issues/${pr.number}/comments`, payload);
}

if (input('COMMENT', 'true') === 'true') {
  try {
    await comment(body);
  } catch (e) {
    // a fork's pull request gets a read-only token: the summary still has the review
    annotate('warning', `Pitroom review: could not comment on the pull request (${e.message}); the job summary has the review.`);
  }
}

if (!finished) {
  annotate(failOn === 'never' ? 'warning' : 'error', `Pitroom review could not finish on ${workerText}.`);
  process.exit(failOn === 'never' ? 0 : 1);
}
const blocking = failOn === 'critical' ? verdict.critical : failOn === 'important' ? verdict.critical + verdict.important : 0;
if (blocking) {
  annotate('error', `Pitroom review found ${blocking} ${failOn === 'critical' ? 'critical' : 'critical or important'} issue${blocking === 1 ? '' : 's'} (fail-on: ${failOn}).`);
  process.exit(1);
}
