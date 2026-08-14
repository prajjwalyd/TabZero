import { db, getUserId } from '../core/db.js';
import { getTrail, trailPages, labelTrail, summarizeTrail } from '../trails/trails.js';
import { engramUpsertTrail } from './client.js';
import * as cfg from '../core/config.js';
import type { PageDTO } from '../core/types.js';

// The RAW signal we hand Engram: the label plus one atomic fact per page. NOT a finished summary —
// Engram's own pipeline extracts and reconciles the memory from these, so it evolves as the trail
// grows rather than us overwriting a pre-baked blob.
function buildSignal(label: string, pages: PageDTO[]): string[] {
  const facts = pages
    .slice(-25)
    .map((p) => `${p.title}${p.description ? ' — ' + p.description.slice(0, 200) : ''} (${p.domain})`);
  return [`Research trail: ${label}`, ...facts];
}

/** Count of trails with pending enrichment work, ignoring the settle gate (used to drive idle backoff). */
function pendingEnrich(): number {
  return (db.prepare(
    'SELECT COUNT(*) c FROM trails WHERE (label_dirty = 1 OR summary_dirty = 1) AND page_count >= ?',
  ).get(cfg.MIN_TRAIL_PAGES) as { c: number }).c;
}

/**
 * One merged enrichment pass over trails that have *settled* (gone quiet for TRAIL_SETTLE_MS).
 * Labels up to `labelLimit` trails and pre-warms up to `recapLimit` recap summaries — folding the
 * old two-loop design into one wake. `pending` (settle-agnostic) lets the scheduler tell "nothing
 * to do" (back off) apart from "work exists but is still settling" (stay at base cadence).
 */
export async function enrichSettled(
  labelLimit = 3,
  recapLimit = 1,
): Promise<{ processed: number; pending: number }> {
  const settledBefore = Date.now() - cfg.TRAIL_SETTLE_MS;

  const labelRows = db.prepare(
    `SELECT id FROM trails
       WHERE label_dirty = 1 AND page_count >= ? AND last_active <= ?
       ORDER BY last_active DESC LIMIT ?`,
  ).all(cfg.MIN_TRAIL_PAGES, settledBefore, labelLimit) as { id: string }[];
  for (const { id } of labelRows) await labelTrail(id);

  const recapRows = db.prepare(
    `SELECT id FROM trails
       WHERE summary_dirty = 1 AND page_count >= ? AND last_active <= ?
       ORDER BY last_active DESC LIMIT ?`,
  ).all(cfg.MIN_TRAIL_PAGES, settledBefore, recapLimit) as { id: string }[];
  for (const { id } of recapRows) await summarizeTrail(id, { force: true });

  return { processed: labelRows.length + recapRows.length, pending: pendingEnrich() };
}

/**
 * Push trails whose memory is stale up to Engram (bounded TrailSummary rewrites the one memory).
 * Background calls are gated twice — the trail must have settled *and* not been pushed within
 * ENGRAM_MIN_REPUSH_MS — so a burst of browsing costs at most one pipeline run per trail. An
 * explicit `force` (the "tab zero" checkpoint) bypasses both gates: the user just declared these
 * trails done, so it's the right moment to spend the budget.
 */
export async function flushEngram(
  opts: { limit?: number; force?: boolean; onlyTrails?: string[] } = {},
): Promise<{ pushed: number; pending: number }> {
  if (!cfg.ENGRAM_ENABLED) return { pushed: 0, pending: 0 };
  const { limit = 20, force = false, onlyTrails } = opts;
  const userId = getUserId();
  const now = Date.now();

  const conds = ['engram_dirty = 1', 'page_count >= ?'];
  const args: (string | number)[] = [cfg.MIN_TRAIL_PAGES];
  if (!force) {
    conds.push('last_active <= ?');
    args.push(now - cfg.TRAIL_SETTLE_MS);
    conds.push('(last_engram_push IS NULL OR last_engram_push <= ?)');
    args.push(now - cfg.ENGRAM_MIN_REPUSH_MS);
  }
  if (onlyTrails && onlyTrails.length) {
    conds.push(`id IN (${onlyTrails.map(() => '?').join(',')})`);
    args.push(...onlyTrails);
  }

  const pending = (db.prepare(
    'SELECT COUNT(*) c FROM trails WHERE engram_dirty = 1 AND page_count >= ?',
  ).get(cfg.MIN_TRAIL_PAGES) as { c: number }).c;

  const dirty = db.prepare(
    `SELECT id FROM trails WHERE ${conds.join(' AND ')} ORDER BY last_active DESC LIMIT ?`,
  ).all(...args, limit) as { id: string }[];

  let pushed = 0;
  for (const { id } of dirty) {
    const t = getTrail(id);
    if (!t) continue;
    const signal = buildSignal(t.label || id, trailPages(id));
    const ref = await engramUpsertTrail(userId, id, signal);
    if (ref) {
      // only clear the dirty flag on success, so failed pushes retry next pass
      db.prepare('UPDATE trails SET engram_dirty = 0, engram_ref = ?, last_engram_push = ? WHERE id = ?')
        .run(ref, now, id);
      pushed++;
    }
  }
  return { pushed, pending };
}
