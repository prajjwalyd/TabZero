import { db, getUserId } from './db.js';
import { getTrail, trailPages, labelTrail, summarizeTrail } from './trails.js';
import { engramUpsertTrail } from './engram.js';
import * as cfg from './config.js';
import type { PageDTO } from './types.js';

function buildContent(label: string, summary: string | null, pages: PageDTO[]): string {
  const lines = pages
    .slice(-25)
    .map((p) => `- ${p.title}${p.description ? ' — ' + p.description.slice(0, 160) : ''} (${p.domain})`)
    .join('\n');
  return `Research trail: ${label}\n${summary ? summary + '\n' : ''}Pages:\n${lines}`;
}

/** Push trails whose memory is stale up to Engram (bounded TrailSummary rewrites the one memory). */
export async function flushEngram(limit = 20): Promise<number> {
  if (!cfg.ENGRAM_ENABLED) return 0;
  const userId = getUserId();
  const dirty = db.prepare(
    'SELECT id FROM trails WHERE engram_dirty = 1 AND page_count >= ? ORDER BY last_active DESC LIMIT ?',
  ).all(cfg.MIN_TRAIL_PAGES, limit) as { id: string }[];
  let n = 0;
  for (const { id } of dirty) {
    const t = getTrail(id);
    if (!t) continue;
    const content = buildContent(t.label || id, t.summary, trailPages(id));
    const ref = await engramUpsertTrail(userId, id, content);
    if (ref) {
      // only clear the dirty flag on success, so failed pushes retry next pass
      db.prepare('UPDATE trails SET engram_dirty = 0, engram_ref = ? WHERE id = ?').run(ref, id);
      n++;
    }
  }
  return n;
}

/** Upgrade provisional labels to LLM-generated ones for trails that changed. */
export async function enrichLabels(limit = 3): Promise<number> {
  const dirty = db.prepare(
    'SELECT id FROM trails WHERE label_dirty = 1 AND page_count >= ? ORDER BY last_active DESC LIMIT ?',
  ).all(cfg.MIN_TRAIL_PAGES, limit) as { id: string }[];
  let n = 0;
  for (const { id } of dirty) {
    await labelTrail(id);
    n++;
  }
  return n;
}

/** Pre-warm recap summaries for the most-active stale trails so resurrect feels instant. */
export async function enrichSummaries(limit = 1): Promise<number> {
  const dirty = db.prepare(
    'SELECT id FROM trails WHERE summary_dirty = 1 AND page_count >= ? ORDER BY last_active DESC LIMIT ?',
  ).all(cfg.MIN_TRAIL_PAGES, limit) as { id: string }[];
  let n = 0;
  for (const { id } of dirty) {
    await summarizeTrail(id, { force: true });
    n++;
  }
  return n;
}
