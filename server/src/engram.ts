// Thin, defensive REST client for Weaviate Engram (no official JS SDK yet).
// Everything here is best-effort: a failed call logs to stderr and returns null/[] so the
// local trail engine keeps working. The exact request/response shapes are guarded because
// the REST reference is behind the console — adjust field names here if they differ.
//
// Design: we feed Engram RAW signal and let ITS pipeline do the memory work — extraction,
// bounded reconciliation, and cross-trail interest derivation. Engram authors the memory; SQLite is
// only the raw log. (Previously we pushed a pre-baked local summary, which reduced Engram to a
// vector-search box — reconciliation had nothing to reconcile.)

import { ENGRAM_API_KEY, ENGRAM_BASE, ENGRAM_ENABLED, ENGRAM_TIMEOUT_MS, TRAIL_TOPIC, INTEREST_TOPIC, DEBUG } from './config.js';

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
  interestKey: string | null;
  topic: string | null;
  score: number | null;
  updatedAt: string | null;
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
    interestKey: m?.properties?.interest_key ?? m?.interest_key ?? null,
    topic: m?.topic ?? null,
    score: typeof m?.score === 'number' ? m.score : null,
    updatedAt: m?.updated_at ?? m?.updatedAt ?? null,
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
    .filter((h) => h.trailId === trailId && !h.interestKey && (!h.topic || h.topic === TRAIL_TOPIC))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = scoped[0];
  if (DEBUG) {
    console.error(`[engram] trailMemory("${hint}") id=${trailId}: ${hits.length} hit(s), ${scoped.length} id-scoped -> ${best ? 'using own memory' : 'none yet (local recap)'}`);
  }
  const content = best?.content?.trim();
  return content && content.length > 24 ? content : null;
}

/**
 * Assert a *qualifying* research interest to Engram, scoped by a stable `interest_key` so Engram
 * maintains one bounded, evolving memory per interest and reconciles/merges each assertion into it.
 * Only durable themes (gated locally) are ever asserted — Engram is fed signal, never the firehose.
 */
// Circuit breaker: once we learn the interest topic/scope isn't configured in this Engram project,
// stop asserting for the rest of the process. It's a permanent config gap, not a transient error —
// retrying would just spam the endpoint (4x per checkpoint) with the same 400.
let interestScopeUnavailable = false;

export async function engramAssertInterest(
  userId: string,
  key: string,
  contents: string[],
): Promise<string | null> {
  if (interestScopeUnavailable) return null;
  const content = contents.map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!content.length) return null;
  const res = await post('/memories', {
    user_id: userId,
    properties: { interest_key: key },
    input: { string: { content } },
  });
  if (!res.ok) {
    // A 400 naming interest_key means the ResearchInterest topic (scope: interest_key) doesn't
    // exist in this project. Disable interest sync for the session and say so once — trails and
    // search are unaffected, so this is a soft degradation, not a failure.
    if (res.status === 400 && /interest_key|not configured/i.test(res.errorText)) {
      interestScopeUnavailable = true;
      console.error(
        '[engram] interest sync disabled for this session: the ResearchInterest topic ' +
        '(scope: interest_key) is not configured in your Engram project. Add it (see docs/engram.md) ' +
        'to enable cross-trail interests. Trails, recaps, and search are unaffected.',
      );
    }
    return null;
  }
  return res.json?.run_id ?? res.json?.runId ?? res.json?.id ?? null;
}

export interface Interest { key: string | null; content: string; score: number | null }

/**
 * Read back the interests Engram has synthesized (keyed by `interest_key`, or on the configured
 * ResearchInterest topic). Callers match these to their locally-gated themes to prefer Engram's
 * phrasing; the local gate — not this read — is what decides which themes count.
 */
export async function engramInterests(
  userId: string,
  query = 'the user\'s main ongoing interests, themes, and projects',
): Promise<Interest[]> {
  if (!ENGRAM_ENABLED) return [];
  const hits = await engramSearch(userId, query);
  const seen = new Set<string>();
  const out: Interest[] = [];
  for (const h of hits) {
    const key = h.interestKey;
    // interest-layer memories: an explicit interest assertion, the configured topic, or a user-scoped
    // memory that isn't a trail summary.
    const isInterest = !!key || (INTEREST_TOPIC && h.topic === INTEREST_TOPIC) || (!h.trailId && h.topic !== TRAIL_TOPIC);
    const c = h.content?.trim();
    if (!isInterest || !c || seen.has(c)) continue;
    seen.add(c);
    out.push({ key, content: c, score: h.score });
  }
  return out.slice(0, 12);
}
