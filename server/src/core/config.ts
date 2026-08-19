import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
// In the repo (dev): the root is the repo THIS FILE lives in, and data sits in <repo>/.tabzero.
// Installed/packaged (npx, global): no repo marker above this file, so data lives in ~/.tabzero and
// persists across npm-cache eviction.
//
// Deliberately not keyed on process.cwd(), which it used to be as well. An installed copy run from
// inside a clone — `npx github:prajjwalyd/TabZero` in your checkout, which is exactly how you'd try it
// — then adopted that clone's database and .env, while the same `tabzero` run from anywhere else used
// ~/.tabzero: one install silently reading two different histories, one of them empty, with no way to
// tell which. Where the code lives is the only answer that doesn't move under you. TABZERO_ROOT still
// overrides it, which is how the tests get a private root.
const repoRoot = process.env.TABZERO_ROOT || findRepoRoot(here);

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
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/**
 * Clamp a data file to owner-only. Everything in DATA_DIR is sensitive — the DB is a complete
 * browsing history, the -wal holds the most recent writes of one, and .env holds the Engram API key —
 * but the default umask (022) creates all of them world-readable. Locking down only the token file was
 * pointless: another local account could skip the token entirely and read tabzero.db directly.
 *
 * mkdir's `mode` is masked by umask and does nothing on an existing directory, so chmod explicitly, on
 * every start, and never throw — a permission we cannot set is not a reason to fail to boot.
 */
export function hardenPath(p: string): void {
  try {
    if (existsSync(p)) chmodSync(p, statSync(p).isDirectory() ? 0o700 : 0o600);
  } catch {
    /* best effort */
  }
}
hardenPath(DATA_DIR);

// Where the .env lives: dev reads <repo>/.env (git-ignored, convenient); an installed copy reads
// <DATA_DIR>/.env so `tabzero key` has a stable home for it. Loaded before any env-derived config below.
export const ENV_PATH = repoRoot ? join(repoRoot, '.env') : join(DATA_DIR, '.env');
hardenPath(ENV_PATH); // holds ENGRAM_API_KEY / OPENROUTER_API_KEY — never world-readable
loadEnv(ENV_PATH);

export const DB_PATH = process.env.TABZERO_DB || join(DATA_DIR, 'tabzero.db');

// Explicit user/Engram scope. Set to pin a fixed identity (reuse across resets/machines) or to switch
// to a clean slate. When unset, a stable random id is generated once and stored in the local DB.
export const USER_ID = (process.env.TABZERO_USER_ID || '').trim();

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.TABZERO_PORT || 8787);

/**
 * Shared secret between the daemon and the extension. Minted randomly on first run and persisted
 * beside the DB (0600) rather than shipped as a publicly-known constant — otherwise every install
 * would share one token and anything on the machine could read your whole browsing history by
 * guessing it. TABZERO_TOKEN pins it explicitly.
 *
 * The extension learns it from /health. That is safe because of TWO things in daemon/http.ts, and it
 * needs both: no CORS headers (a cross-origin page can send the request but not read the reply) AND a
 * Host allowlist (without which a page on a domain re-resolved to 127.0.0.1 reaches us as *same*
 * origin, where CORS is never consulted and the reply — token included — is handed straight to it).
 */
function loadToken(): string {
  const pinned = (process.env.TABZERO_TOKEN || '').trim();
  if (pinned) return pinned;
  const p = join(DATA_DIR, 'token');
  if (existsSync(p)) {
    const t = readFileSync(p, 'utf8').trim();
    if (t) return t;
  }
  const t = randomUUID();
  writeFileSync(p, t + '\n', { mode: 0o600 });
  return t;
}
export const TOKEN = loadToken();

// Engram (Weaviate) — reconciled memory layer
export const ENGRAM_API_KEY = process.env.ENGRAM_API_KEY || '';

/**
 * Refuse to talk to Engram over plaintext. Every request carries `Authorization: Bearer <key>` plus
 * page titles and descriptions, so an `http://` base would put the API key AND the browsing signal on
 * the wire in the clear. The default is https, but ENGRAM_BASE is an env var and a typo'd or
 * copy-pasted `http://` would silently downgrade every push — so fail loudly at boot instead of
 * exfiltrating quietly. Loopback is exempted so a local mock/proxy stays usable in development.
 */
function requireSecureBase(base: string): string {
  if (!ENGRAM_API_KEY) return base; // Engram off — nothing is sent, nothing to protect
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`ENGRAM_BASE is not a valid URL: ${base}`);
  }
  const loopback =
    u.hostname === '127.0.0.1' ||
    u.hostname === 'localhost' ||
    u.hostname === '[::1]' ||
    u.hostname === '::1';
  if (u.protocol !== 'https:' && !loopback) {
    throw new Error(
      `ENGRAM_BASE must use https:// (got ${u.protocol}//${u.hostname}). Every Engram request carries ` +
        'your API key and your page titles; plaintext would expose both. Loopback is the only exception.',
    );
  }
  return base;
}

export const ENGRAM_BASE = requireSecureBase(process.env.ENGRAM_BASE || 'https://api.engram.weaviate.io/v1');
export const ENGRAM_ENABLED = ENGRAM_API_KEY.length > 0;
export const ENGRAM_TIMEOUT_MS = Number(process.env.TABZERO_ENGRAM_TIMEOUT_MS || 15000); // hard cap so a slow/unreachable endpoint can't hang the daemon or seed
export const DEBUG = process.env.TABZERO_DEBUG === '1'; // set TABZERO_DEBUG=1 for verbose Engram retrieval logs
export const TRAIL_TOPIC = process.env.TABZERO_TRAIL_TOPIC || 'TrailSummary';
// User-scoped topic that accumulates durable cross-trail interests. One trail push can feed both
// this and TrailSummary; lights up fully once the topic exists in the Engram project (local fallback otherwise).
export const INTEREST_TOPIC = process.env.TABZERO_INTEREST_TOPIC || 'ResearchInterest';

// LLM — OpenRouter preferred, else local `claude -p`, else heuristic.
// Both defaults are deliberately cheap/fast models — all tasks here (naming, 3-sentence recaps,
// one-word categorization) are easy, so there's no reason to reach for a frontier model.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
export const CLAUDE_MODEL = process.env.TABZERO_CLAUDE_MODEL || 'haiku';

// Trail-engine tuning
export const ASSIGN_THRESHOLD = 0.26; // min lexical cosine to join an existing trail
export const RECENCY_WINDOW_MS = 30 * 60 * 1000;
export const RECENCY_BONUS = 0.15;
export const MIN_TRAIL_PAGES = 2; // pages needed to graduate forming -> live
export const RESURRECT_MAX_TABS = Number(process.env.TABZERO_RESURRECT_MAX_TABS || 25); // hard cap on tabs a single resurrect may reopen
export const RESURRECT_BOUNCE_DWELL_MS = 5000; // under this dwell a page is a bounce: it loses its seat under the cap to a page you actually read
export const DECAY_HALFLIFE_DAYS = 7;
export const DORMANT_AFTER_DAYS = 3;
export const ARCHIVE_AFTER_DAYS = 30;

// Research interests come from Engram's ResearchInterest topic, whose description carries the
// durability rule and merges near-duplicates. These constants gate only the LOCAL FALLBACK shown when
// Engram is off or hasn't extracted yet: a trail stands in for an interest if it recurs across
// sessions or is a deep investigation, and is still recent. There is deliberately no dwell-only
// branch — a long single sitting is an absorbing afternoon, not a durable interest.
export const INTEREST_MIN_SESSIONS = 2; // recurring: returned across >=2 sessions
export const INTEREST_DEEP_PAGES = 8; // deep: a big single-trail rabbit hole
export const INTEREST_MIN_LIVENESS = 0.5; // recency floor — stale obsessions drop off

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
