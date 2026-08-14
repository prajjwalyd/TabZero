// The three behaviours Tab Zero actually sells, driven through the REAL ingestion pipeline rather
// than mocks: pages cluster into the right trail, a re-delivered batch can't corrupt visit counts,
// and resurrection reopens the tabs you had open together rather than everything a trail ever touched.
//
// pipeline.ts pulls in the SQLite handle on import, so the data dir is redirected to a throwaway
// directory BEFORE that import lands and the real .tabzero is never touched. No LLM or Engram call is
// reachable from any of this — enrichment is a separate, scheduled path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-pipe-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = ''; // keep Engram unreachable even if a real key sits in .env

const { ingestEvent } = await import('../src/capture/pipeline.ts');
const { db } = await import('../src/core/db.ts');
const { resurrectUrls } = await import('../src/trails/trails.ts');

after(() => rmSync(tmp, { recursive: true, force: true }));

const T0 = 1_800_000_000_000; // fixed clock; the pipeline never reads wall time for these paths

const nav = (tabId: number, url: string, title: string, ts: number, openerTabId?: number) =>
  ingestEvent({ ts, type: 'navigate', tabId, windowId: 1, url, title, openerTabId });

const trailOf = (canonical: string): string | null =>
  (db.prepare('SELECT trail_id FROM pages WHERE canonical_url = ?').get(canonical) as { trail_id: string | null }).trail_id;
const visitsOf = (canonical: string): number =>
  (db.prepare('SELECT visit_count FROM pages WHERE canonical_url = ?').get(canonical) as { visit_count: number }).visit_count;

/**
 * The two assignment signals, isolated so each assertion can only pass for the right reason.
 *
 * The opener-graph claim is a CONTROLLED comparison: the Rust blog post and the sourdough recipe both
 * score cosine 0.0000 against this trail's centroid (measured — the centroid is
 * index/types/postgresql/docs/current/indexes/btree/internals, and neither page shares a token). Even
 * with the +0.15 recency bonus they sit under the 0.26 threshold, so similarity cannot explain either
 * one joining. The only difference between them is that one was link-opened from a tab in the trail.
 * An earlier version of this test used a page scoring 0.2085, which joined lexically anyway and made
 * the opener assertion vacuous — deleting the opener branch entirely left the test green.
 */
test('clustering: opener graph and lexical similarity each join a page, unrelated content does not', () => {
  // A trail forms from two Postgres-indexing pages.
  nav(11, 'https://postgresql.org/docs/current/indexes-types', 'Index Types and When To Use Them', T0);
  nav(11, 'https://postgresql.org/docs/current/indexes-btree', 'BTree Index Internals', T0 + 60_000);

  // Link-opened from tab 11, and textually unrelated (cosine 0.0000) — only the opener graph can join it.
  nav(12, 'https://blog.example.org/2026/why-we-rewrote-our-scheduler-in-rust', 'Why We Rewrote Our Scheduler In Rust', T0 + 120_000, 11);

  // No opener, but overlapping vocabulary — must join on similarity alone.
  nav(13, 'https://postgresql.org/docs/current/indexes-expressional', 'Expression Index Types', T0 + 180_000);

  // The control: same cosine 0.0000 as the Rust post, but no opener — must NOT be swept in.
  nav(14, 'https://allrecipes.com/recipe/sourdough-starter', 'Sourdough Starter Feeding Schedule', T0 + 240_000);

  const trail = trailOf('https://postgresql.org/docs/current/indexes-types');
  assert.ok(trail, 'first page should own a trail');
  assert.equal(trailOf('https://postgresql.org/docs/current/indexes-btree'), trail, 'same-site sibling');
  assert.equal(trailOf('https://blog.example.org/2026/why-we-rewrote-our-scheduler-in-rust'), trail,
    'a link-opened tab must follow its opener even with zero lexical overlap');
  assert.equal(trailOf('https://postgresql.org/docs/current/indexes-expressional'), trail, 'lexical similarity should join');
  assert.notEqual(trailOf('https://allrecipes.com/recipe/sourdough-starter'), trail,
    'same zero similarity, no opener — must start its own trail');

  const t = db.prepare('SELECT page_count FROM trails WHERE id = ?').get(trail) as { page_count: number };
  assert.equal(t.page_count, 4, 'trail should hold exactly the four related pages');
});

test('a re-delivered batch cannot inflate visit_count (regression: one real visit read as 436)', () => {
  const url = 'https://accounts.example.com/v3/signin/identifier?continue=https%3A%2F%2Fx';
  const canonical = 'https://accounts.example.com/v3/signin/identifier?continue=https%3A%2F%2Fx';
  const tabId = 900;

  // The exact event shape the real log showed: one page load emits several ticks, then the tab closes.
  const cycle = () => {
    ingestEvent({ ts: T0, type: 'open', tabId, windowId: 2 });
    ingestEvent({ ts: T0, type: 'activate', tabId, windowId: 2 });
    nav(tabId, url, 'Sign in', T0 + 1);
    ingestEvent({ ts: T0 + 2, type: 'meta', tabId, windowId: 2, url, title: 'Sign in', description: null });
    nav(tabId, url, 'Sign in', T0 + 3);
    ingestEvent({ ts: T0 + 7000, type: 'close', tabId, windowId: 2 });
  };

  cycle();
  assert.equal(visitsOf(canonical), 1, 'one real visit, several ticks');

  // The extension's queue bug re-sent the same batch with its ORIGINAL timestamps, doubling each
  // retry cycle. Every replayed `close` clears the tab's last-URL memory, so without the timestamp
  // guard the following `navigate` looks like a fresh revisit and bumps the count once per replay.
  for (let i = 0; i < 25; i++) cycle();
  assert.equal(visitsOf(canonical), 1, 'replayed events must never count as new visits');

  // A genuinely later return to the page still counts.
  nav(tabId, url, 'Sign in', T0 + 86_400_000);
  assert.equal(visitsOf(canonical), 2, 'a real later revisit must still be counted');
});

test('resurrection prefers the checkpoint working set over the full trail history', () => {
  // Three pages in one trail; only two of them were open at "tab zero".
  const a = 'https://vanlife.example.com/electrical/solar-sizing';
  const b = 'https://vanlife.example.com/electrical/battery-bank';
  const c = 'https://vanlife.example.com/electrical/inverter-choice';
  nav(21, a, 'Solar Panel Sizing For Van Electrical', T0);
  nav(21, b, 'Battery Bank Sizing For Van Electrical', T0 + 10_000);
  nav(21, c, 'Inverter Choice For Van Electrical', T0 + 20_000);

  const trail = trailOf(a)!;
  assert.equal(trailOf(c), trail, 'all three should share one trail');

  // Record a checkpoint holding only a and c — the tabs actually open together.
  const cp = Number(db.prepare('INSERT INTO checkpoints (ts, closed_count) VALUES (?, ?)').run(T0 + 30_000, 2).lastInsertRowid);
  const ins = db.prepare('INSERT INTO checkpoint_pages (checkpoint_id, canonical_url, trail_id) VALUES (?, ?, ?)');
  ins.run(cp, a, trail);
  ins.run(cp, c, trail);

  assert.deepEqual(resurrectUrls(trail), [a, c], 'should reopen the working set, in last_seen order');

  // A trail that was never checkpointed has nothing better than its own history.
  const other = trailOf('https://allrecipes.com/recipe/sourdough-starter')!;
  assert.deepEqual(resurrectUrls(other), ['https://allrecipes.com/recipe/sourdough-starter']);
});
