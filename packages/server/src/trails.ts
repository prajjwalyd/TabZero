import { db } from './db.js';
import { topTokens, provisionalLabel, type Vec } from './canonical.js';
import { llmText } from './llm.js';
import { engramSearch } from './engram.js';
import { categorize, coerceCategory, CATEGORY_KEYS, CATEGORY_PROMPT_LIST } from './categories.js';
import * as cfg from './config.js';
import type { TrailRow, PageRow, TrailDTO, PageDTO, TrailDetail, TrailStatus } from './types.js';

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

export function toDTO(t: TrailRow, now: number): TrailDTO {
  const domains = trailDomains(t.id);
  let tokens: string[] = [];
  try { tokens = Object.keys(JSON.parse(t.centroid || '{}')); } catch { /* ignore */ }
  // Prefer the LLM-assigned category; fall back to the instant heuristic until it lands.
  const category = (t.category && CATEGORY_KEYS.includes(t.category)) ? t.category : categorize(domains, tokens);
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

export function listTrails(opts: { includeForming?: boolean; includeArchived?: boolean; limit?: number } = {}): TrailDTO[] {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  let dtos = rows
    .filter((t) => (opts.includeForming ? true : t.page_count >= cfg.MIN_TRAIL_PAGES))
    .map((t) => toDTO(t, now))
    .filter((d) => (opts.includeArchived ? true : d.status !== 'archived'))
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

export function trailUrls(id: string): string[] {
  const rows = db.prepare('SELECT url FROM pages WHERE trail_id = ? ORDER BY last_seen ASC').all(id) as { url: string }[];
  return rows.map((r) => r.url);
}

export async function getTrailDetail(id: string, opts: { summarize?: boolean } = {}): Promise<TrailDetail | null> {
  const t = getTrail(id);
  if (!t) return null;
  let summary = t.summary;
  if (opts.summarize && (!summary || t.summary_dirty)) summary = await summarizeTrail(id);
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
      `Line 3: the single best-fitting category, using exactly one key from this list: ${CATEGORY_PROMPT_LIST}. Output only the key.`,
    { system: 'You label a person\'s browsing research trails. Output exactly three lines: name, description, category key.', maxTokens: 80, timeoutMs: 40000 },
  );

  let label = fallback;
  let oneLiner: string | null = null;
  let category: string | null = null;
  if (out) {
    const lines = out.split('\n').map((s) => s.replace(/^["'\-\s]+|["'\s]+$/g, '').trim()).filter(Boolean);
    if (lines[0]) label = lines[0].slice(0, 60);
    if (lines[1]) oneLiner = lines[1].slice(0, 120);
    if (lines[2]) category = coerceCategory(lines[2]); // null if it named no valid key -> heuristic stays
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
  // Cache hit: a fresh (non-dirty) summary already exists — skip the multi-second LLM call.
  if (!opts.force && t.summary && !t.summary_dirty) return t.summary;
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
  const summary = out && out.length > 20 ? out : heuristic;
  db.prepare('UPDATE trails SET summary = ?, summary_dirty = 0 WHERE id = ?').run(summary, id);
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
  opts: { category?: string } = {},
): Promise<TrailSearchHit[]> {
  const cat = opts.category || undefined;
  const inCat = (h: TrailSearchHit) => !cat || h.trail.category === cat;

  // Empty query = "list my trails" (optionally within one category), ranked by liveness.
  if (!query.trim()) {
    return listTrails({})
      .map((d): TrailSearchHit => ({ trail: d, why: 'list' }))
      .filter(inCat)
      .slice(0, limit);
  }

  const out = new Map<string, TrailSearchHit>();
  const now = Date.now();
  // Widen the candidate pool when filtering, so a category still yields ~limit results.
  const pool = cat ? Math.max(limit * 5, 25) : limit;

  // Local keyword first — precise for literal terms in labels/summaries.
  for (const d of searchLocal(query, pool)) {
    out.set(d.id, { trail: d, why: 'keyword' });
  }
  // Engram semantic fills the rest — catches matches worded differently than the trail.
  for (const hit of await engramSearch(userId, query, pool)) {
    if (!hit.trailId) continue;
    const t = getTrail(hit.trailId);
    if (t && !out.has(t.id)) out.set(t.id, { trail: toDTO(t, now), why: 'semantic', snippet: hit.content?.slice(0, 200) });
  }
  return [...out.values()].filter(inCat).slice(0, limit);
}

// ---------- "your week in tabs" ----------

export interface Stat {
  key: string;
  emoji: string;
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
    stats.push({ key: 'deepest', emoji: '🕳️', label: 'Deepest rabbit hole', value: biggest.label || 'a trail', detail: `${biggest.page_count} pages deep` });
  }

  const boomerang = db.prepare('SELECT title, domain, visit_count FROM pages ORDER BY visit_count DESC LIMIT 1')
    .get() as { title: string; domain: string; visit_count: number } | undefined;
  if (boomerang && boomerang.visit_count > 1) {
    stats.push({ key: 'boomerang', emoji: '🪃', label: 'Boomerang page', value: (boomerang.title || boomerang.domain).slice(0, 48), detail: `reopened ${boomerang.visit_count}×` });
  }

  const dwell = db.prepare('SELECT title, domain, total_dwell_ms FROM pages ORDER BY total_dwell_ms DESC LIMIT 1')
    .get() as { title: string; domain: string; total_dwell_ms: number } | undefined;
  if (dwell && dwell.total_dwell_ms > 15000) {
    stats.push({ key: 'timesink', emoji: '⏳', label: 'Biggest time sink', value: (dwell.title || dwell.domain).slice(0, 48), detail: `${Math.round(dwell.total_dwell_ms / 60000)} min` });
  }

  const abandoned = db.prepare(
    "SELECT label, page_count, last_active FROM trails WHERE page_count >= ? ORDER BY last_active ASC LIMIT 1",
  ).get(cfg.MIN_TRAIL_PAGES) as { label: string; page_count: number; last_active: number } | undefined;
  if (abandoned) {
    stats.push({ key: 'abandoned', emoji: '👻', label: 'Most abandoned trail', value: abandoned.label || 'a trail', detail: `${abandoned.page_count} tabs, ${relTime(abandoned.last_active, now)}` });
  }

  // Scan recent events for late-night activity + tab-hoarding peak.
  const evs = db.prepare('SELECT ts, type FROM events ORDER BY id DESC LIMIT 5000').all() as { ts: number; type: string }[];
  let lateNight = 0;
  let open = 0;
  let peak = 0;
  for (const e of evs) {
    const h = new Date(e.ts).getHours();
    if (h >= 1 && h < 5) lateNight++;
  }
  const asc = [...evs].reverse();
  for (const e of asc) {
    if (e.type === 'open') open++;
    else if (e.type === 'close') open = Math.max(0, open - 1);
    if (open > peak) peak = open;
  }
  if (lateNight > 0) {
    stats.push({ key: 'latenight', emoji: '🌙', label: 'Late-night incident', value: `${lateNight} tabs`, detail: 'opened between 1–5am' });
  }
  if (peak > 1) {
    stats.push({ key: 'hoard', emoji: '📚', label: 'Tab-hoarding peak', value: `${peak} tabs`, detail: 'open at once' });
  }

  const headline = trailCount > 0
    ? `${pageCount} pages reconciled into ${trailCount} research ${trailCount === 1 ? 'trail' : 'trails'}.`
    : 'Open some tabs and your week will start filling in.';

  return { headline, stats };
}

// ---------- util ----------

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
