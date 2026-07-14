// Thin, defensive REST client for Weaviate Engram (no official JS SDK yet).
// Everything here is best-effort: a failed call logs to stderr and returns null/[] so the
// local trail engine keeps working. The exact request/response shapes are guarded because
// the REST reference is behind the console — adjust field names here if they differ.

import { ENGRAM_API_KEY, ENGRAM_BASE, ENGRAM_ENABLED } from './config.js';

async function post(path: string, body: unknown): Promise<any | null> {
  if (!ENGRAM_ENABLED) return null;
  try {
    const r = await fetch(`${ENGRAM_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ENGRAM_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!r.ok) {
      console.error(`[engram] POST ${path} -> ${r.status} ${text.slice(0, 240)}`);
      return null;
    }
    return json;
  } catch (e) {
    console.error('[engram] request failed:', (e as Error).message);
    return null;
  }
}

/**
 * Upsert a trail's evolving memory. Because TrailSummary is property-scoped on `trail_id`
 * and bounded, Engram maintains exactly one memory per trail and rewrites/merges on each add.
 */
export async function engramUpsertTrail(
  userId: string,
  trailId: string,
  content: string,
): Promise<string | null> {
  // Verified schema: input is a discriminated object; `string.content` is an array of strings.
  // No `topic` field — routing to the TrailSummary topic happens via the trail_id scope property.
  const res = await post('/memories', {
    user_id: userId,
    properties: { trail_id: trailId },
    input: { string: { content: [content] } },
  });
  return res?.run_id ?? res?.runId ?? res?.id ?? null;
}

export interface EngramHit {
  content: string;
  trailId: string | null;
  score: number | null;
}

/** Semantic necromancy: find the trail memory that best matches a natural-language query. */
export async function engramSearch(userId: string, query: string, _limit = 5): Promise<EngramHit[]> {
  // Verified: search takes { user_id, query } (no `limit`); returns { memories: [...] }.
  const res = await post('/memories/search', { query, user_id: userId });
  const items = res?.memories ?? res?.results ?? res?.data ?? [];
  if (!Array.isArray(items)) return [];
  return items.map((m: any) => ({
    content: m?.content ?? m?.text ?? '',
    trailId: m?.properties?.trail_id ?? m?.trail_id ?? null,
    score: typeof m?.score === 'number' ? m.score : null,
  }));
}
