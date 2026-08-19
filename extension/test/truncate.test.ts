// The collapsed-interest fit, tested without a browser.
//
// Engram returns interests up to ~600 characters and the popup must show exactly three lines with the
// toggle inline. A character budget could not do that — 165 chars rendered as FOUR lines at the popup's
// width — so the real code binary-searches the longest prefix whose rendered height still fits. The
// search is the part most likely to be quietly wrong (an off-by-one means a permanently over-truncated
// interest, or the fourth line coming back), so it is split out from the DOM and driven here with a
// synthetic layout: a fake `fits` that models "N characters per line, 3 lines".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { longestFitting, trimAt } from '../src/truncate.ts';

/** Models a 3-line box that holds `perLine` characters per line, plus the toggle's own width. */
const layout = (perLine: number, lines = 3, toggleCost = 9) =>
  (candidate: string) => candidate.length + toggleCost <= perLine * lines;

test('text that already fits is returned untouched — no toggle, no ellipsis', () => {
  const short = 'evaluating Opus 5 effort settings for coding tasks';
  assert.equal(longestFitting(short, () => true), short);
});

test('a long interest is cut to the largest prefix that still fits', () => {
  const long = 'Investigating debugging issues in LLM frameworks including LangChain streaming '
    + 'converters and Gemini function calls plus terminal management tasks for kitty on Hyprland and macOS';
  const fits = layout(48);
  const out = longestFitting(long, fits);
  assert.ok(fits(out), 'the result must actually fit');
  assert.ok(out.length > 0, 'it must not collapse to nothing');
  assert.ok(long.startsWith(out.slice(0, 40)), 'it must be a prefix of the original');
  // Maximal: adding the next word must break the fit. This is the assertion that catches an off-by-one
  // that silently over-truncates — the failure mode a human would never notice as a bug.
  const nextSpace = long.indexOf(' ', out.length + 1);
  const longer = long.slice(0, nextSpace === -1 ? long.length : nextSpace);
  assert.ok(!fits(longer), `not maximal — "${longer.slice(-20)}" would also have fit`);
});

test('the cut lands on a word boundary and leaves no dangling punctuation', () => {
  const long = 'alpha, beta; gamma. delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho';
  const out = longestFitting(long, layout(20));
  assert.ok(!/\s$/.test(out), `trailing whitespace: ${JSON.stringify(out)}`);
  assert.ok(!/[,;:.–—-]$/.test(out), `dangling punctuation before the ellipsis: ${JSON.stringify(out)}`);
  // The last word must be whole, not sliced mid-word.
  const lastWord = out.split(' ').pop()!;
  assert.ok(long.includes(lastWord + ' ') || long.endsWith(lastWord), `mid-word cut: ${JSON.stringify(lastWord)}`);
});

test('a single unbreakable word still yields something rather than hanging', () => {
  const wordy = 'x'.repeat(400);
  const out = longestFitting(wordy, layout(48));
  assert.ok(out.length > 0 && out.length < wordy.length, `got ${out.length} chars`);
});

test('the toggle competing for space is accounted for, not ignored', () => {
  // Same text, same box, but a wider toggle must produce a shorter body — otherwise the toggle would be
  // pushed onto a fourth line, which is the exact bug being fixed.
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
  const narrowToggle = longestFitting(long, layout(30, 3, 2));
  const wideToggle = longestFitting(long, layout(30, 3, 20));
  assert.ok(wideToggle.length < narrowToggle.length,
    `a wider toggle must shrink the body: ${wideToggle.length} vs ${narrowToggle.length}`);
});

// ---- trimAt directly ----
//
// Going through longestFitting only exercises whichever cut position the search happens to land on, so
// both of trimAt's guards survived mutation when tested that way. These hit them head-on.

test('a cut landing on punctuation does not leave it dangling before the ellipsis', () => {
  // Budget 12 puts the word boundary immediately after "beta;" — exactly the case that would render as
  // "alpha, beta;...more" without the trailing-punctuation strip.
  assert.equal(trimAt('alpha, beta; gamma delta', 12), 'alpha, beta');
  assert.equal(trimAt('one two, three four', 9), 'one two');
  assert.equal(trimAt('ends with a dash — more text', 19), 'ends with a dash');
  // A cut mid-word keeps the partial word (the long-word case) but still sheds punctuation.
  assert.equal(trimAt('supercalifragilistic. rest', 21), 'supercalifragilistic');
});

test('a long unbreakable word is sliced rather than collapsing to the first short word', () => {
  // "a " then a 400-char word: the only space is at index 1. Honouring that boundary blindly would
  // return "a" — throwing away the entire budget — so the guard requires the boundary to be reasonably
  // deep into the budget before it is used.
  const text = 'a ' + 'x'.repeat(400);
  const out = trimAt(text, 120);
  assert.ok(out.length > 100, `collapsed to ${out.length} chars ("${out.slice(0, 12)}") — the long-word guard is gone`);
  assert.ok(out.startsWith('a x'), 'still a prefix of the original');
});

test('a boundary deep enough into the budget IS honoured', () => {
  // The other side of the same guard: here the space sits well past 60% of the budget, so the word
  // boundary wins and no word is sliced.
  assert.equal(trimAt('alpha beta gamma delta', 17), 'alpha beta gamma');
});
