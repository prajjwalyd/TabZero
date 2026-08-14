import { db, getUserId } from '../core/db.js';
import { topTokens, provisionalLabel, cosine, type Vec } from '../capture/canonical.js';
import { llmText } from '../core/llm.js';
import { engramSearch, engramTrailMemory, engramInterests, engramAssertInterest } from '../engram/client.js';
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

export function listTrails(opts: { limit?: number } = {}): TrailDTO[] {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  let dtos = rows
    .filter((t) => t.page_count >= cfg.MIN_TRAIL_PAGES) // sub-threshold trails are still forming
    .map((t) => toDTO(t, now))
    .filter((d) => d.status !== 'archived')
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
 * URLs to actually reopen when resurrecting. Prefers the working set from the most recent
 * "tab zero" checkpoint that included this trail — i.e. the tabs you had open together last time
 * you set the topic down — and falls back to the trail's full history if it was never checkpointed.
 */
export function resurrectUrls(id: string): string[] {
  const cp = db.prepare('SELECT MAX(checkpoint_id) m FROM checkpoint_pages WHERE trail_id = ?')
    .get(id) as { m: number | null } | undefined;
  if (cp?.m) {
    const rows = db.prepare(
      `SELECT p.url FROM checkpoint_pages cx
         JOIN pages p ON p.canonical_url = cx.canonical_url
        WHERE cx.checkpoint_id = ? AND cx.trail_id = ?
        ORDER BY p.last_seen ASC`,
    ).all(cp.m, id) as { url: string }[];
    if (rows.length) return rows.map((r) => r.url);
  }
  return trailUrls(id);
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

// ---------- cross-trail research interests (locally GATED, Engram-synthesized) ----------
//
// An interest is NOT "a trail" — it's a theme the user is durably invested in. The local gate is the
// guarantee against a firehose: a trail qualifies only if it's *recurring* (returned across sessions)
// OR *deep* (a big rabbit hole), AND still recent. Qualifying trails are then clustered into themes
// by centroid similarity (breadth). Engram synthesizes/names the survivors; it never decides the set.

interface ThemeTrail {
  id: string; label: string; centroid: Vec;
  liveness: number; sessions: number; pages: number; lastActive: number;
}
interface Theme { trails: ThemeTrail[]; centroid: Vec; score: number; key: string }

export interface InterestsResult {
  source: 'engram' | 'local';
  interests: { label: string; detail: string }[];
}

/** Trails that clear the durability gate: recurring OR deep, and still recent. */
function qualifyingTrails(now: number): ThemeTrail[] {
  const rows = db.prepare('SELECT * FROM trails').all() as unknown as TrailRow[];
  const out: ThemeTrail[] = [];
  for (const t of rows) {
    if (t.page_count < cfg.MIN_TRAIL_PAGES) continue;
    if (statusFor(t.page_count, t.last_active, now) === 'archived') continue;
    const dwell = (db.prepare('SELECT COALESCE(SUM(total_dwell_ms),0) d FROM pages WHERE trail_id = ?')
      .get(t.id) as { d: number }).d;
    const recurring = t.session_count >= cfg.INTEREST_MIN_SESSIONS;
    const deep = t.page_count >= cfg.INTEREST_DEEP_PAGES || dwell >= cfg.INTEREST_DEEP_DWELL_MS;
    if (!recurring && !deep) continue;
    const liveness = computeLiveness(t.page_count, t.session_count, t.last_active, now);
    if (liveness < cfg.INTEREST_MIN_LIVENESS) continue;
    let centroid: Vec = {};
    try { centroid = JSON.parse(t.centroid || '{}'); } catch { /* ignore */ }
    out.push({ id: t.id, label: t.label || t.id, centroid, liveness, sessions: t.session_count, pages: t.page_count, lastActive: t.last_active });
  }
  return out.sort((a, b) => b.liveness - a.liveness);
}

/** Greedy-cluster qualifying trails into themes by centroid similarity; rank by summed liveness. */
function clusterThemes(trails: ThemeTrail[]): Theme[] {
  const themes: Theme[] = [];
  for (const t of trails) {
    let best: Theme | null = null;
    let bestScore = 0;
    for (const th of themes) {
      const s = cosine(t.centroid, th.centroid);
      if (s > bestScore) { bestScore = s; best = th; }
    }
    if (best && bestScore >= cfg.INTEREST_THEME_THRESHOLD) {
      best.trails.push(t);
      for (const k in t.centroid) best.centroid[k] = (best.centroid[k] || 0) + t.centroid[k];
    } else {
      themes.push({ trails: [t], centroid: { ...t.centroid }, score: 0, key: '' });
    }
  }
  for (const th of themes) {
    th.score = th.trails.reduce((s, x) => s + x.liveness, 0) * (1 + 0.25 * (th.trails.length - 1));
    th.key = topTokens(th.centroid, 4).join('-') || th.trails[0].id;
  }
  return themes.sort((a, b) => b.score - a.score);
}

function localName(th: Theme, now: number): { label: string; detail: string } {
  const sessions = th.trails.reduce((s, x) => s + x.sessions, 0);
  const lastActive = Math.max(...th.trails.map((x) => x.lastActive));
  const n = th.trails.length;
  const detail = `${n} trail${n > 1 ? 's' : ''} · ${sessions} session${sessions > 1 ? 's' : ''} · active ${relTime(lastActive, now)}`;
  return { label: th.trails[0].label, detail };
}

/**
 * Durable, cross-trail interests. The set is decided LOCALLY by the durability gate (never a
 * firehose); Engram, when available, supplies the synthesized name for a theme (matched by key),
 * otherwise the most-live trail's label stands in.
 */
export async function getInterests(userId: string): Promise<InterestsResult> {
  const now = Date.now();
  const themes = clusterThemes(qualifyingTrails(now)).slice(0, 8);
  if (!themes.length) return { source: 'local', interests: [] };

  let byKey = new Map<string, string>();
  let usedEngram = false;
  if (cfg.ENGRAM_ENABLED) {
    const derived = await engramInterests(userId);
    byKey = new Map(derived.filter((d) => d.key).map((d) => [d.key as string, d.content]));
    usedEngram = byKey.size > 0;
  }

  const interests = themes.map((th) => {
    const local = localName(th, now);
    const synthesized = byKey.get(th.key);
    return { label: synthesized || local.label, detail: local.detail };
  });
  return { source: usedEngram ? 'engram' : 'local', interests };
}

/**
 * Assert the currently-qualifying interest themes to Engram so it can reconcile + name them. Only
 * survivors of the local gate are ever pushed — this is the WRITE path, kept off the hot read path
 * and called from the /zero checkpoint (the budget-appropriate moment).
 */
export async function syncInterests(userId: string): Promise<number> {
  if (!cfg.ENGRAM_ENABLED) return 0;
  const now = Date.now();
  const themes = clusterThemes(qualifyingTrails(now)).slice(0, 8);
  let n = 0;
  for (const th of themes) {
    const signal = [
      `Recurring interest across ${th.trails.length} trail(s):`,
      ...th.trails.map((t) => `${t.label} (${t.sessions} sessions, ${t.pages} pages)`),
    ];
    const ref = await engramAssertInterest(userId, th.key, signal);
    if (ref) n++;
  }
  return n;
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
