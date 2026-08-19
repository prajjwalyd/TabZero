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
