// Hybrid search: the keyword pass and the Engram semantic pass have to SHARE the result slots.
//
// The bug this pins: keyword hits were seeded first, up to the full limit, and semantic hits appended
// after. A Map keeps insertion order, so the trailing `slice(0, limit)` discarded every Engram hit
// whenever keyword search filled the page on its own — silently dropping the only results that pressing
// Enter exists to surface, precisely when keyword search looked like it was working.
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
process.env.ENGRAM_API_KEY = 'eng_test_key';            // Engram ON, but every call is intercepted
process.env.ENGRAM_BASE = 'https://engram.test/v1';     // https, so the boot-time scheme check passes

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
    ins.run(`t_kw${i}`, `Espresso machine research ${i}`, 'Comparing espresso machines', now - i * 1000, now - i * 1000);
  }
  // One trail sharing NO word with the query. Only Engram can surface it.
  ins.run('t_sem', 'Grinder burr geometry', 'Investigating conical versus flat burrs', now - 9000, now - 9000);
});

beforeEach(() => { semanticIds = []; });

test('a semantic hit survives even when keyword search could fill every slot', async () => {
  semanticIds = ['t_sem'];
  const hits = await searchTrails('test-user', 'espresso', 5);

  assert.equal(hits.length, 5, 'should still return a full page');
  const ids = hits.map((h) => h.trail.id);
  assert.ok(ids.includes('t_sem'), `the semantic-only trail was dropped: got ${ids.join(', ')}`);
  const sem = hits.find((h) => h.trail.id === 't_sem')!;
  assert.equal(sem.why, 'semantic', 'and it must be tagged as a meaning match, not a text match');
  assert.ok(sem.snippet, 'a semantic hit carries the Engram snippet');
});

test('keyword precision still leads — the best literal matches are not crowded out', async () => {
  semanticIds = ['t_sem'];
  const hits = await searchTrails('test-user', 'espresso', 5);
  const kw = hits.filter((h) => h.why === 'keyword');
  assert.ok(kw.length >= 3, `keyword should still hold most of the page, got ${kw.length}`);
  // Reserving slots must not mean reserving them for nothing: with one semantic hit available, the
  // remaining slots go back to keyword rather than being left empty.
  assert.equal(hits.length, 5);
});

test('when Engram returns nothing, keyword backfills the reserved slots', async () => {
  semanticIds = []; // Engram off / cold / nothing relevant
  const hits = await searchTrails('test-user', 'espresso', 5);
  assert.equal(hits.length, 5, 'a hybrid search must never return fewer rows than keyword alone would');
  assert.ok(hits.every((h) => h.why === 'keyword'), 'all keyword when there is no semantic contribution');
  assert.equal(new Set(hits.map((h) => h.trail.id)).size, 5, 'no duplicates');
});

test('a semantic hit that duplicates a keyword hit is not listed twice', async () => {
  semanticIds = ['t_kw1', 't_sem'];
  const hits = await searchTrails('test-user', 'espresso', 5);
  const ids = hits.map((h) => h.trail.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rows: ${ids.join(', ')}`);
  assert.equal(hits.find((h) => h.trail.id === 't_kw1')!.why, 'keyword', 'first tag wins for a dupe');
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
  db.prepare(
    `INSERT INTO trails (id, label, one_liner, created, last_active, centroid, page_count, session_count)
     VALUES ('t_forming', 'Espresso stray tab', 'A single espresso page', ?, ?, '{}', 1, 1)`,
  ).run(Date.now(), Date.now());

  const ids = (await searchTrails('test-user', 'espresso', 10)).map((h) => h.trail.id);
  assert.ok(!ids.includes('t_forming'), `a forming trail leaked into search: ${ids.join(', ')}`);

  // ...but a real trail with the same words is still found, so the floor isn't just breaking search.
  assert.ok(ids.some((i) => i.startsWith('t_kw')), 'graduated trails must still match');
});

test('Engram cannot reintroduce a forming trail through the semantic pass', async () => {
  // The semantic branch resolves a trail id straight from Engram, so it needs the same floor as the
  // keyword pass — otherwise a memory for a since-shrunk trail smuggles it back onto the page.
  semanticIds = ['t_forming'];
  const ids = (await searchTrails('test-user', 'espresso', 10)).map((h) => h.trail.id);
  assert.ok(!ids.includes('t_forming'), `semantic pass bypassed the forming floor: ${ids.join(', ')}`);
});
