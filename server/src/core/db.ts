import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_PATH, USER_ID, hardenPath } from './config.js';

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  tab_id        INTEGER,
  opener_tab_id INTEGER,
  window_id     INTEGER,
  url           TEXT,
  canonical_url TEXT,
  title         TEXT,
  favicon       TEXT,
  description   TEXT
);
-- Deliberately unindexed. events is an append-only log written on every captured tab event, and the
-- single query that reads it back (trails.ts::weekInTabs) is a bounded ORDER BY id DESC LIMIT scan
-- that rides the implicit rowid order. Indexes on ts/tab_id were being maintained on every insert
-- and used by nothing; DROP so databases created earlier stop paying for them too.
DROP INDEX IF EXISTS idx_events_ts;
DROP INDEX IF EXISTS idx_events_tab;

CREATE TABLE IF NOT EXISTS pages (
  canonical_url  TEXT PRIMARY KEY,
  url            TEXT,
  title          TEXT,
  domain         TEXT,
  first_seen     INTEGER,
  last_seen      INTEGER,
  visit_count    INTEGER DEFAULT 1,
  total_dwell_ms INTEGER DEFAULT 0,
  trail_id       TEXT,
  tokens         TEXT,
  description    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_trail  ON pages(trail_id);
CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);

-- NOTE: status and liveness are deliberately NOT stored. Both are derived on read from page_count,
-- session_count and last_active (trails.ts::statusFor / computeLiveness), so a stored copy would be
-- stale the moment the clock moved and there'd be no sweeper to fix it. Databases created before this
-- keep two vestigial columns that nothing reads or writes.
CREATE TABLE IF NOT EXISTS trails (
  id            TEXT PRIMARY KEY,
  label         TEXT,
  one_liner     TEXT,
  created       INTEGER,
  last_active   INTEGER,
  summary       TEXT,
  summary_dirty INTEGER DEFAULT 1,
  label_dirty   INTEGER DEFAULT 1,
  engram_dirty  INTEGER DEFAULT 1,
  engram_ref    TEXT,
  centroid      TEXT DEFAULT '{}',
  page_count    INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 1,
  category      TEXT
);
CREATE INDEX IF NOT EXISTS idx_trails_active ON trails(last_active);

-- A checkpoint is the working set at the moment the user hit "tab zero": the exact tabs that were
-- open together. Resurrection prefers this over a trail's full history, so reopening restores what
-- you actually had open last time you set the topic down — not every URL the trail ever touched.
CREATE TABLE IF NOT EXISTS checkpoints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  closed_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checkpoint_pages (
  checkpoint_id INTEGER NOT NULL,
  canonical_url TEXT NOT NULL,
  trail_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_pages_cp    ON checkpoint_pages(checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_cp_pages_trail ON checkpoint_pages(trail_id);

-- Growable category vocabulary. Seeded (in categories.ts) from the fixed taxonomy with seed=1; the
-- LLM mints new seed=0 keys only when a trail fits nothing existing. seed rows are never GC'd.
CREATE TABLE IF NOT EXISTS categories (
  key     TEXT PRIMARY KEY,
  label   TEXT NOT NULL,
  seed    INTEGER DEFAULT 0,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
`);

// Migration: add pages.description to databases created before metadata capture existed.
const pageCols = db.prepare('PRAGMA table_info(pages)').all() as unknown as { name: string }[];
if (!pageCols.some((c) => c.name === 'description')) {
  db.exec('ALTER TABLE pages ADD COLUMN description TEXT');
}

// Migration: log the page description alongside the title.
//
// This closes a real gap in the central claim that "the raw log is the source of truth, so everything
// derived is rebuildable by replaying it". It wasn't: `meta` events carry an og:description, that
// description lands in pages.description, and it feeds BOTH the trail centroid (via tokenize) and the
// signal pushed to Engram — but it was never written to the log. A replay therefore produced weaker
// vectors and thinner memories than the original run, silently. Logging it makes the claim true for
// everything captured from here on; rows written before this migration keep a NULL.
const eventCols = db.prepare('PRAGMA table_info(events)').all() as unknown as { name: string }[];
if (!eventCols.some((c) => c.name === 'description')) {
  db.exec('ALTER TABLE events ADD COLUMN description TEXT');
}

// Migration: add trails.category for the LLM-refined category (heuristic is the fallback).
const trailCols = db.prepare('PRAGMA table_info(trails)').all() as unknown as { name: string }[];
if (!trailCols.some((c) => c.name === 'category')) {
  db.exec('ALTER TABLE trails ADD COLUMN category TEXT');
}

// Migration: track the last successful Engram push per trail so the background loop can rate-limit
// re-pushes and stay inside the free-tier pipeline budget.
if (!trailCols.some((c) => c.name === 'last_engram_push')) {
  db.exec('ALTER TABLE trails ADD COLUMN last_engram_push INTEGER');
}

// Migration: record who authored the cached summary ('engram' | 'local' | 'heuristic'). A local
// summary is a placeholder that gets upgraded to Engram's reconciled memory once extraction lands.
if (!trailCols.some((c) => c.name === 'summary_source')) {
  db.exec('ALTER TABLE trails ADD COLUMN summary_source TEXT');
}

// Generic key/value on the `meta` table — currently only backs the stored user_id below.
function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// Owner-only, every start. These three files ARE the browsing history — and the -wal is not an
// afterthought: it holds the most recent writes, so leaving it 0644 while the main DB is 0600 would
// still expose the newest pages. SQLite creates -wal/-shm itself, under the process umask (022 by
// default = world-readable), so they have to be clamped after the connection opens, not before.
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) hardenPath(p);

/**
 * The user/Engram scope. An explicit `TABZERO_USER_ID` always wins (pin an identity, or switch to a
 * clean slate); otherwise a stable random id is generated once and reused forever. Never a device
 * fingerprint. The env override is runtime-only — it is NOT persisted, so removing it reverts to the
 * stored id.
 */
export function getUserId(): string {
  if (USER_ID) return USER_ID;
  const existing = getMeta('user_id');
  if (existing) return existing;
  const id = 'u_' + randomUUID();
  setMeta('user_id', id);
  return id;
}

/**
 * The next trail id — a short, agent-friendly `t_<n>` (e.g. `t_42`) instead of a random hash, so an
 * agent can pass it straight back to `tabzero resurrect <id>` / `GET /trails/<id>` without fumbling an
 * 8-char hex. The counter
 * is monotonic and never recycles a number within a user scope (a deleted trail's id is not reused),
 * which keeps it a safe stable key for Engram memories scoped by `trail_id`. It only restarts on a
 * full DB wipe (`pnpm reset`), which also mints a fresh user_id / clean Engram scope. Single-writer
 * (only the daemon creates trails), so the read-increment needs no locking.
 */
export function nextTrailId(): string {
  const n = Number(getMeta('trail_seq') || '0') + 1;
  setMeta('trail_seq', String(n));
  return `t_${n}`;
}
