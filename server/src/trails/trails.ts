import { db, getUserId } from '../core/db.js';
import { topTokens, provisionalLabel, type Vec } from '../capture/canonical.js';
import { llmText } from '../core/llm.js';
import { engramSearch, engramTrailMemory, engramInterests } from '../engram/client.js';
import { categorize, resolveCategory, knownCategory, categoryPromptList } from './categories.js';
import * as cfg from '../core/config.js';
import type { TrailRow, PageRow, TrailDTO, PageDTO, TrailDetail, TrailStatus } from '../core/types.js';

const DAY = 86400000;

// ---------- decay / status ----------

export function computeLiveness(pageCount: number, sessionCount: number, lastActive: number, now: number): number {
  const base = Math.log1p(pageCount) + 0.5 * Math.log1p(sessionCount);
  const days = Math.max(0, (now - lastActive) / DAY);
  return +(base * Math.pow(0.5, days / cfg.DECAY_HALFLIFE_DAYS)).toFixed(4);
}

export function statusFor(pageCount: number, lastActive: number, now: number): TrailStatus {
  if (pageCount < cfg.MIN_TRAIL_PAGES) return 'forming';
  const days = (now - lastActive) / DAY;
  if (days >= cfg.ARCHIVE_AFTER_DAYS) return 'archived';
  if (days >= cfg.DORMANT_AFTER_DAYS) return 'dormant';
  return 'live';
}

function trailDomains(trailId: string): string[] {
  const rows = db.prepare('SELECT domain, COUNT(*) c FROM pages WHERE trail_id = ? GROUP BY domain ORDER BY c DESC')
    .all(trailId) as unknown as { domain: string }[];
  return rows.map((r) => r.domain).filter(Boolean);
}

function topDomain(trailId: string): string | null {
  return trailDomains(trailId)[0] ?? null;
}

// ---------- read models ----------

export function getTrail(id: string): TrailRow | undefined {
  return db.prepare('SELECT * FROM trails WHERE id = ?').get(id) as TrailRow | undefined;
}

function toDTO(t: TrailRow, now: number): TrailDTO {
  const domains = trailDomains(t.id);
  let tokens: string[] = [];
  try { tokens = Object.keys(JSON.parse(t.centroid || '{}')); } catch { /* ignore */ }
  // Prefer the LLM-assigned category; fall back to the instant heuristic until it lands.
  const category = knownCategory(t.category) ? t.category! : categorize(domains, tokens);
  return {
    id: t.id,
    label: t.label || provisionalLabel([], domains[0] ?? null),
    oneLiner: t.one_liner,
    status: statusFor(t.page_count, t.last_active, now),
    liveness: computeLiveness(t.page_count, t.session_count, t.last_active, now),
    pageCount: t.page_count,
    lastActive: t.last_active,
    createdAt: t.created,
    topDomain: domains[0] ?? null,
    category,
  };
}

export function listTrails(opts: { limit?: number; includeArchived?: boolean } = {}): TrailDTO[] {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  let dtos = rows
    .filter((t) => t.page_count >= cfg.MIN_TRAIL_PAGES) // sub-threshold trails are still forming
    .map((t) => toDTO(t, now))
    .filter((d) => opts.includeArchived || d.status !== 'archived')
    .sort((a, b) => b.liveness - a.liveness || b.lastActive - a.lastActive);
  if (opts.limit) dtos = dtos.slice(0, opts.limit);
  return dtos;
}

export function trailPages(id: string): PageDTO[] {
  const rows = db.prepare('SELECT * FROM pages WHERE trail_id = ? ORDER BY last_seen ASC').all(id) as unknown as PageRow[];
  return rows.map((p) => ({
    url: p.url,
    title: p.title || p.url,
    domain: p.domain,
    lastSeen: p.last_seen,
    visitCount: p.visit_count,
    dwellMs: p.total_dwell_ms,
    description: p.description,
  }));
}

function trailUrls(id: string): string[] {
  const rows = db.prepare('SELECT url FROM pages WHERE trail_id = ? ORDER BY last_seen ASC').all(id) as { url: string }[];
  return rows.map((r) => r.url);
}

/**
 * URLs to reopen when resurrecting: the working set from the most recent "tab zero" that included this
 * trail — the tabs you had open together when you set the topic down — UNION anything visited since.
 *
 * The union is the important half. Taking the checkpoint alone replays a stale snapshot: resume a
 * trail after zeroing it, browse five more pages without zeroing again, and those five silently never
 * reopen. Falls back to full history for a trail that was never checkpointed.
 */
export function resurrectUrls(id: string): string[] {
  const cp = db.prepare('SELECT MAX(checkpoint_id) m FROM checkpoint_pages WHERE trail_id = ?')
    .get(id) as { m: number | null } | undefined;
  if (!cp?.m) return trailUrls(id);
  const rows = db.prepare(
    `SELECT p.url FROM pages p
       WHERE p.trail_id = ?
         AND (p.canonical_url IN (SELECT canonical_url FROM checkpoint_pages
                                   WHERE checkpoint_id = ? AND trail_id = ?)
              OR p.last_seen > (SELECT ts FROM checkpoints WHERE id = ?))
       ORDER BY p.last_seen ASC`,
  ).all(id, cp.m, id, cp.m) as { url: string }[];
  return rows.length ? rows.map((r) => r.url) : trailUrls(id);
}

/**
 * Whether a cached recap needs (re)generating. Pulled out as a pure predicate because getting it wrong
 * is invisible: gating on missing-or-dirty alone meant a trail recapped LOCALLY before Engram finished
 * extracting kept that placeholder forever — 9 of 20 trails in a real database were frozen that way —
 * even though summarizeTrail is specifically built to retry Engram on every call until its version
 * lands. The retry costs an Engram search, not an LLM call: summarizeTrail returns the cached
 * placeholder on a miss.
 */
export function recapNeedsRefresh(
  t: { summary: string | null; summary_dirty: number; summary_source: string | null },
  engramEnabled: boolean,
): boolean {
  if (!t.summary || t.summary_dirty) return true;
  return engramEnabled && t.summary_source !== 'engram';
}

export async function getTrailDetail(id: string, opts: { summarize?: boolean } = {}): Promise<TrailDetail | null> {
  const t = getTrail(id);
  if (!t) return null;
  let summary = t.summary;
  if (opts.summarize && recapNeedsRefresh(t, cfg.ENGRAM_ENABLED)) summary = await summarizeTrail(id);
  return { ...toDTO(t, Date.now()), summary, pages: trailPages(id) };
}

// ---------- enrichment (LLM, lazy + cached, heuristic fallback) ----------

export async function labelTrail(id: string): Promise<void> {
  const t = getTrail(id);
  if (!t) return;
  const pages = trailPages(id).slice(-12);
  if (pages.length === 0) return;
  const titles = pages.map((p) => `- ${p.title}${p.description ? ' — ' + p.description.slice(0, 140) : ''} (${p.domain})`).join('\n');
  let cen: Vec = {};
  try { cen = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
  const fallback = provisionalLabel(topTokens(cen, 3), topDomain(id));

  const out = await llmText(
    `These web pages form one research trail:\n${titles}\n\n` +
      `Line 1: a short specific name for this trail, 2-6 words, no quotes, no trailing punctuation.\n` +
      `Line 2: a 6-10 word description starting with a verb.\n` +
      `Line 3: the category. STRONGLY prefer reusing exactly one key from this list: ${categoryPromptList()}. ` +
      `Only if the trail genuinely fits none of them, output a short new lowercase key (1-2 words, hyphenated). Output only the key.`,
    { system: 'You label a person\'s browsing research trails. Output exactly three lines: name, description, category key.', maxTokens: 80, timeoutMs: 40000 },
  );

  let label = fallback;
  let oneLiner: string | null = null;
  let category: string | null = null;
  if (out) {
    const lines = out.split('\n').map((s) => s.replace(/^["'\-\s]+|["'\s]+$/g, '').trim()).filter(Boolean);
    if (lines[0]) label = lines[0].slice(0, 60);
    if (lines[1]) oneLiner = lines[1].slice(0, 120);
    if (lines[2]) category = resolveCategory(lines[2]); // reuse existing, mint if novel, or null -> heuristic stays
  }
  // Only overwrite a stored category when the LLM gave a valid one; otherwise keep what's there.
  if (category) {
    db.prepare('UPDATE trails SET label = ?, one_liner = ?, category = ?, label_dirty = 0 WHERE id = ?').run(label, oneLiner, category, id);
  } else {
    db.prepare('UPDATE trails SET label = ?, one_liner = ?, label_dirty = 0 WHERE id = ?').run(label, oneLiner, id);
  }
}

export async function summarizeTrail(id: string, opts: { force?: boolean } = {}): Promise<string> {
  const t = getTrail(id);
  if (!t) return '';
  const store = (summary: string, source: 'engram' | 'local' | 'heuristic') =>
    db.prepare('UPDATE trails SET summary = ?, summary_source = ?, summary_dirty = 0 WHERE id = ?').run(summary, source, id);

  const fresh = !!t.summary && !t.summary_dirty;
  // Fast path: a fresh, Engram-authored summary is the canonical recap — return it instantly.
  if (!opts.force && fresh && t.summary_source === 'engram') return t.summary!;

  // Prefer Engram's reconciled memory. When only a LOCAL placeholder is cached, this is the upgrade
  // path: each read retries Engram until its (async) extraction lands, then Engram's version sticks.
  if (cfg.ENGRAM_ENABLED) {
    const mem = await engramTrailMemory(getUserId(), id, t.label || '');
    if (mem) { store(mem, 'engram'); return mem; }
  }

  // Engram not ready yet. Keep a fresh local placeholder rather than burning an LLM call every read.
  if (!opts.force && fresh) return t.summary!;

  const pages = trailPages(id);
  const now = Date.now();
  const lines = pages
    .map((p) => {
      const s = Math.round(p.dwellMs / 1000);
      const d = p.description ? ` — ${p.description.slice(0, 140)}` : '';
      return `- ${p.title}${d} (${p.domain})${s > 5 ? ` [${s}s]` : ''}`;
    })
    .join('\n');
  const heuristic = `${pages.length} pages, mostly ${topDomain(id) || 'various sites'}. Last active ${relTime(t.last_active, now)}.`;

  const out = await llmText(
    `A research trail with these pages (chronological):\n${lines}\n\n` +
      `Write a short recap (~3 sentences) so the user can pick this back up: ` +
      `(1) what they were trying to figure out or do, (2) what they likely found or concluded, ` +
      `(3) where they left off / what's unfinished. Be concrete about the actual topic. No preamble.`,
    { system: 'You recap a person\'s browsing research trail in the second person ("you"). Be specific and concise.', maxTokens: 220, timeoutMs: 45000 },
  );
  const useLlm = !!out && out.length > 20;
  const summary = useLlm ? out! : heuristic;
  store(summary, useLlm ? 'local' : 'heuristic'); // placeholder — upgrades to Engram once it extracts
  return summary;
}

// ---------- search (Engram semantic + local keyword) ----------

export interface TrailSearchHit {
  trail: TrailDTO;
  why: 'semantic' | 'keyword' | 'list';
  snippet?: string;
}

function searchLocal(query: string, limit: number): TrailDTO[] {
  const qtok = query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  if (qtok.length === 0) return [];
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  const scored = rows
    .map((t) => {
      const hay = `${t.label} ${t.one_liner || ''} ${t.summary || ''}`.toLowerCase();
      let cen: Vec = {};
      try { cen = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
      let score = 0;
      for (const w of qtok) {
        if (hay.includes(w)) score += 1;
        if (cen[w]) score += 0.5;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => toDTO(x.t, now));
}

export async function searchTrails(
  userId: string,
  query: string,
  limit = 5,
): Promise<TrailSearchHit[]> {
  // Empty query = "list my trails", ranked by liveness.
  if (!query.trim()) {
    return listTrails({})
      .map((d): TrailSearchHit => ({ trail: d, why: 'list' }))
      .slice(0, limit);
  }

  const out = new Map<string, TrailSearchHit>();
  const now = Date.now();

  // Local keyword first — precise for literal terms in labels/summaries.
  for (const d of searchLocal(query, limit)) {
    out.set(d.id, { trail: d, why: 'keyword' });
  }
  // Engram semantic fills the rest — catches matches worded differently than the trail.
  for (const hit of await engramSearch(userId, query)) {
    if (!hit.trailId) continue;
    const t = getTrail(hit.trailId);
    if (t && !out.has(t.id)) out.set(t.id, { trail: toDTO(t, now), why: 'semantic', snippet: hit.content?.slice(0, 200) });
  }
  return [...out.values()].slice(0, limit);
}

// ---------- cross-trail research interests ----------
//
// An interest is NOT "a trail" — it's a theme you are durably invested in, spanning several trails.
// That distinction is why Engram owns this layer: trails similar enough to cluster lexically have
// ALREADY been merged into one trail at ingestion (ASSIGN_THRESHOLD), so a local centroid clustering
// pass can only ever produce single-trail "themes" — it measured 6 qualifying trails into 5 themes on
// real data, i.e. a relabelled trail list. Genuine cross-trail synthesis needs embeddings.
//
// Engram's ResearchInterest topic description already carries the durability rule ("form an interest
// ONLY when a theme is durable ... do NOT create one from a single trail, a one-off lookup, or
// ephemeral browsing") and is told to merge aggressively into one evolving memory per interest. It
// applies that rule to the raw signal we push per trail, so no separate assertion pass is needed —
// and in practice it is far stricter than a local gate can be: 2 interests from 19 trails, correctly
// ignoring a cricket final and a one-off comic lookup that a local gate happily admitted.

export interface InterestsResult {
  source: 'engram' | 'local';
  interests: { label: string; detail?: string }[];
}

interface DurableTrail {
  id: string; label: string; liveness: number; sessions: number; pages: number; lastActive: number;
}

/**
 * Local fallback for when Engram is off: trails durable enough to read as an ongoing interest.
 * Mirrors the ResearchInterest rule — recurring across sessions, or a sustained deep investigation —
 * with NO dwell-only branch. Thirty minutes across four pages in a single sitting is an absorbing
 * afternoon (a sports final, a comparison table), not an interest; that branch is what let
 * "India vs New Zealand T20 Final" present itself as durable research.
 */
function durableTrails(now: number): DurableTrail[] {
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  const out: DurableTrail[] = [];
  for (const t of rows) {
    if (t.page_count < cfg.MIN_TRAIL_PAGES) continue;
    if (statusFor(t.page_count, t.last_active, now) === 'archived') continue;
    const recurring = t.session_count >= cfg.INTEREST_MIN_SESSIONS;
    const deep = t.page_count >= cfg.INTEREST_DEEP_PAGES;
    if (!recurring && !deep) continue;
    const liveness = computeLiveness(t.page_count, t.session_count, t.last_active, now);
    if (liveness < cfg.INTEREST_MIN_LIVENESS) continue;
    out.push({
      id: t.id, label: t.label || t.id, liveness,
      sessions: t.session_count, pages: t.page_count, lastActive: t.last_active,
    });
  }
  return out.sort((a, b) => b.liveness - a.liveness);
}

/**
 * Durable research interests. Engram's synthesized memories ARE the answer when it has any — they are
 * cross-trail, already deduped, and carry current state ("evaluating X, currently leaning Y"). The
 * local list is a strictly weaker stand-in used only when Engram is off or has not extracted yet, and
 * it says so via `source` rather than pretending the two are equivalent.
 */
export async function getInterests(userId: string): Promise<InterestsResult> {
  if (cfg.ENGRAM_ENABLED) {
    const derived = await engramInterests(userId);
    if (derived.length) {
      return { source: 'engram', interests: derived.slice(0, 8).map((d) => ({ label: d.content })) };
    }
  }
  const now = Date.now();
  return {
    source: 'local',
    interests: durableTrails(now).slice(0, 8).map((t) => ({
      label: t.label,
      detail: `${t.pages} pages · ${t.sessions} session${t.sessions > 1 ? 's' : ''} · active ${relTime(t.lastActive, now)}`,
    })),
  };
}

// ---------- "your week in tabs" ----------

export interface Stat {
  key: string;
  label: string;
  value: string;
  detail?: string;
}

export function weekInTabs(): { headline: string; stats: Stat[] } {
  const now = Date.now();
  const stats: Stat[] = [];

  const pageCount = (db.prepare('SELECT COUNT(*) c FROM pages').get() as { c: number }).c;
  const trailCount = (db.prepare('SELECT COUNT(*) c FROM trails WHERE page_count >= ?').get(cfg.MIN_TRAIL_PAGES) as { c: number }).c;

  const biggest = db.prepare('SELECT id, label, page_count FROM trails ORDER BY page_count DESC LIMIT 1')
    .get() as { label: string; page_count: number } | undefined;
  if (biggest && biggest.page_count > 0) {
    stats.push({ key: 'deepest', label: 'Deepest rabbit hole', value: biggest.label || 'a trail', detail: `${biggest.page_count} pages deep` });
  }

  const boomerang = db.prepare('SELECT title, domain, visit_count FROM pages ORDER BY visit_count DESC LIMIT 1')
    .get() as { title: string; domain: string; visit_count: number } | undefined;
  if (boomerang && boomerang.visit_count > 1) {
    stats.push({ key: 'boomerang', label: 'Boomerang page', value: (boomerang.title || boomerang.domain).slice(0, 48), detail: `reopened ${boomerang.visit_count}×` });
  }

  const dwell = db.prepare('SELECT title, domain, total_dwell_ms FROM pages ORDER BY total_dwell_ms DESC LIMIT 1')
    .get() as { title: string; domain: string; total_dwell_ms: number } | undefined;
  if (dwell && dwell.total_dwell_ms > 15000) {
    stats.push({ key: 'timesink', label: 'Biggest time sink', value: (dwell.title || dwell.domain).slice(0, 48), detail: `${Math.round(dwell.total_dwell_ms / 60000)} min` });
  }

  const abandoned = db.prepare(
    "SELECT label, page_count, last_active FROM trails WHERE page_count >= ? ORDER BY last_active ASC LIMIT 1",
  ).get(cfg.MIN_TRAIL_PAGES) as { label: string; page_count: number; last_active: number } | undefined;
  if (abandoned) {
    stats.push({ key: 'abandoned', label: 'Most abandoned trail', value: abandoned.label || 'a trail', detail: `${abandoned.page_count} tabs, ${relTime(abandoned.last_active, now)}` });
  }

  // Scan recent events for late-night activity + tab-hoarding peak.
  const evs = db.prepare('SELECT ts, type, tab_id FROM events ORDER BY id DESC LIMIT 5000')
    .all() as { ts: number; type: string; tab_id: number | null }[];
  let lateNight = 0;
  for (const e of evs) {
    const h = new Date(e.ts).getHours();
    if (h >= 1 && h < 5) lateNight++;
  }
  // Peak simultaneous tabs, by replaying open/close over a SET of tab ids (not a counter): a
  // re-reported open can't double-count and a close for an unknown tab can't underflow.
  const liveTabs = new Set<number>();
  let peak = 0;
  for (const e of [...evs].reverse()) {
    if (e.tab_id == null) continue;
    if (e.type === 'open') liveTabs.add(e.tab_id);
    else if (e.type === 'close') liveTabs.delete(e.tab_id);
    if (liveTabs.size > peak) peak = liveTabs.size;
  }
  if (lateNight > 0) {
    stats.push({ key: 'latenight', label: 'Late-night incident', value: `${lateNight} tabs`, detail: 'opened between 1–5am' });
  }
  if (peak > 1) {
    stats.push({ key: 'hoard', label: 'Tab-hoarding peak', value: `${peak} tabs`, detail: 'open at once' });
  }

  const headline = trailCount > 0
    ? `${pageCount} pages reconciled into ${trailCount} research ${trailCount === 1 ? 'trail' : 'trails'}.`
    : 'Open some tabs and your week will start filling in.';

  return { headline, stats };
}

// ---------- util ----------

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
