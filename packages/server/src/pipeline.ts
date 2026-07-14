import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import {
  canonicalize, tokenize, bag, addInto, cosine, topTokens, provisionalLabel,
  type Canon, type Vec,
} from './canonical.js';
import type { TabEventInput, PageRow } from './types.js';
import * as cfg from './config.js';

// In-memory session state for the running daemon (rebuilt lazily; not the source of truth).
const activeByWindow = new Map<number, { tabId: number; canonical: string | null; since: number }>();
const tabCanon = new Map<number, string>(); // tabId -> current canonical url
const tabOpener = new Map<number, number>(); // tabId -> openerTabId

export interface IngestResult {
  trailId?: string;
  created?: boolean;
}

export function ingestEvent(ev: TabEventInput): IngestResult {
  const canon = ev.url ? canonicalize(ev.url) : null;

  // 1. Append to the immutable raw log (source of truth for exact reopen).
  db.prepare(
    `INSERT INTO events (ts, type, tab_id, opener_tab_id, window_id, url, canonical_url, title, favicon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.ts, ev.type, ev.tabId ?? null, ev.openerTabId ?? null, ev.windowId ?? null,
    ev.url ?? null, canon?.canonical ?? null, ev.title ?? null, ev.favIconUrl ?? null,
  );

  if (ev.openerTabId != null) tabOpener.set(ev.tabId, ev.openerTabId);

  // 2. Dwell accounting on focus changes.
  if (ev.type === 'activate' || ev.type === 'close') {
    const win = ev.windowId ?? -1;
    creditDwell(win, ev.ts);
    if (ev.type === 'activate') {
      activeByWindow.set(win, { tabId: ev.tabId, canonical: tabCanon.get(ev.tabId) ?? null, since: ev.ts });
    } else {
      tabCanon.delete(ev.tabId);
    }
  }

  if (!canon || ev.type === 'close') return {};

  // 3. Page upsert (dedup by canonical url) + trail assignment.
  tabCanon.set(ev.tabId, canon.canonical);
  const win = activeByWindow.get(ev.windowId ?? -1);
  if (win && win.tabId === ev.tabId) {
    creditDwell(ev.windowId ?? -1, ev.ts);
    win.canonical = canon.canonical;
    win.since = ev.ts;
  }
  return upsertPage(canon, ev);
}

function creditDwell(windowId: number, now: number): void {
  const a = activeByWindow.get(windowId);
  if (a && a.canonical) {
    const dt = Math.min(now - a.since, 30 * 60 * 1000);
    if (dt > 0) {
      db.prepare('UPDATE pages SET total_dwell_ms = total_dwell_ms + ? WHERE canonical_url = ?').run(dt, a.canonical);
    }
    a.since = now;
  }
}

function upsertPage(canon: Canon, ev: TabEventInput): IngestResult {
  const existing = db.prepare('SELECT * FROM pages WHERE canonical_url = ?').get(canon.canonical) as PageRow | undefined;
  const title = (ev.title || existing?.title || '').trim();
  const rawDesc = (ev.description || ev.heading || '').trim().slice(0, 320) || null;
  // Suppress site-wide boilerplate (e.g. an SPA's static og:description repeated on every route):
  // if this exact description already appears on another page of the same domain, it's a template,
  // not page content — drop it so it never pollutes the trail vector or the memory.
  const desc = rawDesc && !isBoilerplateDesc(canon.domain, rawDesc, canon.canonical) ? rawDesc : null;
  const metaText = desc ? [ev.heading, ev.description].filter(Boolean).join(' ').trim() : '';

  if (existing) {
    const bump = ev.type === 'navigate' || ev.type === 'open' ? 1 : 0;
    db.prepare('UPDATE pages SET last_seen = ?, title = ?, visit_count = visit_count + ? WHERE canonical_url = ?')
      .run(ev.ts, title || existing.title, bump, canon.canonical);

    // The first time we learn this page's (non-boilerplate) description — usually the content
    // script arriving just after navigate — fold its tokens into the trail vector + mark memory stale.
    if (metaText && !existing.description) {
      const dtok = tokenize('', canon, metaText);
      let ptok: string[] = [];
      try { ptok = JSON.parse(existing.tokens || '[]'); } catch { /* ignore */ }
      const merged = [...new Set([...ptok, ...dtok])].slice(0, 60);
      db.prepare('UPDATE pages SET description = ?, tokens = ? WHERE canonical_url = ?')
        .run(desc, JSON.stringify(merged), canon.canonical);
      if (existing.trail_id) enrichTrailVector(existing.trail_id, dtok, ev.ts);
    } else if (existing.trail_id) {
      touchTrail(existing.trail_id, ev.ts, bump > 0);
    }
    return { trailId: existing.trail_id ?? undefined };
  }

  const tokens = tokenize(title, canon, metaText);
  db.prepare(
    `INSERT INTO pages (canonical_url, url, title, domain, first_seen, last_seen, visit_count, total_dwell_ms, trail_id, tokens, description)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).run(canon.canonical, ev.url ?? canon.canonical, title, canon.domain, ev.ts, ev.ts, null, JSON.stringify(tokens), desc);

  const trailId = assignTrail(canon, tokens, ev);
  db.prepare('UPDATE pages SET trail_id = ? WHERE canonical_url = ?').run(trailId, canon.canonical);
  return { trailId, created: true };
}

/** True if this exact description already appears on a different page of the same domain (site template). */
function isBoilerplateDesc(domain: string, desc: string, selfCanon: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM pages WHERE domain = ? AND description = ? AND canonical_url != ? LIMIT 1',
  ).get(domain, desc, selfCanon);
  return !!row;
}

/** Merge newly-learned metadata tokens into a trail's centroid + re-flag its enrichment. */
function enrichTrailVector(trailId: string, tokens: string[], ts: number): void {
  if (tokens.length === 0) return;
  const t = db.prepare('SELECT centroid FROM trails WHERE id = ?').get(trailId) as { centroid: string } | undefined;
  if (!t) return;
  let cen: Vec = {};
  try { cen = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
  addInto(cen, tokens);
  db.prepare(
    `UPDATE trails SET centroid = ?, last_active = ?, label_dirty = 1, summary_dirty = 1, engram_dirty = 1 WHERE id = ?`,
  ).run(JSON.stringify(cen), ts, trailId);
}

function assignTrail(canon: Canon, tokens: string[], ev: TabEventInput): string {
  // Opener graph: a link-spawned tab almost always continues the opener's trail.
  const opener = ev.openerTabId ?? tabOpener.get(ev.tabId);
  if (opener != null) {
    const oc = tabCanon.get(opener);
    if (oc) {
      const op = db.prepare('SELECT trail_id FROM pages WHERE canonical_url = ?').get(oc) as { trail_id: string | null } | undefined;
      if (op?.trail_id) return addToTrail(op.trail_id, tokens, ev.ts);
    }
  }

  // Otherwise leader-cluster against ALL trails (incl. dormant -> revival is automatic).
  const pv = bag(tokens);
  const trails = db.prepare('SELECT id, centroid, last_active FROM trails').all() as
    { id: string; centroid: string; last_active: number }[];
  let best: { id: string; score: number } | null = null;
  for (const t of trails) {
    let cen: Vec = {};
    try { cen = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
    let score = cosine(pv, cen);
    if (ev.ts - t.last_active < cfg.RECENCY_WINDOW_MS) score += cfg.RECENCY_BONUS;
    if (!best || score > best.score) best = { id: t.id, score };
  }
  if (best && best.score >= cfg.ASSIGN_THRESHOLD) return addToTrail(best.id, tokens, ev.ts);

  return createTrail(canon, tokens, ev.ts);
}

function addToTrail(trailId: string, tokens: string[], ts: number): string {
  const t = db.prepare('SELECT centroid, page_count, last_active, session_count, status FROM trails WHERE id = ?').get(trailId) as
    { centroid: string; page_count: number; last_active: number; session_count: number; status: string } | undefined;
  if (!t) return trailId;
  let cen: Vec = {};
  try { cen = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
  addInto(cen, tokens);
  const pageCount = t.page_count + 1;
  const sessionCount = ts - t.last_active > cfg.RECENCY_WINDOW_MS ? t.session_count + 1 : t.session_count;
  const status = pageCount >= cfg.MIN_TRAIL_PAGES && (t.status === 'forming' || t.status === 'dormant' || t.status === 'archived')
    ? 'live'
    : t.status;
  db.prepare(
    `UPDATE trails SET centroid = ?, last_active = ?, page_count = ?, session_count = ?, status = ?,
       label_dirty = 1, summary_dirty = 1, engram_dirty = 1 WHERE id = ?`,
  ).run(JSON.stringify(cen), ts, pageCount, sessionCount, status, trailId);
  return trailId;
}

function createTrail(canon: Canon, tokens: string[], ts: number): string {
  const id = 't_' + randomUUID().slice(0, 8);
  const cen = bag(tokens);
  const label = provisionalLabel(topTokens(cen, 3), canon.domain);
  db.prepare(
    `INSERT INTO trails (id, label, one_liner, status, created, last_active, liveness, summary, centroid,
       page_count, session_count, label_dirty, summary_dirty, engram_dirty)
     VALUES (?, ?, NULL, 'forming', ?, ?, 0, NULL, ?, 1, 1, 1, 1, 1)`,
  ).run(id, label, ts, ts, JSON.stringify(cen));
  return id;
}

function touchTrail(trailId: string, ts: number, realVisit: boolean): void {
  if (realVisit) {
    db.prepare('UPDATE trails SET last_active = ?, summary_dirty = 1, engram_dirty = 1 WHERE id = ?').run(ts, trailId);
  } else {
    db.prepare('UPDATE trails SET last_active = ? WHERE id = ?').run(ts, trailId);
  }
}
