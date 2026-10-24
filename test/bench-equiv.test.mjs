// The review benchmark's equivalent packages (benchmarks/review-bugs/equiv.mjs) must not change what the code does:
// a finding on them is counted as a false alarm. The mirror is only made where it is the same expression.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';

const { comparisons, rewrite } = await import(pathToFileURL(path.join(root, 'benchmarks', 'review-bugs', 'equiv.mjs')).href);
const mirrored = (line, lang) => comparisons(line, lang).map((c) => rewrite(line, c));

test('bench equiv: a comparison is mirrored where the swap is the same expression', () => {
  assert.deepEqual(mirrored('  if (i < n && j > k) {', 'js'), ['  if (n > i && j > k) {', '  if (i < n && k < j) {']);
  assert.deepEqual(mirrored('  return a.b !== c;', 'ts'), ['  return c !== a.b;']);
  assert.deepEqual(mirrored('  if (0 < a) {', 'js'), ['  if (a > 0) {'], 'a literal may move right');
  assert.deepEqual(mirrored('    if self.count >= limit:', 'py'), ['    if limit <= self.count:']);
  assert.deepEqual(mirrored('\tfor i := 0; i < n; i++ {', 'go'), ['\tfor i := 0; n > i; i++ {']);
  assert.deepEqual(mirrored('\tok := a == b', 'go'), ['\tok := b == a'], 'a Go line ends the expression');
});

test('bench equiv: never where the swap would change the expression, nor in comments, strings or Yoda form', () => {
  for (const [line, lang] of [
    ['  if (!a < b) {', 'js'], // the negation binds tighter
    ['  if (a < b + c) {', 'js'], // so does the addition
    ['  if (-a < b) {', 'js'],
    ['  if (typeof a === b) {', 'js'],
    ['  if (x < y < z) {', 'ts'],
    ['  x = a < b', 'js'], // the next line may go on with "+ c"
    ['    if a < b < c:', 'py'], // a chain
    ['    return not a == b', 'py'],
    ['    if a in b == c:', 'py'],
    ['\tif a < b+c {', 'go'],
    ['\tif len(x) > n {', 'go'], // a call is not a plain operand
    ['  // if (a < b) {', 'js'],
    ['  s = "(a < b)";', 'js'],
    ['  return x !== null;', 'js'], // would be `null !== x`
    ['\tif err != nil {', 'go'],
    ['    if x == "y":', 'py'],
    ['  if (a === a) {', 'js'],
  ]) assert.deepEqual(mirrored(line, lang), [], `${lang}: ${line}`);
});

test('bench equiv: every mirrored JS expression gives the same value as the original, for any values', () => {
  const values = [0, 1, -1, 2.5, NaN, Infinity, '', '1', 'a', 'b', null, undefined, true, false];
  const exprs = [
    'a < b && c', 'c || a === b', 'f(a, b >= c)', 'c ? a <= b : d', '(a.x !== b)', 'a > b || c > d', '[a < b, c]',
    'x = a !== b', 'c && a !== b', 'a.x >= b.x && c', 'a > 0 || b < c',
  ];
  // the expressions are this test's own, compiled to compare the two forms
  const compile = (line) => new Function('a', 'b', 'c', 'd', `let x; const f = (...v) => v; ${line.trim()}`);
  const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  let checked = 0;
  for (const e of exprs) {
    const line = `  return ${e};`;
    const outs = mirrored(line, 'js');
    assert.ok(outs.length, `${e} has a comparison to mirror`);
    for (const out of outs) {
      const before = compile(line), after = compile(out);
      for (const a of values) for (const b of values) for (const c of values.slice(0, 6)) {
        // `a.x` expressions get objects holding the values
        const args = e.includes('.x') ? [{ x: a }, { x: b }, c, c] : [a, b, c, c];
        assert.equal(show(after(...args)), show(before(...args)), `${e} -> ${out.trim()} with a=${String(a)} b=${String(b)} c=${String(c)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10_000, `${checked} checks`);
});
