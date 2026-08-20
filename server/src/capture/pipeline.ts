import { db, nextTrailId } from '../core/db.js';
import {
  canonicalize,
  tokenize,
  bag,
  addInto,
  cosine,
  topTokens,
  provisionalLabel,
  type Canon,
  type Vec,
} from './canonical.js';
import { isSensitiveUrl, redact, redactTextParams } from './redact.js';
import type { TabEventInput, PageRow } from '../core/types.js';
import * as cfg from '../core/config.js';

// In-memory session state for the running daemon (rebuilt lazily; not the source of truth).
const activeByWindow = new Map<number, { tabId: number; canonical: string | null; since: number }>();
const tabCanon = new Map<number, string>(); // tabId -> current canonical url
const tabOpener = new Map<number, number>(); // tabId -> openerTabId

// A real page title is well under 200 characters; `description`/`heading` are already clamped to 320
// in upsertPage. An unbounded title is both bad data and a cost: tokenize() lowercases the whole
// string and runs a global regex over it, materializing every match before it stops at 40 tokens, so a
// multi-megabyte title (a hostile client, or simply a page with a pathological <title>) turns one
// event into a long CPU stall. Clamp at the boundary so the log, the page row, and the vector all see
// the same bounded value.
const MAX_TITLE_LEN = 512;
// A title is not just prose: Chrome reports the raw URL as the title until the page supplies one, so a
// title can BE a URL — complete with `code_challenge=` and `state=`. Redact param values here too, or
// the secret that redact() stripped from the url survives in the title beside it.
const clampTitle = (t: string | null | undefined): string | null =>
  t == null ? null : redactTextParams(t.slice(0, MAX_TITLE_LEN)) || null;

export function ingestEvent(ev: TabEventInput): void {
  // Redaction runs BEFORE canonicalization and before anything is written. An auth-flow page is
  // dropped to a null url — which the existing no-canonical path already handles correctly, so dwell
  // and session bookkeeping still work for the rest of the window while neither the address nor a page
  // row is ever stored. Everything else keeps its url with secret-bearing param values replaced.
  const safeUrl = isSensitiveUrl(ev.url) ? null : redact(ev.url);
  const canon = safeUrl ? canonicalize(safeUrl) : null;
  const title = clampTitle(ev.title);

  // 1. Append to the immutable raw log (source of truth for exact reopen).
  db.prepare(
    `INSERT INTO events (ts, type, tab_id, opener_tab_id, window_id, url, canonical_url, title, favicon, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.ts,
    ev.type,
    ev.tabId ?? null,
    ev.openerTabId ?? null,
    ev.windowId ?? null,
    safeUrl,
    canon?.canonical ?? null,
    title,
    ev.favIconUrl ?? null,
    // Logged so a replay reproduces the same vectors and the same Engram signal. Clamped like the
    // page row is, so the log can't become the one unbounded copy.
    redactTextParams((ev.description || ev.heading || '').trim().slice(0, 320)) || null,
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

  if (!canon || ev.type === 'close') return;

  // 3. Page upsert (dedup by canonical url) + trail assignment. Note whether the tab actually moved
  //    to a different url — a same-url re-report (the several onUpdated ticks one load fires, or an
  //    SPA/YouTube mutating its tab title) is NOT a revisit and must not inflate visit_count.
  const revisit = tabCanon.get(ev.tabId) !== canon.canonical;
  tabCanon.set(ev.tabId, canon.canonical);
  const win = activeByWindow.get(ev.windowId ?? -1);
  if (win && win.tabId === ev.tabId) {
    creditDwell(ev.windowId ?? -1, ev.ts);
    win.canonical = canon.canonical;
    win.since = ev.ts;
  }
  upsertPage(canon, ev, revisit, safeUrl);
}

function creditDwell(windowId: number, now: number): void {
  const a = activeByWindow.get(windowId);
  if (a && a.canonical) {
    const dt = Math.min(now - a.since, 30 * 60 * 1000);
    if (dt > 0) {
      db.prepare('UPDATE pages SET total_dwell_ms = total_dwell_ms + ? WHERE canonical_url = ?').run(
        dt,
        a.canonical,
      );
    }
    a.since = now;
  }
}

function upsertPage(canon: Canon, ev: TabEventInput, revisit: boolean, safeUrl: string | null): void {
  const existing = db.prepare('SELECT * FROM pages WHERE canonical_url = ?').get(canon.canonical) as
    PageRow | undefined;
  const title = (clampTitle(ev.title) || existing?.title || '').trim();
  const rawDesc = redactTextParams((ev.description || ev.heading || '').trim().slice(0, 320)) || null;
  // Suppress site-wide boilerplate (e.g. an SPA's static og:description repeated on every route):
  // if this exact description already appears on another page of the same domain, it's a template,
  // not page content — drop it so it never pollutes the trail vector or the memory.
  const desc = rawDesc && !isBoilerplateDesc(canon.domain, rawDesc, canon.canonical) ? rawDesc : null;
  const metaText = desc ? [ev.heading, ev.description].filter(Boolean).join(' ').trim() : '';

  if (existing) {
    // Count a (re)visit only when the tab genuinely navigated back to this url — a same-url
    // re-report (tab-title churn on YouTube/SPAs, or the multiple ticks of one page load) must not
    // bump visit_count, or a page that was never reopened reads as "reopened 50×".
    // Replay guard: a re-delivered batch carries its ORIGINAL timestamps, so a navigate that isn't
    // strictly newer than the last time we saw this page cannot be a new visit. Without this, one
    // duplicated batch inflates visit_count once per replay — a single real visit to a Google sign-in
    // page reached 436 that way, which then surfaced as the "boomerang page" stat. last_seen is
    // clamped with MAX for the same reason: a replayed old event must not drag recency backwards.
    const bump = ev.type === 'navigate' && revisit && ev.ts > existing.last_seen ? 1 : 0;
    db.prepare(
      'UPDATE pages SET last_seen = MAX(last_seen, ?), title = ?, visit_count = visit_count + ? WHERE canonical_url = ?',
    ).run(ev.ts, title || existing.title, bump, canon.canonical);

    // The first time we learn this page's (non-boilerplate) description — usually the content
    // script arriving just after navigate — fold its tokens into the trail vector + mark memory stale.
    if (metaText && !existing.description) {
      const dtok = tokenize('', canon, metaText);
      let ptok: string[] = [];
      try {
        ptok = JSON.parse(existing.tokens || '[]');
      } catch {
        /* ignore */
      }
      const merged = [...new Set([...ptok, ...dtok])].slice(0, 60);
      db.prepare('UPDATE pages SET description = ?, tokens = ? WHERE canonical_url = ?').run(
        desc,
        JSON.stringify(merged),
        canon.canonical,
      );
      if (existing.trail_id) enrichTrailVector(existing.trail_id, dtok, ev.ts);
    } else if (existing.trail_id) {
      touchTrail(existing.trail_id, ev.ts, bump > 0);
    }
    return;
  }

  const tokens = tokenize(title, canon, metaText);
  db.prepare(
    `INSERT INTO pages (canonical_url, url, title, domain, first_seen, last_seen, visit_count, total_dwell_ms, trail_id, tokens, description)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).run(
    canon.canonical,
    safeUrl ?? canon.canonical,
    title,
    canon.domain,
    ev.ts,
    ev.ts,
    null,
    JSON.stringify(tokens),
    desc,
  );

  const trailId = assignTrail(canon, tokens, ev);
  db.prepare('UPDATE pages SET trail_id = ? WHERE canonical_url = ?').run(trailId, canon.canonical);
}

/** True if this exact description already appears on a different page of the same domain (site template). */
function isBoilerplateDesc(domain: string, desc: string, selfCanon: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM pages WHERE domain = ? AND description = ? AND canonical_url != ? LIMIT 1')
    .get(domain, desc, selfCanon);
  return !!row;
}

/** Merge newly-learned metadata tokens into a trail's centroid + re-flag its enrichment. */
function enrichTrailVector(trailId: string, tokens: string[], ts: number): void {
  if (tokens.length === 0) return;
  const t = db.prepare('SELECT centroid FROM trails WHERE id = ?').get(trailId) as
    { centroid: string } | undefined;
  if (!t) return;
  let cen: Vec = {};
  try {
    cen = JSON.parse(t.centroid || '{}');
  } catch {
    /* ignore */
  }
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
      const op = db.prepare('SELECT trail_id FROM pages WHERE canonical_url = ?').get(oc) as
        { trail_id: string | null } | undefined;
      if (op?.trail_id) return addToTrail(op.trail_id, tokens, ev.ts);
    }
  }

  // Otherwise leader-cluster against ALL trails (incl. dormant -> revival is automatic).
  const pv = bag(tokens);
  const trails = db.prepare('SELECT id, centroid, last_active FROM trails').all() as {
    id: string;
    centroid: string;
    last_active: number;
  }[];
  let best: { id: string; score: number } | null = null;
  for (const t of trails) {
    let cen: Vec = {};
    try {
      cen = JSON.parse(t.centroid || '{}');
    } catch {
      /* ignore */
    }
    let score = cosine(pv, cen);
    // The bonus means "this trail was active shortly BEFORE this page", so it needs a non-negative
    // delta. Without the `dt >= 0` guard a trail whose last_active is newer than the incoming event
    // — routine with out-of-order events inside a batch, or a replayed one — collected the bonus for
    // free, and 0.15 is enough to drag a page over ASSIGN_THRESHOLD on one incidental shared token.
    //
    // That last sentence turned out to be literal: a cricket article joined a Spider-Man trail on raw
    // cosine 0.2265 (under the bar) plus this bonus, where the whole 0.2265 came from `wiki` and
    // `wikipedia`. The fix was to stop those being tokens at all — canonical.ts SITE_WORDS — rather than
    // to weaken the bonus, which is what keeps one research session in one trail. If cross-topic merges
    // show up again on genuinely topical words, this ratio (0.15 against a 0.26 threshold) is the next
    // thing to look at, and the replay harness in that commit's notes is how to measure it.
    const dt = ev.ts - t.last_active;
    if (dt >= 0 && dt < cfg.RECENCY_WINDOW_MS) score += cfg.RECENCY_BONUS;
    if (!best || score > best.score) best = { id: t.id, score };
  }
  if (best && best.score >= cfg.ASSIGN_THRESHOLD) return addToTrail(best.id, tokens, ev.ts);

  return createTrail(canon, tokens, ev.ts);
}

function addToTrail(trailId: string, tokens: string[], ts: number): string {
  const t = db
    .prepare('SELECT centroid, page_count, last_active, session_count FROM trails WHERE id = ?')
    .get(trailId) as
    { centroid: string; page_count: number; last_active: number; session_count: number } | undefined;
  if (!t) return trailId;
  let cen: Vec = {};
  try {
    cen = JSON.parse(t.centroid || '{}');
  } catch {
    /* ignore */
  }
  addInto(cen, tokens);
  const pageCount = t.page_count + 1;
  const sessionCount = ts - t.last_active > cfg.RECENCY_WINDOW_MS ? t.session_count + 1 : t.session_count;
  db.prepare(
    `UPDATE trails SET centroid = ?, last_active = ?, page_count = ?, session_count = ?,
       label_dirty = 1, summary_dirty = 1, engram_dirty = 1 WHERE id = ?`,
  ).run(JSON.stringify(cen), ts, pageCount, sessionCount, trailId);
  return trailId;
}

function createTrail(canon: Canon, tokens: string[], ts: number): string {
  const id = nextTrailId();
  const cen = bag(tokens);
  const label = provisionalLabel(topTokens(cen, 3), canon.domain);
  db.prepare(
    `INSERT INTO trails (id, label, one_liner, created, last_active, summary, centroid,
       page_count, session_count, label_dirty, summary_dirty, engram_dirty)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, 1, 1, 1, 1, 1)`,
  ).run(id, label, ts, ts, JSON.stringify(cen));
  return id;
}

function touchTrail(trailId: string, ts: number, realVisit: boolean): void {
  if (realVisit) {
    db.prepare('UPDATE trails SET last_active = ?, summary_dirty = 1, engram_dirty = 1 WHERE id = ?').run(
      ts,
      trailId,
    );
  } else {
    db.prepare('UPDATE trails SET last_active = ? WHERE id = ?').run(ts, trailId);
  }
}
