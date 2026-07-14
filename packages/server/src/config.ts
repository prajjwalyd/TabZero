import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from a starting dir to find the repo root (marked by PLAN.md / .env). */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'PLAN.md')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT =
  process.env.TABZERO_ROOT ||
  (existsSync(join(process.cwd(), 'PLAN.md')) ? process.cwd() : findRoot(here));

/** Minimal .env loader — does not override values already in the environment. */
function loadEnv(root: string): void {
  const p = join(root, '.env');
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
loadEnv(ROOT);

export const DATA_DIR = process.env.TABZERO_DATA || join(ROOT, '.tabzero');
mkdirSync(DATA_DIR, { recursive: true });
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
