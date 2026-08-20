// What pressing Enter searches.
//
// Enter is SEMANTIC search, and only that: the popup already filters the trails on screen by literal
// text as you type, with no network. /search used to merge a lexical pass into the same result list,
// which meant every row had to carry a tag naming the lane it came from, and a weak literal match could
// outrank a strong semantic one. Now Engram's answer stands alone — with one deliberate exception, the
// local-mode fallback below, because Enter must never be a dead end.
//
// Engram is reached through fetch(), so a stubbed fetch exercises the real client, the real merge, and
// the real https check — no module mocking, same technique as the extension's capture test.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-search-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = 'eng_test_key'; // Engram ON, but every call is intercepted
process.env.ENGRAM_BASE = 'https://engram.test/v1'; // https, so the boot-time scheme check passes

const { searchTrails } = await import('../src/trails/trails.ts');
const { db } = await import('../src/core/db.ts');

after(() => rmSync(tmp, { recursive: true, force: true }));

/** Trail ids the fake Engram will claim as semantic matches. */
let semanticIds: string[] = [];

before(() => {
  (globalThis as any).fetch = async (url: string) => {
    if (!String(url).endsWith('/memories/search')) {
      return { ok: true, text: async () => '{}' };
    }
    // The shape engramSearch actually parses: { memories: [{ content, properties.trail_id, topic }] }
    const memories = semanticIds.map((id) => ({
      content: `Engram's reconciled memory for ${id}`,
      properties: { trail_id: id },
      topic: 'TrailSummary',
      score: 0.9,
    }));
    return { ok: true, text: async () => JSON.stringify({ memories }) };
  };

  const ins = db.prepare(
    `INSERT INTO trails (id, label, one_liner, created, last_active, centroid, page_count, session_count)
     VALUES (?, ?, ?, ?, ?, '{}', 4, 1)`,
  );
  const now = Date.now();
  // Six trails that all match the literal word "espresso" — more than the default limit of 5, so the
  // keyword pass alone can fill every slot.
  for (let i = 1; i <= 6; i++) {
    ins.run(
      `t_kw${i}`,
      `Espresso machine research ${i}`,
      'Comparing espresso machines',
      now - i * 1000,
      now - i * 1000,
    );
  }
  // One trail sharing NO word with the query. Only Engram can surface it.
  ins.run(
    't_sem',
    'Grinder burr geometry',
    'Investigating conical versus flat burrs',
    now - 9000,
    now - 9000,
  );
});

beforeEach(() => {
  semanticIds = [];
});

test('Enter returns semantic hits only — never the literal matches typing already shows', () => {
  // "espresso" matches six trails literally, so the old hybrid handed back a page that was mostly
  // keyword rows. Those rows are exactly what the on-screen filter produces without a round trip.
  semanticIds = ['t_sem'];
  return searchTrails('test-user', 'espresso', 5).then((hits) => {
    assert.deepEqual(hits.map((h) => h.trail.id), ['t_sem'], 'only Engram decides this list');
    assert.equal(hits[0].why, 'semantic');
    assert.ok(hits[0].snippet, 'and it carries the Engram snippet');
  });
});

test('a literal match is not privileged just because the words line up', async () => {
  semanticIds = ['t_sem'];
  const hits = await searchTrails('test-user', 'espresso machine research 1', 5);
  assert.ok(
    !hits.some((h) => h.trail.id === 't_kw1'),
    'the trail whose label IS the query must not appear unless Engram returned it',
  );
});

test('with Engram silent, Enter falls back to literal matching rather than nothing', async () => {
  // No key (local mode), or extraction has not landed on a fresh install. A dead end here would make
  // Enter look broken, and the lexical pass still reaches archived trails the on-screen filter cannot.
  semanticIds = [];
  const hits = await searchTrails('test-user', 'espresso', 5);
  assert.equal(hits.length, 5, 'the fallback fills the page');
  assert.ok(hits.every((h) => h.why === 'keyword'), 'and is tagged as the fallback it is');
  assert.equal(new Set(hits.map((h) => h.trail.id)).size, 5, 'no duplicates');
});

test('the fallback is a fallback — one semantic hit is enough to suppress it', async () => {
  semanticIds = ['t_sem'];
  const hits = await searchTrails('test-user', 'espresso', 5);
  assert.equal(hits.length, 1, `a single semantic hit stands alone: got ${hits.map((h) => h.trail.id).join(', ')}`);
});

test('the same trail returned twice by Engram is listed once', async () => {
  semanticIds = ['t_sem', 't_sem', 't_kw1'];
  const hits = await searchTrails('test-user', 'batman', 5);
  const ids = hits.map((h) => h.trail.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rows: ${ids.join(', ')}`);
});

test('an empty query lists trails rather than searching', async () => {
  const hits = await searchTrails('test-user', '   ', 5);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.why === 'list'), 'empty query is a list, not a match');
});

test('a forming trail is not searchable, matching what the Trails list shows', async () => {
  // A one-page trail is `forming` — the deliberate noise filter for a single stray tab — and listTrails
  // hides it. Search used to select from ALL trails, so the same trail was invisible in the list yet
  // appeared in search results, which made the list look like it was concealing things.
  //
  // With no semanticIds set this runs the local-mode fallback; the test after it covers the same floor
  // on the semantic path, and both need it — they are separate queries over the same table.
  db.prepare(
    `INSERT INTO trails (id, label, one_liner, created, last_active, centroid, page_count, session_count)
     VALUES ('t_forming', 'Espresso stray tab', 'A single espresso page', ?, ?, '{}', 1, 1)`,
  ).run(Date.now(), Date.now());

  const ids = (await searchTrails('test-user', 'espresso', 10)).map((h) => h.trail.id);
  assert.ok(!ids.includes('t_forming'), `a forming trail leaked into search: ${ids.join(', ')}`);

  // ...but a real trail with the same words is still found, so the floor isn't just breaking search.
  assert.ok(
    ids.some((i) => i.startsWith('t_kw')),
    'graduated trails must still match',
  );
});

test('Engram cannot reintroduce a forming trail through the semantic pass', async () => {
  // The semantic branch resolves a trail id straight from Engram, so it needs the same floor as the
  // keyword pass — otherwise a memory for a since-shrunk trail smuggles it back onto the page.
  semanticIds = ['t_forming'];
  const ids = (await searchTrails('test-user', 'espresso', 10)).map((h) => h.trail.id);
  assert.ok(!ids.includes('t_forming'), `semantic pass bypassed the forming floor: ${ids.join(', ')}`);
});

// The order search results come back in IS the answer — the popup renders them as given. It used to
// re-sort them by lastActive in the client, which discarded the ranking: a real query for "batman" had
// Spider-Man Brand New Day first out of Engram at score 0.5, and recency pushed it below four trails
// from that afternoon that matched nothing at all. This pins the contract the client now relies on.
test('relevance order survives — the top semantic hit leads, even when it is the oldest trail', async () => {
  // A query with no literal match anywhere, so the keyword pass contributes nothing and the order is
  // purely Engram's. t_sem is the OLDEST trail in the fixture; t_kw1 is the newest.
  semanticIds = ['t_sem', 't_kw1'];
  const hits = await searchTrails('test-user', 'batman', 5);
  assert.equal(hits.length, 2, `only Engram should contribute here: got ${hits.map((h) => h.trail.id).join(', ')}`);
  assert.equal(hits[0].trail.id, 't_sem', "Engram's strongest hit must lead");
  assert.ok(
    hits[0].trail.lastActive < hits[1].trail.lastActive,
    'and this only proves something because the leader is the older trail',
  );
});
