// Turning what a human (or an agent) typed into one specific trail.
//
// `tabzero resurrect <ref>` and `tabzero trail <ref>` both take either an id or a description, and the
// consequence of getting it wrong is not a bad search result — resurrect reopens up to
// RESURRECT_MAX_TABS tabs from whatever it picked. So naming a trail should be exact and deterministic,
// and only a genuine description should fall through to semantic matching.
//
// Pure, and in its own module, because cli.ts dispatches on argv at the top level: importing it from a
// test runs the setup wizard.

export interface TrailRef {
  id: string;
  label: string;
}

export type LabelPick =
  | { kind: 'none' }
  | { kind: 'one'; ref: TrailRef; how: 'exact' | 'substring' }
  | { kind: 'ambiguous'; matches: TrailRef[] };

/**
 * Is this an id rather than a description?
 *
 * Anchored on digits, not just the prefix. The check used to be `/^t_/`, which meant
 * `tabzero resurrect "t_shirt sizing"` was taken as an id and 404'd instead of being searched.
 */
export function looksLikeId(q: string): boolean {
  return /^t_\d+$/.test(q.trim());
}

/**
 * Match a description against trail labels, before any semantic search.
 *
 * Exact wins outright. A substring only wins if it identifies exactly ONE trail — `resurrect lisbon`
 * should work, but a word appearing in four labels is not a reference to any of them, so it falls
 * through to semantic matching rather than guessing. Several exact matches are ambiguous and reported:
 * picking one silently would resurrect the wrong tabs.
 */
export function pickByLabel(trails: TrailRef[], q: string): LabelPick {
  const norm = q.trim().toLowerCase();
  if (!norm) return { kind: 'none' };
  const label = (t: TrailRef) => (t.label || '').trim().toLowerCase();

  const exact = trails.filter((t) => label(t) === norm);
  if (exact.length === 1) return { kind: 'one', ref: exact[0], how: 'exact' };
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact };

  const partial = trails.filter((t) => label(t).includes(norm));
  if (partial.length === 1) return { kind: 'one', ref: partial[0], how: 'substring' };
  return { kind: 'none' };
}
