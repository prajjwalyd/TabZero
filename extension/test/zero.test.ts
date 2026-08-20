// The line under "Tab Zero" — the one piece of UI that makes a numeric claim.
//
// It read "36 tabs closed. Saved as 20 research trails. Nothing lost." while the popup listed 13. Two
// faults: the number came from /health (how many trails you HAVE, not what these tabs became) and
// /health did not filter archived trails. The count is fixed server-side; this covers the sentence,
// which must no longer describe the count as a conversion of the tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { zeroMessage } = await import('../src/zero.ts');

test('the sentence does not claim the closed tabs turned into the trail count', () => {
  const msg = zeroMessage(36, 13);
  assert.match(msg, /36<\/b> tabs closed/, 'it still reports what it actually did');
  assert.match(msg, /13<\/b> research trails/, 'and still shows the library size');
  assert.doesNotMatch(msg, /saved as/i, '"saved as N trails" is the false conversion claim');
});

test('day one says trails are forming rather than boasting zero', () => {
  const msg = zeroMessage(9, 0);
  assert.doesNotMatch(msg, /\b0\b/, 'never render a count of zero trails');
  assert.match(msg, /forming/i);
  assert.match(msg, /Nothing lost/);
});

test('singulars read as singular', () => {
  const msg = zeroMessage(1, 1);
  assert.match(msg, /1<\/b> tab closed/);
  assert.match(msg, /1<\/b> research trail\b/);
});

test('with nothing to close, only the reassurance remains', () => {
  const msg = zeroMessage(0, 4);
  assert.doesNotMatch(msg, /closed/);
  assert.match(msg, /4<\/b> research trails/);
});
