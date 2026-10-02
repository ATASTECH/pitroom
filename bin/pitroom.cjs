#!/usr/bin/env node
'use strict';
// The `pitroom` command. Plain ES5 so that even an old Node can run it: it finds a Node.js of 22.13 or newer
// and runs dist/pitroom.mjs with it. Agent apps often run commands in a shell whose first `node` is an old one
// (an installer's Node 14 in /usr/local/bin, say), where the real CLI would only crash with a syntax error.
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var MIN = [22, 13];
var cli = path.join(__dirname, '..', 'dist', 'pitroom.mjs');

function ok(v) {
  return v[0] > MIN[0] || (v[0] === MIN[0] && v[1] >= MIN[1]);
}
function parse(text) {
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionOf(bin) {
  var r = cp.spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? parse(r.stdout) : null;
}
function newer(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// PITROOM_TEST_NODE_VERSION only lets the tests pretend this Node is old.
var current = parse(process.env.PITROOM_TEST_NODE_VERSION || process.versions.node) || [0, 0, 0];
var node = process.execPath;

if (!ok(current)) {
  node = null;
  var candidates = [];
  if (process.env.PITROOM_NODE) candidates.push(process.env.PITROOM_NODE);
  // PITROOM_NODE_SEARCH (a path-delimited list) replaces the places searched below; the tests use it.
  var nvm = path.join(process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm'), 'versions', 'node');
  try {
    candidates = candidates.concat(
      fs.readdirSync(nvm).filter(function (d) { return /^v\d+\.\d+\.\d+$/.test(d); })
        .sort(function (a, b) { return newer(parse(b), parse(a)); })
        .map(function (d) { return path.join(nvm, d, 'bin', 'node'); }),
    );
  } catch (e) { /* no nvm */ }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  if (process.env.PITROOM_NODE_SEARCH !== undefined) candidates = process.env.PITROOM_NODE_SEARCH.split(path.delimiter).filter(Boolean);
  for (var i = 0; i < candidates.length && !node; i++) {
    if (!fs.existsSync(candidates[i])) continue;
    var v = versionOf(candidates[i]);
    if (v && ok(v)) node = candidates[i];
  }
  if (!node) {
    process.stderr.write(
      'pitroom needs Node.js ' + MIN.join('.') + ' or newer, but this shell runs Node.js v' + current.join('.') + ' (' + process.execPath + ').\n' +
      'Install a current one and make it the default, for example:  nvm install 24 && nvm alias default 24\n' +
      '(or put a newer node first on PATH, or set PITROOM_NODE=/path/to/node)\n',
    );
    process.exit(1);
  }
}

var r = cp.spawnSync(node, [cli].concat(process.argv.slice(2)), { stdio: 'inherit' });
if (r.error) {
  process.stderr.write('pitroom: could not run ' + node + ': ' + r.error.message + '\n');
  process.exit(1);
}
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status === null ? 1 : r.status);
