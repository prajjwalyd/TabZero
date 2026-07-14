// Offline trail categorization: score a trail's domains + lexical tokens against a small
// taxonomy so the UI can group "train tickets" apart from "docs" apart from "social".
// No LLM, no network — deterministic and instant.

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

/** Display order + human labels. Any key not listed falls through to 'general'. */
export const CATEGORY_ORDER = ['dev', 'learning', 'news', 'social', 'media', 'shopping', 'travel', 'finance', 'work', 'projects', 'general'];
export const CATEGORY_LABEL: Record<string, string> = {
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

export const CATEGORY_KEYS = CATEGORY_ORDER;

/** The taxonomy rendered for an LLM prompt: `dev (Code & Docs), learning (Learning & Research), …`. */
export const CATEGORY_PROMPT_LIST = CATEGORY_ORDER.map((k) => `${k} (${CATEGORY_LABEL[k]})`).join(', ');

/** Coerce free-form LLM output to a valid category key, or null if it names none. */
export function coerceCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const w of words) if (CATEGORY_KEYS.includes(w)) return w;
  return null;
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
