// The "tab zero" checkpoint. Passive capture already saved everything; this is what makes the
// *manual* button special — the one intentional boundary in an otherwise intention-free stream.
// On zero we (1) snapshot the exact tabs open together as a resurrectable working set, (2) finalize
// labels + recaps for those trails now, while context is freshest and the user has declared them
// done, and (3) force-push them to Engram. Explicit intent = the right moment to spend the budget.
import { db } from './db.js';
import { canonicalize } from './canonical.js';
import { getTrail, listTrails, labelTrail, summarizeTrail } from './trails.js';
import { flushEngram } from './sync.js';
import * as cfg from './config.js';
import type { TrailDTO } from './types.js';

export interface ZeroResult {
  ok: true;
  checkpointId: number | null;
  closedCount: number;
  trailCount: number;
  finalized: number;
  pushedToEngram: number;
  trails: TrailDTO[];
}

export async function zeroCheckpoint(openUrls: string[]): Promise<ZeroResult> {
  const now = Date.now();

  // 1. Snapshot the working set: dedup the open tabs by canonical url and resolve each to its trail.
  const seen = new Set<string>();
  const rows: { canonical: string; trailId: string | null }[] = [];
  for (const raw of openUrls) {
    const c = canonicalize(raw);
    if (!c || seen.has(c.canonical)) continue;
    seen.add(c.canonical);
    const p = db.prepare('SELECT trail_id FROM pages WHERE canonical_url = ?')
      .get(c.canonical) as { trail_id: string | null } | undefined;
    rows.push({ canonical: c.canonical, trailId: p?.trail_id ?? null });
  }

  let checkpointId: number | null = null;
  if (rows.length) {
    const info = db.prepare('INSERT INTO checkpoints (ts, closed_count) VALUES (?, ?)').run(now, rows.length);
    checkpointId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO checkpoint_pages (checkpoint_id, canonical_url, trail_id) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(checkpointId, r.canonical, r.trailId);
  }

  // 2. Finalize the trails represented in this working set — name + recap them now (bypassing the
  //    settle gate, since the user just told us they're done) so resurrection is instant later.
  const trailIds = [...new Set(rows.map((r) => r.trailId).filter((x): x is string => !!x))];
  let finalized = 0;
  for (const id of trailIds) {
    const t = getTrail(id);
    if (!t || t.page_count < cfg.MIN_TRAIL_PAGES) continue;
    if (t.label_dirty) await labelTrail(id);
    if (t.summary_dirty || !t.summary) await summarizeTrail(id, { force: true });
    finalized++;
  }

  // 3. Force-push everything stale to Engram right now (explicit intent bypasses the re-push guard).
  const { pushed } = await flushEngram({ force: true, limit: 50 });

  const trailCount = (db.prepare('SELECT COUNT(*) c FROM trails WHERE page_count >= ?')
    .get(cfg.MIN_TRAIL_PAGES) as { c: number }).c;

  return {
    ok: true,
    checkpointId,
    closedCount: openUrls.length,
    trailCount,
    finalized,
    pushedToEngram: pushed,
    trails: listTrails({ limit: 8 }),
  };
}
