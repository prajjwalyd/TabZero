// URL canonicalization + cheap lexical vectors — the embedding-free backbone of trail clustering.

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'igshid',
  'yclid',
  'wickedid',
  'oly_anon_id',
  'oly_enc_id',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'spm',
  'scm',
  'from',
  'source',
]);

/**
 * Words that name the SITE rather than the subject.
 *
 * Kept separate from STOP because the reason is different: these are not filler, they are real words
 * that happen to describe where a page lives. `tokenize` mixes the domain and the URL path into the same
 * bag as the title, so "this is a Wikipedia page" arrives up to three times — from `en.wikipedia.org`,
 * from the `/wiki/` path, and from the `- Wikipedia` title suffix — and lands as topical evidence.
 *
 * MEASURED: a cricket article joined a Spider-Man trail on `wiki` + `wikipedia` alone, with no other
 * word in common. Raw cosine 0.2265 (under the 0.26 threshold), which the recency bonus then carried
 * over the line. Site identity is not lost by removing it here: trailDomains, topDomain and the category
 * heuristic all read the domain directly.
 *
 * Note this is NOT a frequency problem and document frequency would not have found it — `wiki` appears
 * in ~3% of a real 123-page corpus, which looks informative, while genuinely topical words like
 * `claude` (16%) and `github` (13%) look like boilerplate by that measure.
 */
const SITE_WORDS = ['wiki', 'wikipedia'];

const STOP = new Set([
  ...SITE_WORDS,
  'the',
  'and',
  'for',
  'you',
  'your',
  'are',
  'with',
  'this',
  'that',
  'from',
  'how',
  'what',
  'why',
  'when',
  'who',
  'has',
  'have',
  'was',
  'were',
  'not',
  'but',
  'all',
  'can',
  'get',
  'out',
  'our',
  'his',
  'her',
  'its',
  'they',
  'them',
  'their',
  'about',
  'into',
  'over',
  'com',
  'www',
  'http',
  'https',
  'html',
  'php',
  'org',
  'net',
  'new',
  'top',
  'best',
  'via',
  'home',
  'page',
  'search',
  'google',
  'results',
  'more',
  'here',
  'now',
  'one',
  'two',
  'use',
]);

export interface Canon {
  canonical: string;
  domain: string;
}

/** Returns null for anything that isn't a real http(s) page (chrome://, about:, blank, etc.). */
export function canonicalize(raw: string | null | undefined): Canon | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!u.hostname || u.hostname === 'newtab') return null;
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  // Strip the trailing slash from the PATH, not just the end of the serialized URL: with a query
  // present the slash isn't last (`/p/?a=1`), so a string-level strip misses it and `/p/?a=1` would
  // dedupe apart from `/p?a=1` — splitting one page into two rows and halving its visit count.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  let s = u.toString();
  if (s.endsWith('?')) s = s.slice(0, -1);
  if (s.endsWith('/')) s = s.slice(0, -1); // bare origin: https://example.com/ -> https://example.com
  return { canonical: s, domain: u.hostname };
}

/** Bag of meaningful tokens from a page's title + domain + path words (+ optional meta text). */
export function tokenize(title: string, canon: Canon, extra = ''): string[] {
  let pathWords = '';
  try {
    pathWords = decodeURIComponent(new URL(canon.canonical).pathname).replace(/[-_/.]/g, ' ');
  } catch {
    /* ignore */
  }
  const domainWords = canon.domain.replace(/\.[a-z]+$/, '').replace(/\./g, ' ');
  const text = `${title || ''} ${domainWords} ${pathWords} ${extra || ''}`.toLowerCase();
  const words = text.match(/[a-z][a-z0-9]{2,}/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 40) break;
  }
  return out;
}

export type Vec = Record<string, number>;

export function bag(tokens: string[]): Vec {
  const v: Vec = {};
  for (const t of tokens) v[t] = (v[t] || 0) + 1;
  return v;
}

export function addInto(target: Vec, tokens: string[]): void {
  for (const t of tokens) target[t] = (target[t] || 0) + 1;
}

export function cosine(a: Vec, b: Vec): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (const k in a) {
    na += a[k] * a[k];
    const bv = b[k];
    if (bv) dot += a[k] * bv;
  }
  for (const k in b) nb += b[k] * b[k];
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Top-n tokens by weight — used for provisional labels + Engram content. */
export function topTokens(v: Vec, n: number): string[] {
  return Object.entries(v)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/** Instant, LLM-free label for a freshly-formed trail (upgraded later by the enrichment pass). */
export function provisionalLabel(tokens: string[], domain: string | null): string {
  const t = tokens.filter(Boolean).slice(0, 3);
  if (t.length) {
    const s = t.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return domain ? domain.replace(/\.[a-z]+$/, '') : 'New trail';
}
