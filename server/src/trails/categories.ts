// Trail categorization. Two layers:
//   1. categorize() — an offline heuristic (domains + tokens -> one of the SEED keys). Deterministic,
//      instant, network-free. It's the cold-start and the fallback, and only ever emits seed keys.
//   2. a *growable* vocabulary in the `categories` table, seeded from the fixed taxonomy below. The
//      LLM (in labelTrail) reuses an existing key where it can and mints a new one only when a trail
//      fits nothing — resolveCategory() enforces that reuse bias with a lexical novelty gate + ceiling.
import { db } from '../core/db.js';
import * as cfg from '../core/config.js';

interface CategoryDef {
  key: string;
  domains?: string[];      // exact host or any subdomain of these
  domainSubstr?: string[]; // host contains this fragment
  kw?: string[];           // trail tokens that signal this category
}

const CATS: CategoryDef[] = [
  {
    key: 'dev',
    domains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'stackexchange.com', 'npmjs.com',
      'pypi.org', 'developer.mozilla.org', 'readthedocs.io', 'huggingface.co', 'vercel.com',
      'netlify.com', 'kubernetes.io', 'postgresql.org', 'rust-lang.org', 'weaviate.io'],
    domainSubstr: ['docs.', 'developer.', 'api.', 'devcenter.'],
    kw: ['api', 'sdk', 'npm', 'python', 'javascript', 'typescript', 'react', 'code', 'function',
      'error', 'install', 'config', 'database', 'server', 'git', 'deploy', 'endpoint', 'query',
      'schema', 'debug', 'compiler', 'index', 'postgres', 'docker', 'kubernetes', 'embeddings'],
  },
  {
    key: 'travel',
    domains: ['booking.com', 'airbnb.com', 'expedia.com', 'kayak.com', 'tripadvisor.com',
      'skyscanner.com', 'hotels.com', 'trainline.com', 'omio.com', 'trip.com', 'marriott.com',
      'ryanair.com', 'lufthansa.com', 'united.com', 'rome2rio.com'],
    kw: ['flight', 'flights', 'hotel', 'hostel', 'trip', 'ticket', 'tickets', 'train', 'airport',
      'airline', 'itinerary', 'booking', 'travel', 'vacation', 'airfare', 'departure', 'baggage',
      'lisbon', 'rail', 'metro', 'accommodation'],
  },
  {
    key: 'shopping',
    domains: ['amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'bestbuy.com', 'aliexpress.com',
      'target.com', 'ikea.com', 'newegg.com', 'wayfair.com', 'shopify.com'],
    kw: ['price', 'buy', 'cart', 'deal', 'shipping', 'order', 'discount', 'coupon', 'sale',
      'product', 'checkout', 'refurbished'],
  },
  {
    key: 'social',
    domains: ['twitter.com', 'x.com', 'reddit.com', 'instagram.com', 'facebook.com', 'tiktok.com',
      'linkedin.com', 'threads.net', 'mastodon.social', 'bsky.app'],
    kw: ['post', 'thread', 'comment', 'tweet', 'follow', 'feed', 'subreddit', 'viral', 'dm'],
  },
  {
    key: 'media',
    domains: ['youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv', 'hulu.com', 'disneyplus.com',
      'soundcloud.com', 'vimeo.com', 'primevideo.com', 'max.com'],
    kw: ['video', 'watch', 'episode', 'stream', 'music', 'playlist', 'movie', 'song', 'album',
      'trailer', 'season', 'podcast'],
  },
  {
    key: 'work',
    domains: ['notion.so', 'slack.com', 'linear.app', 'asana.com', 'trello.com', 'figma.com',
      'atlassian.net', 'monday.com', 'clickup.com', 'airtable.com'],
    domainSubstr: ['mail.', 'calendar.', 'drive.'],
    kw: ['meeting', 'calendar', 'roadmap', 'sprint', 'ticket', 'spreadsheet', 'agenda', 'standup',
      'okr', 'planning'],
  },
  {
    key: 'projects',
    domains: ['instructables.com', 'thingiverse.com', 'ikeahackers.net', 'homedepot.com',
      'lowes.com', 'ravelry.com'],
    kw: ['diy', 'build', 'conversion', 'woodworking', 'renovation', 'garden', 'craft', 'homemade',
      'camper', 'workshop', 'restore', 'wiring', 'insulation', 'layout'],
  },
  {
    key: 'news',
    domains: ['nytimes.com', 'bbc.com', 'bbc.co.uk', 'theverge.com', 'techcrunch.com', 'wired.com',
      'medium.com', 'substack.com', 'arstechnica.com', 'bloomberg.com', 'wsj.com', 'theguardian.com',
      'reuters.com', 'hackernews.com', 'news.ycombinator.com'],
    kw: ['news', 'article', 'report', 'breaking', 'opinion', 'analysis', 'story', 'headline'],
  },
  {
    key: 'learning',
    domains: ['coursera.org', 'udemy.com', 'wikipedia.org', 'khanacademy.org', 'edx.org',
      'arxiv.org', 'scholar.google.com', 'freecodecamp.org'],
    kw: ['tutorial', 'guide', 'course', 'learn', 'lesson', 'paper', 'study', 'explained',
      'introduction', 'basics', 'fundamentals', 'beginner'],
  },
  {
    key: 'finance',
    domains: ['coinbase.com', 'binance.com', 'robinhood.com', 'chase.com', 'paypal.com',
      'stripe.com', 'fidelity.com', 'schwab.com'],
    kw: ['invoice', 'tax', 'payment', 'crypto', 'stock', 'bank', 'budget', 'salary', 'billing',
      'portfolio', 'dividend'],
  },
];

/** The seed vocabulary the growable `categories` table is initialized from (seed=1, never GC'd). */
const SEED_ORDER = ['dev', 'learning', 'news', 'social', 'media', 'shopping', 'travel', 'finance', 'work', 'projects', 'general'];
const SEED_LABEL: Record<string, string> = {
  dev: 'Code & Docs',
  learning: 'Learning & Research',
  news: 'News & Reading',
  social: 'Social',
  media: 'Entertainment',
  shopping: 'Shopping',
  travel: 'Travel',
  finance: 'Finance',
  work: 'Work & Productivity',
  projects: 'Projects & DIY',
  general: 'Other',
};

// ---------- growable, table-backed vocabulary ----------

// In-process cache of the vocabulary, lazily loaded and refreshed on mint/consolidate. The daemon
// owns all writes; every other reader goes through it over HTTP, so cross-process staleness of a
// freshly-minted key is cosmetic (it just isn't offered as a filter until that process restarts).
let keyCache: Set<string> | null = null;
let labelCache: Map<string, string> | null = null;

function seedIfEmpty(): void {
  const n = (db.prepare('SELECT COUNT(*) c FROM categories').get() as { c: number }).c;
  if (n > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO categories (key, label, seed, created) VALUES (?, ?, 1, ?)');
  const now = Date.now();
  for (const k of SEED_ORDER) ins.run(k, SEED_LABEL[k], now);
}

function refresh(): void {
  const rows = db.prepare('SELECT key, label FROM categories').all() as { key: string; label: string }[];
  keyCache = new Set(rows.map((r) => r.key));
  labelCache = new Map(rows.map((r) => [r.key, r.label]));
}

function ensure(): void {
  if (keyCache) return;
  seedIfEmpty();
  refresh();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

export function knownCategory(key: string | null | undefined): boolean {
  ensure();
  return !!key && keyCache!.has(key);
}

/** The live vocabulary rendered for an LLM prompt: `dev (Code & Docs), learning (Learning & Research), …`. */
export function categoryPromptList(): string {
  ensure();
  return [...labelCache!.entries()].map(([k, l]) => `${k} (${l})`).join(', ');
}

const FILLER = new Set(['and', 'the', 'of', 'my', 'for', 'stuff', 'things', 'misc', 'other', 'various', 'random', 'general']);

/** Normalize an LLM-proposed category into a canonical key: 1-2 significant tokens, lowercase, hyphenated. */
function normalizeKey(raw: string): string {
  const toks = raw.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !FILLER.has(t));
  return toks.slice(0, 2).join('-');
}

/** Capped Levenshtein — returns 3 (our reject threshold) once the distance can't matter. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Nearest existing key that `key` should fold into (shared significant token, substring, or
 * edit-distance <= 2), or null if genuinely distinct. This is the anti-fragmentation gate: it
 * collapses morphological drift (code/coding, doc/docs, travel/traveling). Pure synonyms
 * (trips vs travel) it can't catch — that's what the reuse-biased prompt is for.
 */
function nearestExisting(key: string, exclude: string | null = null): string | null {
  ensure();
  const kt = key.split('-').filter((t) => t.length >= 4);
  let best: { k: string; d: number } | null = null;
  for (const k of keyCache!) {
    if (k === exclude) continue;
    if (k === key) return k;
    const okt = new Set(k.split('-'));
    if (kt.some((t) => okt.has(t))) return k;
    if (key.length >= 4 && k.includes(key)) return k;
    if (k.length >= 4 && key.includes(k)) return k;
    const d = editDistance(key, k);
    if (d <= 2 && (!best || d < best.d)) best = { k, d };
  }
  return best?.k ?? null;
}

/**
 * Resolve an LLM-proposed category to a stored key — reusing an existing one wherever possible and
 * minting a new one only when the trail genuinely fits nothing (and we're under the ceiling).
 * Returns null when it can't decide, so labelTrail keeps whatever the heuristic gave.
 */
export function resolveCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  ensure();
  // Fast path: the model named an existing key outright.
  const direct = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).find((w) => keyCache!.has(w));
  if (direct) return direct;

  const key = normalizeKey(raw);
  if (!key) return null;
  if (keyCache!.has(key)) return key;

  const near = nearestExisting(key);
  if (near) return near; // fold into the existing category

  // Genuinely novel. Mint it — unless we've saturated, in which case fall back to the heuristic.
  if (keyCache!.size >= cfg.MAX_CATEGORIES) return null;
  db.prepare('INSERT OR IGNORE INTO categories (key, label, seed, created) VALUES (?, ?, 0, ?)')
    .run(key, titleCase(key.replace(/-/g, ' ')), Date.now());
  refresh();
  return key;
}

/**
 * Fold away near-dead minted categories: any non-seed key used by <=1 trail that has a lexically
 * near neighbour gets its trails reassigned and the key deleted. Cheap self-healing for strays that
 * slipped past the mint-time gate. Seed keys are never removed. Returns the number merged.
 */
export function consolidateCategories(): number {
  ensure();
  const usage = new Map<string, number>();
  for (const r of db.prepare(
    'SELECT category, COUNT(*) c FROM trails WHERE category IS NOT NULL GROUP BY category',
  ).all() as { category: string; c: number }[]) {
    usage.set(r.category, r.c);
  }
  const cats = db.prepare('SELECT key, seed FROM categories').all() as { key: string; seed: number }[];
  let merged = 0;
  for (const c of cats) {
    if (c.seed) continue;
    if ((usage.get(c.key) ?? 0) > 1) continue;
    const target = nearestExisting(c.key, c.key);
    if (!target) continue;
    db.prepare('UPDATE trails SET category = ? WHERE category = ?').run(target, c.key);
    db.prepare('DELETE FROM categories WHERE key = ?').run(c.key);
    merged++;
  }
  if (merged) refresh();
  return merged;
}

/** Best-matching category key for a trail; 'general' when nothing scores. */
export function categorize(domains: string[], tokens: string[]): string {
  const dom = domains.map((d) => d.toLowerCase());
  const tok = new Set(tokens.map((t) => t.toLowerCase()));
  let best = { key: 'general', score: 0 };
  for (const c of CATS) {
    let s = 0;
    for (const d of dom) {
      if (c.domains?.some((cd) => d === cd || d.endsWith('.' + cd))) s += 3;
      if (c.domainSubstr?.some((sub) => d.includes(sub))) s += 2;
    }
    for (const k of c.kw ?? []) if (tok.has(k)) s += 1;
    if (s > best.score) best = { key: c.key, score: s };
  }
  return best.key;
}
