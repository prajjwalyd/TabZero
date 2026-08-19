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
process.env.TABZERO_RESURRECT_MAX_TABS = '5'; // small deterministic cap so the selection assertions below are readable

const { ingestEvent } = await import('../src/capture/pipeline.ts');
const { db } = await import('../src/core/db.ts');
const { resurrectUrls, getTrailDetail } = await import('../src/trails/trails.ts');
const { RESURRECT_MAX_TABS: MAX } = await import('../src/core/config.ts');

after(() => rmSync(tmp, { recursive: true, force: true }));

const T0 = 1_800_000_000_000; // fixed clock; the pipeline never reads wall time for these paths

const nav = (tabId: number, url: string, title: string, ts: number, openerTabId?: number) =>
  ingestEvent({ ts, type: 'navigate', tabId, windowId: 1, url, title, openerTabId });

const trailOf = (canonical: string): string | null =>
  (
    db.prepare('SELECT trail_id FROM pages WHERE canonical_url = ?').get(canonical) as {
      trail_id: string | null;
    }
  ).trail_id;
const visitsOf = (canonical: string): number =>
  (
    db.prepare('SELECT visit_count FROM pages WHERE canonical_url = ?').get(canonical) as {
      visit_count: number;
    }
  ).visit_count;

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
  nav(
    12,
    'https://blog.example.org/2026/why-we-rewrote-our-scheduler-in-rust',
    'Why We Rewrote Our Scheduler In Rust',
    T0 + 120_000,
    11,
  );

  // No opener, but overlapping vocabulary — must join on similarity alone.
  nav(13, 'https://postgresql.org/docs/current/indexes-expressional', 'Expression Index Types', T0 + 180_000);

  // The control: same cosine 0.0000 as the Rust post, but no opener — must NOT be swept in.
  nav(
    14,
    'https://allrecipes.com/recipe/sourdough-starter',
    'Sourdough Starter Feeding Schedule',
    T0 + 240_000,
  );

  const trail = trailOf('https://postgresql.org/docs/current/indexes-types');
  assert.ok(trail, 'first page should own a trail');
  assert.equal(trailOf('https://postgresql.org/docs/current/indexes-btree'), trail, 'same-site sibling');
  assert.equal(
    trailOf('https://blog.example.org/2026/why-we-rewrote-our-scheduler-in-rust'),
    trail,
    'a link-opened tab must follow its opener even with zero lexical overlap',
  );
  assert.equal(
    trailOf('https://postgresql.org/docs/current/indexes-expressional'),
    trail,
    'lexical similarity should join',
  );
  assert.notEqual(
    trailOf('https://allrecipes.com/recipe/sourdough-starter'),
    trail,
    'same zero similarity, no opener — must start its own trail',
  );

  const t = db.prepare('SELECT page_count FROM trails WHERE id = ?').get(trail) as { page_count: number };
  assert.equal(t.page_count, 4, 'trail should hold exactly the four related pages');
});

test('a re-delivered batch cannot inflate visit_count (regression: one real visit read as 436)', () => {
  // The real page was a Google sign-in screen. It cannot be used as the fixture any more, because
  // redact.ts::isSensitiveUrl now refuses to capture auth flows at all — which is a second, independent
  // fix for the same incident. So this is a non-auth analogue with the same token structure; the replay
  // behaviour under test is a property of the timestamp guard, not of the URL.
  const url = 'https://accounts.example.com/v3/profile/identifier?continue=https%3A%2F%2Fx';
  const canonical = 'https://accounts.example.com/v3/profile/identifier?continue=https%3A%2F%2Fx';
  const tabId = 900;

  // The exact event shape the real log showed: one page load emits several ticks, then the tab closes.
  const cycle = () => {
    ingestEvent({ ts: T0, type: 'open', tabId, windowId: 2 });
    ingestEvent({ ts: T0, type: 'activate', tabId, windowId: 2 });
    nav(tabId, url, 'Account profile', T0 + 1);
    ingestEvent({
      ts: T0 + 2,
      type: 'meta',
      tabId,
      windowId: 2,
      url,
      title: 'Account profile',
      description: null,
    });
    nav(tabId, url, 'Account profile', T0 + 3);
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
  nav(tabId, url, 'Account profile', T0 + 86_400_000);
  assert.equal(visitsOf(canonical), 2, 'a real later revisit must still be counted');
});

// The recency bonus is worth 0.15 against a 0.26 threshold, so it decides borderline merges on its
// own. It must only apply when the trail was active BEFORE the incoming page. Out-of-order events
// inside one batch are routine, and an unguarded `ev.ts - last_active < WINDOW` is true for every
// negative delta — which merged a van-electrical page into an unrelated trail on the strength of
// one incidental shared token ("example"), scoring 0.1690 + 0.15.
test('a trail active AFTER an incoming page gets no recency bonus (no backwards merge)', () => {
  // Non-auth analogue of the real fixture (a Google sign-in page), which redact.ts now excludes from
  // capture entirely. Measured cosine against the astronomy page below is 0.1826 — identical to the
  // original — so the +0.15 bonus is still exactly what decides the merge, which is the whole point.
  nav(700, 'https://accounts.example.com/v3/profile/identifier?continue=z', 'Account profile', T0 + 500_000);
  nav(
    700,
    'https://accounts.example.com/v3/profile/identifier?continue=z',
    'Account profile',
    T0 + 86_400_000,
  );
  const other = trailOf('https://accounts.example.com/v3/profile/identifier?continue=z');

  // Older than that trail's last_active, and sharing exactly one incidental token with it ("example"
  // from the domain). Vocabulary is kept disjoint from every other fixture in this file so the
  // assertion can only fail for the reason under test.
  nav(
    701,
    'https://astronomy.example.com/telescopes/collimation-guide',
    'Collimation Guide For Newtonian Telescopes',
    T0 + 400_000,
  );
  assert.notEqual(
    trailOf('https://astronomy.example.com/telescopes/collimation-guide'),
    other,
    'a weak lexical match must not be promoted by a bonus the trail did not earn',
  );
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
  const cp = Number(
    db.prepare('INSERT INTO checkpoints (ts, closed_count) VALUES (?, ?)').run(T0 + 30_000, 2)
      .lastInsertRowid,
  );
  const ins = db.prepare(
    'INSERT INTO checkpoint_pages (checkpoint_id, canonical_url, trail_id) VALUES (?, ?, ?)',
  );
  ins.run(cp, a, trail);
  ins.run(cp, c, trail);

  assert.deepEqual(resurrectUrls(trail), [a, c], 'should reopen the working set, in last_seen order');

  // Resume the trail after that checkpoint without zeroing again. The newer page has to join the
  // reopen set — taking the checkpoint alone would replay a stale snapshot and silently drop it.
  const d = 'https://vanlife.example.com/electrical/fuse-block-layout';
  nav(21, d, 'Fuse Block Layout For Van Electrical', T0 + 40_000);
  assert.equal(trailOf(d), trail, 'the follow-up page should land in the same trail');
  assert.deepEqual(resurrectUrls(trail), [a, c, d], 'checkpoint set UNION anything seen since');
  assert.ok(!resurrectUrls(trail).includes(b), 'a page closed before the checkpoint stays out');

  // A trail that was never checkpointed has nothing better than its own history.
  const other = trailOf('https://allrecipes.com/recipe/sourdough-starter')!;
  assert.deepEqual(resurrectUrls(other), ['https://allrecipes.com/recipe/sourdough-starter']);
});

/**
 * Selection fixtures are written straight to `pages`, not driven through ingestion: what is under test
 * is which rows survive the resurrect cap, and routing 30 pages through the clusterer just to get them
 * into one trail would make the assertion depend on lexical scoring it isn't about.
 */
function seedTrail(id: string, pages: { slug: string; ts: number; dwellMs: number }[]): void {
  db.prepare(
    `INSERT INTO trails (id, label, created, last_active, page_count, session_count)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, id, T0, T0, pages.length);
  const ins = db.prepare(
    `INSERT INTO pages (canonical_url, url, title, domain, first_seen, last_seen, visit_count, total_dwell_ms, trail_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const p of pages) {
    const u = `https://${id}.example.com/${p.slug}`;
    ins.run(u, u, p.slug, `${id}.example.com`, p.ts, p.ts, p.dwellMs, id);
  }
}
const urlIn = (id: string, slug: string) => `https://${id}.example.com/${slug}`;

// A trail nobody ever zeroed still has to be safe to resurrect. Its whole history is all we know, and
// handing that back whole dumps every dead end the user deliberately closed back onto them. So the cap
// PICKS: newest first. The bug this pins was the opposite — `ORDER BY last_seen ASC` with the cap
// applied by the caller's `slice(0, n)` kept the OLDEST n and dropped everything current.
test('an uncheckpointed trail reopens a capped, most-recent slice — not its whole history', () => {
  const n = MAX + 6;
  seedTrail(
    'tcap',
    Array.from({ length: n }, (_, i) => ({ slug: `p${i}`, ts: T0 + i * 1000, dwellMs: 60_000 })),
  );

  const urls = resurrectUrls('tcap');
  assert.equal(urls.length, MAX, `must not hand back all ${n} pages`);
  assert.deepEqual(
    urls,
    Array.from({ length: MAX }, (_, k) => urlIn('tcap', `p${n - MAX + k}`)),
    'the newest pages under the cap, returned oldest-first for reading order',
  );
  assert.ok(!urls.includes(urlIn('tcap', 'p0')), 'the oldest page must not survive the cap');
});

// Recency alone would let a run of one-second bounces evict the page you actually sat and read.
test('under the cap, a page you actually read outranks a newer bounce', () => {
  const read = { slug: 'read', ts: T0, dwellMs: 120_000 }; // oldest, but two minutes of dwell
  const bounces = Array.from({ length: MAX }, (_, i) => ({
    slug: `bounce${i}`,
    ts: T0 + (i + 1) * 1000,
    dwellMs: 900,
  }));
  seedTrail('tbounce', [read, ...bounces]);

  const urls = resurrectUrls('tbounce');
  assert.equal(urls.length, MAX);
  assert.ok(
    urls.includes(urlIn('tbounce', 'read')),
    'the page actually read keeps its seat despite being oldest',
  );
  assert.ok(!urls.includes(urlIn('tbounce', 'bounce0')), 'the oldest bounce is what the cap sheds');
});

/**
 * The contract the popup depends on, and the gap that let the real bug ship: `resurrectUrls` was
 * correct and tested, while the only UI that reopens tabs built its list from `detail.pages` — the full
 * history — so every resurrect ignored the checkpoint working set and the cap alike. Testing the
 * function directly could never catch that. This pins the DETAIL payload instead: the reopen set rides
 * on it, already narrowed, so the fast path a client renders from is the same set the resurrect
 * endpoint returns.
 */
test('trail detail carries the reopen set, narrowed — not just the full page history', async () => {
  seedTrail(
    'tdetail',
    Array.from({ length: MAX + 4 }, (_, i) => ({ slug: `p${i}`, ts: T0 + i * 1000, dwellMs: 60_000 })),
  );

  const d = await getTrailDetail('tdetail');
  assert.ok(d, 'detail should resolve');
  assert.deepEqual(
    d.resurrectUrls,
    resurrectUrls('tdetail'),
    'detail must expose exactly what a resurrect would reopen',
  );
  assert.equal(d.resurrectUrls.length, MAX);
  assert.ok(
    d.pages.length > d.resurrectUrls.length,
    '`pages` is the wider display history: a client that reopens it bypasses the checkpoint logic and the cap',
  );
});

// Deleting a trail has to remove what CONSTITUTES it, not just the trail row. Leaving the pages or the
// event rows behind would make this a cosmetic hide — and worse, a replay of the log would resurrect the
// trail the user asked to be rid of.
test('deleting a trail removes its pages, its events, and its checkpoint membership', async () => {
  const { deleteTrail } = await import('../src/trails/trails.ts');
  const a = 'https://origami.example.net/folds/kabuto-helmet';
  const b = 'https://origami.example.net/folds/kusudama-modular';
  nav(820, a, 'Folding A Kabuto Helmet', T0 + 700_000);
  nav(820, b, 'Kusudama Modular Instructions', T0 + 760_000);
  const id = trailOf(a)!;
  assert.ok(id, 'fixture trail exists');

  // MEASURED, not assumed: fixtures in this file share a synthetic domain space, so a new pair can
  // legitimately cluster into an existing trail (an earlier version of this test used `drysuit-sizing`,
  // which joined the vanlife trail via `sizing` + `example`). What is under test is that delete removes
  // exactly what the trail holds — so read that first and assert against it.
  const pagesBefore = (db.prepare('SELECT COUNT(*) c FROM pages WHERE trail_id = ?').get(id) as { c: number })
    .c;
  const eventsBefore = (
    db
      .prepare(
        'SELECT COUNT(*) c FROM events WHERE canonical_url IN (SELECT canonical_url FROM pages WHERE trail_id = ?)',
      )
      .get(id) as { c: number }
  ).c;
  assert.ok(pagesBefore >= 2, 'the fixture pages landed in one trail');
  assert.ok(eventsBefore > 0, 'its events are in the log to begin with');

  const res = deleteTrail(id)!;
  assert.equal(res.pages, pagesBefore, 'every page the trail held was counted');
  assert.equal(res.events, eventsBefore, 'every matching event row removed');

  const gone = (sql: string) => (db.prepare(sql).get(id) as { c: number }).c;
  assert.equal(gone('SELECT COUNT(*) c FROM trails WHERE id = ?'), 0, 'trail row gone');
  assert.equal(gone('SELECT COUNT(*) c FROM pages WHERE trail_id = ?'), 0, 'page rows gone');
  assert.equal(gone('SELECT COUNT(*) c FROM checkpoint_pages WHERE trail_id = ?'), 0, 'checkpoint rows gone');
  // The urls must be unreachable from the log too, or a replay rebuilds the trail.
  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM events WHERE canonical_url = ?').get(a) as { c: number }).c,
    0,
    'no event still references the deleted page',
  );
  assert.equal(deleteTrail(id), null, 'deleting an already-deleted trail is a clean miss, not a throw');
});
