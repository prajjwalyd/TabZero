// Thin, defensive REST client for Weaviate Engram (no official JS SDK yet).
// Everything here is best-effort: a failed call logs to stderr and returns null/[] so the
// local trail engine keeps working. The exact request/response shapes are guarded because
// the REST reference is behind the console — adjust field names here if they differ.
//
// Design: we feed Engram RAW signal and let ITS pipeline do the memory work — extraction,
// bounded reconciliation, and cross-trail interest derivation. Engram authors the memory; SQLite is
// only the raw log. (Previously we pushed a pre-baked local summary, which reduced Engram to a
// vector-search box — reconciliation had nothing to reconcile.)

import { ENGRAM_API_KEY, ENGRAM_BASE, ENGRAM_ENABLED, ENGRAM_TIMEOUT_MS, TRAIL_TOPIC, INTEREST_TOPIC, DEBUG } from '../core/config.js';

interface PostResult {
  ok: boolean;
  status: number; // HTTP status, or 0 if the request never completed (timeout / network)
  json: any | null;
  errorText: string; // raw error body / message on failure, '' on success
}

async function post(path: string, body: unknown): Promise<PostResult> {
  const miss = (errorText = ''): PostResult => ({ ok: false, status: 0, json: null, errorText });
  if (!ENGRAM_ENABLED) return miss();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENGRAM_TIMEOUT_MS);
  try {
    const r = await fetch(`${ENGRAM_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ENGRAM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!r.ok) {
      console.error(`[engram] POST ${path} -> ${r.status} ${text.slice(0, 240)}`);
      return { ok: false, status: r.status, json, errorText: text };
    }
    return { ok: true, status: r.status, json, errorText: '' };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `timed out after ${ENGRAM_TIMEOUT_MS}ms` : (e as Error).message;
    console.error(`[engram] POST ${path} failed: ${msg}`);
    return miss(msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Feed a trail's RAW signal to Engram and let its pipeline extract + reconcile the memory. We send
 * the label plus one atomic fact per page (NOT a finished summary), as an array of content strings,
 * so Engram's extraction does the real work and its bounded, `trail_id`-scoped TrailSummary is
 * rewritten/merged on every add — the memory evolves as the trail grows instead of us overwriting a
 * blob. Because the same input can also populate a user-scoped ResearchInterest topic, one push
 * feeds both the per-trail memory and the cross-trail interest layer.
 */
export async function engramUpsertTrail(
  userId: string,
  trailId: string,
  contents: string[],
): Promise<string | null> {
  // Verified schema: input is a discriminated object; `string.content` is an array of strings.
  // No `topic` field — routing happens via the trail_id scope property (+ any user-scoped topics).
  const content = contents.map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (!content.length) return null;
  const res = await post('/memories', {
    user_id: userId,
    properties: { trail_id: trailId },
    input: { string: { content } },
  });
  if (!res.ok) return null;
  return res.json?.run_id ?? res.json?.runId ?? res.json?.id ?? null;
}

export interface EngramHit {
  content: string;
  trailId: string | null;
  topic: string | null;
  score: number | null;
  /** When Engram last REWROTE this memory, in ms. Meaningful because both topics are bounded: a memory
   *  is revised in place as the trail or interest evolves, so this is "when my understanding last
   *  changed", not "when this row was created". */
  updatedAt: number | null;
}

/** ISO-8601 -> ms. Defensive like the rest of this client: an unparseable or absent stamp is null, not NaN. */
function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Raw semantic search over the user's Engram memories. Returns hits with topic + scope properties. */
export async function engramSearch(userId: string, query: string): Promise<EngramHit[]> {
  // Verified: search takes { user_id, query } (no `limit`); returns { memories: [...] }.
  const res = await post('/memories/search', { query, user_id: userId });
  const items = res.json?.memories ?? res.json?.results ?? res.json?.data ?? [];
  if (!Array.isArray(items)) return [];
  return items.map((m: any) => ({
    content: m?.content ?? m?.text ?? '',
    trailId: m?.properties?.trail_id ?? m?.trail_id ?? null,
    topic: m?.topic ?? null,
    score: typeof m?.score === 'number' ? m.score : null,
    updatedAt: parseTs(m?.updated_at ?? m?.updatedAt ?? m?.created_at ?? m?.createdAt),
  }));
}

/**
 * Engram's current reconciled memory for one trail — the recap it authored from the raw signal,
 * evolved across sessions. Null when Engram is off or the extraction hasn't landed yet (async
 * pipeline), so callers fall back to a local recap until it does.
 */
export async function engramTrailMemory(userId: string, trailId: string, hint: string): Promise<string | null> {
  if (!ENGRAM_ENABLED) return null;
  const hits = await engramSearch(userId, hint || 'summary');
  // Only trust a memory scoped to THIS trail. We deliberately do NOT fall back to another trail's
  // memory when this one has no hit yet: Engram's extraction is async, so a freshly-pushed trail
  // simply has no memory for a beat — the caller keeps its local placeholder and upgrades on the
  // next read once extraction lands. Borrowing the best label match instead cross-contaminates
  // (one trail showing another's recap), which is worse than a short wait for the real one.
  const scoped = hits
    .filter((h) => h.trailId === trailId && (!h.topic || h.topic === TRAIL_TOPIC))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = scoped[0];
  if (DEBUG) {
    console.error(`[engram] trailMemory("${hint}") id=${trailId}: ${hits.length} hit(s), ${scoped.length} id-scoped -> ${best ? 'using own memory' : 'none yet (local recap)'}`);
  }
  const content = best?.content?.trim();
  return content && content.length > 24 ? content : null;
}

export interface Interest { content: string; score: number | null; updatedAt: number | null }

/**
 * The interests Engram has synthesized on the ResearchInterest topic. Its own topic description
 * applies the durability rule and merges near-duplicates, so these are returned as-is — the caller
 * does not re-gate them. Memories carry no scope property (the topic is user-scoped), which is why
 * nothing here filters on one; requiring a property was what made this whole layer read as "local".
 */
/**
 * Retrieval probes, run together and unioned.
 *
 * There is no "list memories by topic" in the verified REST surface — the only way in is semantic
 * search, which is RANKED. So a single query returns whichever interests are nearest that one phrasing
 * and silently hides the rest: on a real account holding five ResearchInterest memories, the original
 * single-query version returned two. Interests looked like they were barely forming when in fact they
 * were barely being read.
 *
 * These deliberately approach from different angles — the standing summary, active decisions, active
 * building, and recurrence — because that spread is what makes the union approximate "all of them".
 * `/memories/search` is a free read (only `/memories` costs a pipeline run), so the extra probes cost
 * nothing against the free-tier budget, and they run in parallel so they cost no extra latency either.
 */
const INTEREST_PROBES = [
  'the user\'s main ongoing interests, themes, and projects',
  'what the user is currently evaluating, comparing, or deciding between',
  'what the user is learning, building, or investigating',
  'recurring topics and themes the user returns to across many sessions',
];

export async function engramInterests(
  userId: string,
  probes: string[] = INTEREST_PROBES,
): Promise<Interest[]> {
  if (!ENGRAM_ENABLED) return [];
  const results = await Promise.all(probes.map((q) => engramSearch(userId, q)));

  const seen = new Set<string>();
  const out: Interest[] = [];
  for (const h of results.flat()) {
    // The configured interest topic, or — if it was renamed without setting TABZERO_INTEREST_TOPIC —
    // any user-scoped memory that isn't a trail summary.
    const isInterest = h.topic === INTEREST_TOPIC || (!h.trailId && h.topic !== TRAIL_TOPIC);
    const c = h.content?.trim();
    if (!isInterest || !c || seen.has(c)) continue;
    seen.add(c);
    out.push({ content: c, score: h.score, updatedAt: h.updatedAt });
  }
  // Best-scoring first, so the cap below drops the weakest rather than whichever probe happened to
  // return last. Unscored hits sort last rather than winning by accident.
  out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (DEBUG) console.error(`[engram] interests: ${probes.length} probes -> ${out.length} distinct`);
  return out.slice(0, 12);
}
