import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_PATH } from './config.js';

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
  favicon       TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts  ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_tab ON events(tab_id);

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

CREATE TABLE IF NOT EXISTS trails (
  id            TEXT PRIMARY KEY,
  label         TEXT,
  one_liner     TEXT,
  status        TEXT DEFAULT 'forming',
  created       INTEGER,
  last_active   INTEGER,
  liveness      REAL DEFAULT 0,
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

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Stable per-install user id (generated once, reused forever — never a device fingerprint). */
export function getUserId(): string {
  const existing = getMeta('user_id');
  if (existing) return existing;
  const id = 'u_' + randomUUID();
  setMeta('user_id', id);
  return id;
}
