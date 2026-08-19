// Fitting long text into a fixed number of lines with an inline "more" toggle.
//
// Split into its own module because it is pure: no DOM, no chrome.*, no side effects on import. That is
// what makes it testable — importing popup.ts to reach these would run init(), which probes layout and
// hits the network.
//
// Why measurement rather than a character budget: Engram returns interests up to ~600 characters, and a
// fixed character count is not a line count. 165 characters rendered as FOUR lines at the popup's width.
// The caller supplies a `fits` predicate that does the real measuring; everything here is the search.

/** Trim a prefix at a word boundary, leaving no trailing space or dangling punctuation before an ellipsis. */
export function trimAt(text: string, n: number): string {
  if (n >= text.length) return text;
  const hard = text.slice(0, n);
  const cut = hard.lastIndexOf(' ');
  // Only honour the word boundary if it isn't throwing away most of the budget — otherwise a single very
  // long word would collapse the result to almost nothing.
  return (cut > n * 0.6 ? hard.slice(0, cut) : hard).replace(/[\s,;:.–—-]+$/, '');
}

/**
 * The longest word-boundary prefix of `text` for which `fits` is true.
 *
 * `fits` is assumed monotonic — if a prefix fits, every shorter prefix fits too — which holds for
 * rendered text height. Binary search rather than a linear walk because each probe costs a forced layout.
 *
 * The whole-string check up front is an optimization, not a guard: without it the search still converges
 * on the full text (trimAt(text, text.length) === text), it just spends ~10 needless layout probes doing
 * so. On the real path fitInterestLabels has already established that the full text does NOT fit before
 * calling here, so this only fires for direct callers.
 */
export function longestFitting(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(trimAt(text, mid))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return trimAt(text, best);
}
