// A stand-in for models.dev, in a process of its own: the tests run the CLI with spawnSync, which blocks the test process, so a
// server inside it could not answer. Prints its port. /__hits counts the requests for the catalog, /__mode/<ok|error|small> sets the answer.
import http from 'node:http';
import { catalog } from './catalog.mjs';

let hits = 0;
let mode = 'ok';
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/__hits') return void res.end(String(hits));
  if (path.startsWith('/__mode/')) {
    mode = path.slice('/__mode/'.length);
    return void res.end('ok');
  }
  hits++;
  if (mode === 'error') return void res.writeHead(500).end('no');
  const body = mode === 'small' ? { a: { models: { x: { cost: { input: 1, output: 1 } } } } } : catalog();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
