import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** Walk up from a starting dir to find the repo root (marked by tsconfig.base.json, committed & root-only). Null if not in a repo. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'tsconfig.base.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
// In the repo (dev): root is the repo, data sits in <repo>/.tabzero.
// Installed/packaged (npx, global): no repo marker exists, so data lives in ~/.tabzero and persists
// across npm-cache eviction.
const repoRoot =
  process.env.TABZERO_ROOT ||
  (existsSync(join(process.cwd(), 'tsconfig.base.json')) ? process.cwd() : findRepoRoot(here));
export const ROOT = repoRoot || homedir();

/** Minimal .env loader — does not override values already in the environment. */
function loadEnv(p: string): void {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
export const DATA_DIR =
  process.env.TABZERO_DATA || (repoRoot ? join(repoRoot, '.tabzero') : join(homedir(), '.tabzero'));
mkdirSync(DATA_DIR, { recursive: true });

// Where the .env lives: dev reads <repo>/.env (git-ignored, convenient); an installed copy reads
// <DATA_DIR>/.env so `tabzero key` has a stable home for it. Loaded before any env-derived config below.
export const ENV_PATH = repoRoot ? join(repoRoot, '.env') : join(DATA_DIR, '.env');
loadEnv(ENV_PATH);

export const DB_PATH = process.env.TABZERO_DB || join(DATA_DIR, 'tabzero.db');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.TABZERO_PORT || 8787);
export const TOKEN = process.env.TABZERO_TOKEN || 'tabzero-dev';

// Engram (Weaviate) — reconciled memory layer
export const ENGRAM_API_KEY = process.env.ENGRAM_API_KEY || '';
export const ENGRAM_BASE = process.env.ENGRAM_BASE || 'https://api.engram.weaviate.io/v1';
export const ENGRAM_ENABLED = ENGRAM_API_KEY.length > 0;
export const TRAIL_TOPIC = process.env.TABZERO_TRAIL_TOPIC || 'TrailSummary';

// LLM — OpenRouter preferred, else local `claude -p`, else heuristic.
// Both defaults are deliberately cheap/fast models — all tasks here (naming, 3-sentence recaps,
// one-word categorization) are easy, so there's no reason to reach for a frontier model.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
export const CLAUDE_MODEL = process.env.TABZERO_CLAUDE_MODEL || 'haiku';

// Trail-engine tuning
export const ASSIGN_THRESHOLD = 0.26; // min lexical cosine to join an existing trail
export const OPENER_BONUS = 0.6; // link-spawned tab almost always belongs to the opener's trail
export const RECENCY_WINDOW_MS = 30 * 60 * 1000;
export const RECENCY_BONUS = 0.15;
export const DOMAIN_BONUS = 0.1;
export const MIN_TRAIL_PAGES = 2; // pages needed to graduate forming -> live
export const DECAY_HALFLIFE_DAYS = 7;
export const DORMANT_AFTER_DAYS = 3;
export const ARCHIVE_AFTER_DAYS = 30;

// Categories are a *growable* vocabulary: seeded from the fixed taxonomy, the LLM reuses an existing
// one where it can and mints a new key only when nothing fits. This is the saturation backstop — a
// high ceiling so genuinely-new life-areas can still appear early, while the reuse bias + lexical
// novelty gate keep the effective set small. Once here, new-category creation is effectively frozen.
export const MAX_CATEGORIES = 20;

// Enrichment scheduling — decouple *when a trail is eligible* from *how often loops wake*.
// The settle gate is the keystone: an actively-growing trail is re-dirtied on every navigation,
// so we only spend an LLM/Engram call once it has been quiet for a beat. This kills the churn
// where a trail was re-labelled/re-pushed on every partial state, without hurting responsiveness
// (the provisional label shows instantly; only the polished version waits for the settle).
export const TRAIL_SETTLE_MS = 25 * 1000; // a trail must be quiet this long before LLM/Engram touch it
export const ENGRAM_MIN_REPUSH_MS = 10 * 60 * 1000; // background loop won't re-push the same trail faster than this (protects the free-tier 1k runs/mo)
export const ENRICH_INTERVAL_MS = 20 * 1000; // base cadence for the merged label+recap pass
export const ENGRAM_INTERVAL_MS = 90 * 1000; // base cadence for the Engram flush
export const IDLE_BACKOFF_MAX_MS = 5 * 60 * 1000; // cap the exponential backoff when the browser is quiet
