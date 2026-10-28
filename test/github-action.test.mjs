// The GitHub Action's script (scripts/github-review.mjs): a pull request's commits reviewed, the review in the job
// summary and in one PR comment updated on each run, outputs set, and the step failed per fail-on.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { root, sandbox } from './helpers.mjs';

const SCRIPT = path.join(root, 'scripts', 'github-review.mjs');

// A fake GitHub API in a process of its own (the script runs with spawnSync, which would block one in this process).
const SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const comments = [];
let next = 1;
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : undefined;
    fs.appendFileSync(process.argv[1], JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization, body }) + '\\n');
    res.setHeader('content-type', 'application/json');
    let m;
    if (req.method === 'GET' && /^\\/repos\\/o\\/r\\/issues\\/7\\/comments\\?/.test(req.url)) return res.end(JSON.stringify(comments));
    if (req.method === 'POST' && req.url === '/repos/o/r/issues/7/comments') {
      const c = { id: next++, body: body.body };
      comments.push(c);
      return res.end(JSON.stringify(c));
    }
    if (req.method === 'PATCH' && (m = /^\\/repos\\/o\\/r\\/issues\\/comments\\/(\\d+)$/.exec(req.url))) {
      const c = comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return res.end(JSON.stringify(c));
    }
    res.statusCode = 404;
    res.end('{}');
  });
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;

async function fakeGitHub(dir) {
  const log = path.join(dir, 'github.log');
  const srv = spawn(process.execPath, ['-e', SERVER, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => srv.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { url: `http://127.0.0.1:${port}`, requests, stop: () => srv.kill() };
}

/** A pull request of one commit on the sandbox repository, and the files the runner would give the step. */
function pullRequest(s) {
  const base = s.git('rev-parse', 'HEAD').trim();
  fs.appendFileSync(path.join(s.repo, 'app.txt'), 'line2\n');
  s.git('add', 'app.txt');
  s.git('commit', '-qm', 'change app.txt');
  const head = s.git('rev-parse', 'HEAD').trim();
  const eventFile = path.join(s.base, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7, base: { sha: base }, head: { sha: head } } }));
  return { base, head, eventFile, summary: path.join(s.base, 'summary.md'), output: path.join(s.base, 'output.txt') };
}

const VERDICT = 'answer:SUMMARY: SPEC: PASS · QUALITY: NEEDS_FIXES · ISSUES: critical=1 important=0 minor=0\\nCRITICAL:\\n- app.txt:2 breaks [see](http://example.com) @someone';

function step(s, prq, gh, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: s.repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...s.env,
      PWD: s.repo,
      GITHUB_EVENT_PATH: prq.eventFile,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_API_URL: gh.url,
      GITHUB_TOKEN: 'tok',
      GITHUB_STEP_SUMMARY: prq.summary,
      GITHUB_OUTPUT: prq.output,
      MOCK_ACTIONS: VERDICT,
      ...extra,
    },
  });
}

test('action: the pull request is reviewed; summary, outputs and one comment, updated on the next run; fail-on decides', async (t) => {
  const s = sandbox();
  const prq = pullRequest(s);
  const gh = await fakeGitHub(s.base);
  t.after(gh.stop);

  const r = step(s, prq, gh, { INPUT_WORKER: 'opencode:mock/reviewer' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const summary = fs.readFileSync(prq.summary, 'utf8');
  assert.match(summary, /^### Pitroom review: SPEC PASS · QUALITY NEEDS FIXES\n\*\*critical 1 · important 0 · minor 0\*\* · `[0-9a-f]{7}\.\.[0-9a-f]{7}` reviewed by opencode \(mock\/reviewer\) · run `\d{8}-\d{6}-[0-9a-f]{4}`/);
  // the worker's text sits in a code fence: no link, image or mention is rendered
  assert.match(summary, /```text\n[\s\S]*\[see\]\(http:\/\/example\.com\) @someone[\s\S]*\n```\n<\/details>/);
  const out = fs.readFileSync(prq.output, 'utf8');
  assert.match(out, /^run=\d{8}-\d{6}-[0-9a-f]{4}$/m);
  assert.match(out, /^spec=pass\nquality=needs-fixes\ncritical=1\nimportant=0\nminor=0$/m);
  assert.ok(s.calls().some((c) => c.argv[0] === 'run' && c.argv.includes('mock/reviewer')));

  const posted = gh.requests().filter((q) => q.method === 'POST');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].auth, 'Bearer tok');
  assert.match(posted[0].body.body, /^<!-- pitroom-review -->\n### Pitroom review: SPEC PASS/);

  const again = step(s, prq, gh, { INPUT_FAIL_ON: 'critical' });
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stdout, /::error::Pitroom review found 1 critical issue \(fail-on: critical\)/);
  assert.equal(gh.requests().filter((q) => q.method === 'POST').length, 1, 'the comment is updated, not posted again');
  assert.equal(gh.requests().filter((q) => q.method === 'PATCH').length, 1);
});

test('action: a review that cannot finish warns (fail-on never) or fails; no range at all is an error', async (t) => {
  const s = sandbox();
  const prq = pullRequest(s);
  const gh = await fakeGitHub(s.base);
  t.after(gh.stop);
  const broken = { MOCK_FAIL_MODELS: 'mock/gone', INPUT_WORKER: 'opencode:mock/gone' };
  const warned = step(s, prq, gh, broken);
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stdout, /::warning::Pitroom review could not finish on opencode \(mock\/gone\)/);
  assert.match(fs.readFileSync(prq.summary, 'utf8'), /^### Pitroom review could not finish\n`[0-9a-f]{7}\.\.[0-9a-f]{7}` on opencode \(mock\/gone\): .*Model not found/m);
  const failed = step(s, prq, gh, { ...broken, INPUT_FAIL_ON: 'important' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /::error::Pitroom review could not finish/);

  const lost = step(s, prq, gh, { GITHUB_EVENT_PATH: path.join(s.base, 'none.json') });
  assert.equal(lost.status, 1);
  assert.match(lost.stdout, /::error::Pitroom review: nothing to review/);
  const bad = step(s, prq, gh, { INPUT_FAIL_ON: 'sometimes' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /"fail-on" is critical, important or never, not "sometimes"/);
});

test('action: action.yml runs the script with every input mapped', () => {
  const yml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
  for (const input of ['worker', 'range', 'fail-on', 'comment', 'github-token', 'node-version']) assert.match(yml, new RegExp(`^  ${input}:\\n`, 'm'));
  for (const v of ['INPUT_WORKER', 'INPUT_RANGE', 'INPUT_FAIL_ON', 'INPUT_COMMENT', 'GITHUB_TOKEN']) assert.match(yml, new RegExp(`^ {8}${v}: \\$\\{\\{ inputs\\.`, 'm'));
  assert.match(yml, /run: node "\$GITHUB_ACTION_PATH\/scripts\/github-review\.mjs"/);
});
