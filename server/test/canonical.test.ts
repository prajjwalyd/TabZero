// canonical.ts is the embedding-free backbone of trail clustering and imports nothing else, so it
// tests cleanly with no DB or network. These lock the behaviour the pipeline depends on: two URLs
// that differ only in tracking junk MUST canonicalize identically (or the same page splits into two
// rows and dedup silently breaks), and cosine must stay in [0,1] with no NaN on empty vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, tokenize, bag, cosine } from '../src/capture/canonical.ts';

test('canonicalize strips tracking params, hash, www, and trailing slash', () => {
  const a = canonicalize('https://www.Example.com/Docs/Guide/?utm_source=x&gclid=y&b=2&a=1#frag');
  assert.equal(a?.domain, 'example.com');
  assert.equal(a?.canonical, 'https://example.com/Docs/Guide?a=1&b=2');
});

test('canonicalize is stable across tracking-only differences (dedup depends on this)', () => {
  const clean = canonicalize('https://example.com/p?id=7');
  for (const noisy of [
    'https://example.com/p?id=7&utm_campaign=spring',
    'https://www.example.com/p?id=7&fbclid=abc#top',
    'https://example.com/p?utm_medium=email&id=7&ref=news',
  ]) {
    assert.equal(canonicalize(noisy)?.canonical, clean?.canonical, noisy);
  }
});

test('a trailing slash before a query still dedupes (regression: string-level strip missed it)', () => {
  assert.equal(
    canonicalize('https://example.com/p/?a=1')?.canonical,
    canonicalize('https://example.com/p?a=1')?.canonical,
  );
  // the bare-origin case must keep collapsing to a slash-less form
  assert.equal(canonicalize('https://example.com/')?.canonical, 'https://example.com');
  assert.equal(canonicalize('https://example.com/p/')?.canonical, 'https://example.com/p');
});

test('canonicalize rejects non-http(s) and junk', () => {
  for (const bad of [
    null,
    undefined,
    '',
    'not a url',
    'chrome://extensions',
    'about:blank',
    'file:///tmp/x.html',
    'javascript:alert(1)',
    'http://newtab/',
  ]) {
    assert.equal(canonicalize(bad as string | null), null, String(bad));
  }
});

test('tokenize drops stopwords/short words and dedupes, capped at 40', () => {
  const c = canonicalize('https://developer.mozilla.org/en-US/docs/Web/API/fetch')!;
  const toks = tokenize('How to use the Fetch API — the fetch API guide', c);
  assert.ok(toks.includes('fetch'));
  assert.ok(toks.includes('api'));
  assert.ok(!toks.includes('the'), 'stopword leaked');
  assert.ok(!toks.includes('how'), 'stopword leaked');
  assert.equal(new Set(toks).size, toks.length, 'duplicate tokens');

  // exactly 40, not "at most 40" — the loose bound also passed when tokenize returned nothing
  const many = tokenize(Array.from({ length: 80 }, (_, i) => `wordy${i}`).join(' '), c);
  assert.equal(many.length, 40);
});

test('cosine: identical = 1, disjoint = 0, empty = 0 (never NaN)', () => {
  const a = bag(['gpu', 'pricing', 'gpu']);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.equal(cosine(a, bag(['sourdough'])), 0);
  assert.equal(cosine({}, a), 0);
  assert.equal(cosine(a, {}), 0);
  assert.ok(!Number.isNaN(cosine({}, {})));

  const partial = cosine(a, bag(['gpu', 'benchmark']));
  assert.ok(partial > 0 && partial < 1, `expected (0,1), got ${partial}`);
});

// Site identity is not topical evidence.
//
// A real merge from the live database: a cricket article joined a Spider-Man comics trail. The two pages
// shared exactly two tokens — `wiki` from the URL path and `wikipedia` from the domain and the title
// suffix — which is one fact ("this is a Wikipedia page") arriving three ways. That was worth cosine
// 0.2265, just under the 0.26 assign threshold, and the recency bonus carried it over.
//
// Document frequency would not have caught it: `wiki` appears in ~3% of a real 123-page corpus, so it
// looks informative, while `claude` at 16% looks like boilerplate. It needs a named list, not a
// statistic.
const SPIDER_WIKI = {
  title: 'Spider-Man: Brand New Day - Wikipedia',
  url: 'https://en.wikipedia.org/wiki/Spider-Man:_Brand_New_Day',
};
const SPIDER_SERP = {
  title: 'spiderman brand new day - Google Search',
  url: 'https://www.google.com/search?q=spiderman+brand+new+day',
};
const CRICKET_WIKI = {
  title: 'New Zealand cricket team in India in 2025–26 - Wikipedia',
  url: 'https://en.wikipedia.org/wiki/New_Zealand_cricket_team_in_India_in_2025%E2%80%9326',
};
const toks = (p: { title: string; url: string }) => tokenize(p.title, canonicalize(p.url)!);
const ASSIGN_THRESHOLD = 0.26; // mirrors cfg; importing config.ts here would open the database

test('two unrelated Wikipedia pages share no tokens at all', () => {
  const a = toks(SPIDER_WIKI);
  const b = toks(CRICKET_WIKI);
  const shared = a.filter((w) => b.includes(w));
  assert.deepEqual(shared, [], `nothing topical is in common, but got: ${shared.join(', ')}`);
  assert.ok(!a.includes('wikipedia') && !a.includes('wiki'), 'the site name is not a token');
});

test('the cricket page cannot reach the Spider-Man trail on lexical similarity', () => {
  const centroid = bag([...toks(SPIDER_WIKI), ...toks(SPIDER_SERP)]);
  const score = cosine(bag(toks(CRICKET_WIKI)), centroid);
  assert.ok(
    score < ASSIGN_THRESHOLD,
    `scored ${score.toFixed(4)}, which is at or above the ${ASSIGN_THRESHOLD} threshold`,
  );
  // Not just under the bar — nowhere near it, so the +0.15 recency bonus cannot carry it either.
  assert.ok(score < ASSIGN_THRESHOLD - 0.15, `${score.toFixed(4)} is still within one recency bonus`);
});

test('...but two genuinely related Wikipedia pages still cluster', () => {
  // The positive control. Without it the test above could pass by making Wikipedia pages match nothing,
  // which would fragment every trail built from an encyclopaedia.
  const other = {
    title: 'Spider-Man: One More Day - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Spider-Man:_One_More_Day',
  };
  const score = cosine(bag(toks(other)), bag([...toks(SPIDER_WIKI), ...toks(SPIDER_SERP)]));
  assert.ok(score >= ASSIGN_THRESHOLD, `related pages must still join: scored ${score.toFixed(4)}`);
});
