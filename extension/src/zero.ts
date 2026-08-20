import { brandMark } from './icons.js';

/**
 * The line under "Tab Zero".
 *
 * Exported and pure so extension/test can cover it — and because the wording is the bug. It used to
 * read "36 tabs closed. Saved as 20 research trails", which states a conversion that never happened:
 * the count comes from /health and is how many trails you HAVE, not what those tabs became. With 7 of
 * 20 trails archived, the screen also disagreed with the 13 rows the popup listed right after it. The
 * count is now the same one the popup lists (countListedTrails), and the sentence no longer claims the
 * tabs turned into it.
 */
export function zeroMessage(closed: number, trails: number): string {
  const tabs = closed > 0 ? `<b>${closed}</b> tab${closed === 1 ? '' : 's'} closed. ` : '';
  // Zero listed trails is the normal state on day one — every trail needs a second page to graduate —
  // so it gets its own wording rather than boasting "0 research trails".
  const rest =
    trails > 0
      ? `Nothing lost, <b>${trails}</b> research trail${trails === 1 ? '' : 's'} ready to resurrect.`
      : 'Nothing lost, your trails are still forming.';
  return tabs + rest;
}

// Entry-point side effects, guarded so importing this module in a test doesn't need a DOM.
if (typeof document !== 'undefined') {
  const mark = document.getElementById('mark');
  if (mark) mark.innerHTML = brandMark(52);

  const params = new URLSearchParams(location.search);
  const sub = document.getElementById('sub');
  if (sub) {
    sub.innerHTML = zeroMessage(Number(params.get('closed') || 0), Number(params.get('trails') || 0));
  }
}
