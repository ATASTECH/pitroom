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

test('dash actions: a crew is stopped or discarded as a whole, with the same secret and origin', async () => {
  const s = sandbox();
  const crew = s.run(['crew', '-g', 'my crew', 'slow one', 'slow two'], { MOCK_ACTIONS: 'sleep:30;answer:SUMMARY: late' });
  assert.equal(crew.status, 0, crew.stderr);
  const iso = ['first', 'second'].map((t) => s.run(['run', '-i', '-g', 'isos', `change ${t}`], { MOCK_ACTIONS: 'append:app.txt:x;answer:SUMMARY: ok' }));
  for (const r of iso) assert.equal(r.status, 0, r.stderr);
  await withDash(s, async ({ url, token, post }) => {
    const group = encodeURIComponent('my crew');
    assert.equal((await post(`api/group/${group}/stop`, { 'x-pitroom-token': token })).status, 403, 'no origin');
    assert.equal((await post('api/group/nobody/stop')).status, 404, 'no such group');
    assert.equal((await post(`api/group/${group}/other`)).status, 404, 'only stop and discard');
    const ok = await post(`api/group/${group}/stop`);
    assert.equal(ok.status, 200, ok.body);
    assert.match(JSON.parse(ok.body).message, /stopping 2 runs of my crew/);
    const ids = crew.stdout.match(new RegExp(RUN_ID.source, 'g'));
    let states = [];
    for (let i = 0; i < 80 && !(states.length && states.every((x) => x === 'stopped')); i++) {
      states = await Promise.all(ids.map(async (id) => JSON.parse((await send(`${url}api/run/${id}`)).body).state));
      if (!states.every((x) => x === 'stopped')) await sleep(100);
    }
    assert.deepEqual(states, ['stopped', 'stopped']);
    // a stopped run still writes its record as it exits: let both go before the test directory is removed
    const pids = ids.map((id) => JSON.parse(fs.readFileSync(path.join(s.base, 'home', 'runs', id, 'meta.json'), 'utf8')).pid).filter(Boolean);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; pids.some(alive) && i < 150; i++) await sleep(100);
    assert.equal((await post(`api/group/${group}/stop`)).status, 409, 'nothing left to stop');

    const discard = await post('api/group/isos/discard');
    assert.equal(discard.status, 200, discard.body);
    assert.match(JSON.parse(discard.body).message, /discarded the isolated copies of 2 runs of isos/);
    assert.equal((await post('api/group/isos/discard')).status, 409, 'already discarded');

    // the failed runs come back as commands to run, never started by the page
    const retry = JSON.parse((await send(`${url}api/group/${group}/retry`)).body);
    assert.equal(retry.commands.length, 2);
    // PowerShell on Windows (no "--", which Windows PowerShell 5.1 would drop), a POSIX shell elsewhere
    assert.equal(retry.shell, process.platform === 'win32' ? 'powershell' : 'sh');
    for (const c of retry.commands) assert.match(c, /^pitroom run -d \S+ -g 'my crew' --bg (-- )?'slow (one|two)'$/);
    assert.equal((await send(`${url}api/group/nobody/retry`)).status, 404);
  });
});
