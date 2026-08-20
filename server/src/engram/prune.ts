// Deciding which Engram memories are orphans — memories whose trail no longer exists locally.
//
// Pure and separate from the script that performs the deletion, because the interesting part is not the
// deleting, it is the REFUSING. Engram has no enumeration endpoint, so orphans are discovered by probing
// search and comparing each hit's trail_id against the local database — which means "not in the local
// database" is doing all the work, and there are two ways for that comparison to be catastrophically
// wrong rather than merely incomplete:
//
//   1. The local database is empty or brand new. Then EVERY memory looks orphaned and a sweep deletes
//      the entire project. This is not hypothetical: a wiped data dir, a pinned TABZERO_USER_ID pointed
//      at a fresh DB, or simply running from a directory that resolves to a different data dir all
//      produce exactly this state, and the last one was a live bug in this codebase.
//   2. The local database is a DIFFERENT user's — or a different install's — while the Engram scope is
//      still the old one. Same outcome by a different route.
//
// Neither can be distinguished from "this project has a lot of orphans" by looking at the data, so the
// answer is to refuse and make the human confirm, rather than to guess well.

export interface FoundMemory {
  id: string;
  trailId: string;
  content: string;
}

export type PrunePlan =
  | { ok: false; refusal: string }
  | { ok: true; orphans: FoundMemory[]; keeping: number };

export function planEngramPrune(o: {
  found: FoundMemory[];
  localTrailIds: Set<string>;
  force: boolean;
}): PrunePlan {
  const { found, localTrailIds, force } = o;

  if (localTrailIds.size === 0) {
    return {
      ok: false,
      refusal:
        'the local database has no trails, so every memory would look like an orphan. That is what a ' +
        'wiped or mis-located data dir looks like — not a project that needs pruning. Check `tabzero ' +
        'path` points where you expect before pruning anything.',
    };
  }

  const seen = new Map<string, FoundMemory>();
  for (const m of found) if (m.id && m.trailId) seen.set(m.id, m);
  const orphans = [...seen.values()].filter((m) => !localTrailIds.has(m.trailId));
  const keeping = seen.size - orphans.length;

  // More orphans than live trails is possible honestly — someone deleted a lot — but it is also the
  // signature of comparing against the wrong database, so it needs a human to say yes.
  if (orphans.length > localTrailIds.size && !force) {
    return {
      ok: false,
      refusal:
        `${orphans.length} orphaned memories against only ${localTrailIds.size} local trails. That ratio ` +
        'usually means the comparison is against the wrong database rather than that the project is ' +
        'full of orphans. Re-run with --force if the numbers are genuinely right.',
    };
  }

  return { ok: true, orphans, keeping };
}
