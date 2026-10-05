// The dashboard's two actions, stop and discard: only with the secret the page was served with and from its own origin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const send = (url, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withDash(s, fn) {
  const start = s.run(['dash', '--detach', '--port', '0']);
  assert.equal(start.status, 0, start.stderr);
  const url = start.stdout.trim();
  try {
    const page = await send(url);
    const token = /<meta name="pitroom-token" content="([0-9a-f]+)">/.exec(page.body)?.[1];
    assert.ok(token, 'the page carries the secret');
    const origin = `http://${new URL(url).host}`;
    const post = (route, headers = { 'x-pitroom-token': token, origin }) => send(`${url}${route}`, { method: 'POST', headers });
    await fn({ url, token, origin, post });
  } finally {
    s.run(['dash', '--stop']);
  }
}

test('dash actions: stop needs the secret and the dash\'s own origin, then stops the run', async () => {
  const s = sandbox();
  const bg = s.run(['run', '--bg', 'slow one'], { MOCK_ACTIONS: 'sleep:30;answer:SUMMARY: late' });
  const id = /run (\S+) in background/.exec(bg.stdout)[1];
  await withDash(s, async ({ url, token, origin, post }) => {
    assert.equal((await post(`api/run/${id}/stop`, {})).status, 403, 'no secret');
    assert.equal((await post(`api/run/${id}/stop`, { 'x-pitroom-token': 'x'.repeat(token.length), origin })).status, 403, 'wrong secret');
    assert.equal((await post(`api/run/${id}/stop`, { 'x-pitroom-token': token })).status, 403, 'no origin');
    assert.equal((await post(`api/run/${id}/stop`, { 'x-pitroom-token': token, origin: 'http://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await post(`api/run/${id}/other`)).status, 404, 'only stop and discard');
    assert.equal((await post('api/run/not-a-run/stop')).status, 404);

    const ok = await post(`api/run/${id}/stop`);
    assert.equal(ok.status, 200, ok.body);
    let state = '';
    for (let i = 0; i < 50 && state !== 'stopped'; i++) {
      state = JSON.parse((await send(`${url}api/run/${id}`)).body).state;
      if (state !== 'stopped') await sleep(100);
    }
    assert.equal(state, 'stopped', 'the run was stopped, not reported as a crash');
    assert.equal((await post(`api/run/${id}/stop`)).status, 409, 'a finished run cannot be stopped');
  });
});

test('dash actions: discard only throws away a finished, unapplied isolate copy', async () => {
  const s = sandbox();
  const read = s.run(['run', 'just look']);
  const readId = RUN_ID.exec(read.stdout)[0];
  const iso = s.run(['run', '-i', 'change a file'], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: ok' });
  assert.equal(iso.status, 0, iso.stderr);
  const isoId = RUN_ID.exec(iso.stdout)[0];
  await withDash(s, async ({ url, post }) => {
    assert.equal((await post(`api/run/${readId}/discard`)).status, 409, 'a read run has no copy');
    const card = JSON.parse((await send(`${url}api/run/${isoId}`)).body).card;
    assert.equal(card.discardable, true, 'the page is told the copy can be discarded');
    const ok = await post(`api/run/${isoId}/discard`);
    assert.equal(ok.status, 200, ok.body);
    assert.match(JSON.parse(ok.body).message, /discarded the isolated copy/);
    assert.equal(JSON.parse((await send(`${url}api/run/${isoId}`)).body).card.discardable, undefined);
    assert.equal((await post(`api/run/${isoId}/discard`)).status, 409, 'already discarded');
  });
  assert.ok(fs.existsSync(path.join(s.env.PITROOM_HOME, 'runs', isoId, 'changes.patch')), 'the patch stays');
});
