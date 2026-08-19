// Interest RETRIEVAL, which turned out to be the weak link rather than interest formation.
//
// There is no "list memories by topic" in Engram's verified REST surface — the only way in is semantic
// search, and search is RANKED. So one query returns whichever interests sit nearest that phrasing and
// silently hides the rest. On a real account holding five ResearchInterest memories, the single-query
// version returned two, which read as "interests are barely forming" when they were barely being read.
//
// Engram is reached through fetch(), so a stubbed fetch drives the real client and the real union.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-int-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = 'eng_test_key';
process.env.ENGRAM_BASE = 'https://engram.test/v1';

const { engramInterests } = await import('../src/engram/client.ts');

after(() => rmSync(tmp, { recursive: true, force: true }));

/** Which interests each probe query "retrieves" — the ranked-subset behaviour, modelled. */
let perQuery: Record<string, string[]> = {};
let queriesSeen: string[] = [];

function installDefaultFetch(): void {
  (globalThis as any).fetch = async (url: string, init: any) => {
    if (!String(url).endsWith('/memories/search')) return { ok: true, text: async () => '{}' };
    const q = JSON.parse(init.body).query as string;
    queriesSeen.push(q);
    const memories = (perQuery[q] ?? []).map((content, i) => ({
      content,
      topic: 'ResearchInterest',
      properties: {},
      score: 0.9 - i * 0.1,
    }));
    return { ok: true, text: async () => JSON.stringify({ memories }) };
  };
}

// Reinstalled every test on purpose: a test that swaps in its own stub must not leak it to the next.
beforeEach(() => {
  perQuery = {};
  queriesSeen = [];
  installDefaultFetch();
});

test("interests are unioned across probes, not limited to one query's ranked subset", async () => {
  // Five interests exist; no single probe retrieves more than two of them.
  perQuery = {
    "the user's main ongoing interests, themes, and projects": ['A', 'B'],
    'what the user is currently evaluating, comparing, or deciding between': ['B', 'C'],
    'what the user is learning, building, or investigating': ['C', 'D'],
    'recurring topics and themes the user returns to across many sessions': ['E'],
  };
  const got = (await engramInterests('test-user')).map((i) => i.content).sort();
  assert.deepEqual(got, ['A', 'B', 'C', 'D', 'E'], `union incomplete: got ${got.join(',')}`);
  assert.ok(queriesSeen.length >= 4, `expected several probes, saw ${queriesSeen.length}`);
});

test('a memory returned by more than one probe is listed once', async () => {
  perQuery = {
    "the user's main ongoing interests, themes, and projects": ['dup', 'x'],
    'what the user is currently evaluating, comparing, or deciding between': ['dup'],
    'what the user is learning, building, or investigating': ['dup'],
    'recurring topics and themes the user returns to across many sessions': ['dup'],
  };
  const got = (await engramInterests('test-user')).map((i) => i.content);
  assert.equal(got.filter((c) => c === 'dup').length, 1, `duplicated: ${got.join(',')}`);
});

test('trail summaries are never mistaken for interests', async () => {
  (globalThis as any).fetch = async (url: string) => {
    if (!String(url).endsWith('/memories/search')) return { ok: true, text: async () => '{}' };
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          memories: [
            { content: 'a real interest', topic: 'ResearchInterest', properties: {}, score: 0.9 },
            // A per-trail recap: right topic name AND a trail_id scope. Must not surface as an interest.
            {
              content: 'You were investigating espresso machines',
              topic: 'TrailSummary',
              properties: { trail_id: 't_1' },
              score: 0.95,
            },
          ],
        }),
    };
  };
  const got = (await engramInterests('test-user')).map((i) => i.content);
  assert.deepEqual(got, ['a real interest'], `a trail summary leaked in: ${got.join(' | ')}`);
});

test('higher-scoring interests survive the cap', async () => {
  // 14 distinct interests across probes; the cap is 12, and it must drop the weakest, not the last seen.
  perQuery = {
    "the user's main ongoing interests, themes, and projects": Array.from({ length: 14 }, (_, i) => `i${i}`),
  };
  const got = await engramInterests('test-user');
  assert.equal(got.length, 12, 'capped at 12');
  assert.equal(got[0].content, 'i0', 'best-scoring first');
  assert.ok(!got.some((g) => g.content === 'i13'), 'the weakest is what gets dropped');
});

// Engram returns `created_at` and `updated_at` on every memory, and both were being discarded. Because
// both topics are BOUNDED — a memory is rewritten in place as understanding evolves — `updated_at` is
// "when Engram last changed its mind", which is the only honest thing to show next to an interest.
test('the last-updated timestamp is carried through from Engram', async () => {
  (globalThis as any).fetch = async (url: string) => {
    if (!String(url).endsWith('/memories/search')) return { ok: true, text: async () => '{}' };
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          memories: [
            {
              content: 'has both stamps',
              topic: 'ResearchInterest',
              properties: {},
              score: 0.9,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-08-01T12:00:00.000Z',
            },
            {
              content: 'created only',
              topic: 'ResearchInterest',
              properties: {},
              score: 0.8,
              created_at: '2026-06-15T06:00:00.000Z',
            },
            { content: 'no stamps at all', topic: 'ResearchInterest', properties: {}, score: 0.7 },
            {
              content: 'unparseable stamp',
              topic: 'ResearchInterest',
              properties: {},
              score: 0.6,
              updated_at: 'not a date',
            },
          ],
        }),
    };
  };
  const byContent = new Map((await engramInterests('test-user')).map((i) => [i.content, i.updatedAt]));

  assert.equal(
    byContent.get('has both stamps'),
    Date.parse('2026-08-01T12:00:00.000Z'),
    'updated_at must win over created_at — it is the whole point',
  );
  assert.equal(
    byContent.get('created only'),
    Date.parse('2026-06-15T06:00:00.000Z'),
    'fall back to created_at when a memory has never been rewritten',
  );
  assert.equal(byContent.get('no stamps at all'), null, 'absent stamp is null, not 0 or NaN');
  assert.equal(byContent.get('unparseable stamp'), null, 'a garbage stamp must not become NaN');
});

test('getInterests only sets updatedAt when Engram actually gave one', async () => {
  const { getInterests } = await import('../src/trails/trails.ts');
  (globalThis as any).fetch = async (url: string) => {
    if (!String(url).endsWith('/memories/search')) return { ok: true, text: async () => '{}' };
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          memories: [
            {
              content: 'stamped',
              topic: 'ResearchInterest',
              properties: {},
              score: 0.9,
              updated_at: '2026-08-01T00:00:00.000Z',
            },
            { content: 'unstamped', topic: 'ResearchInterest', properties: {}, score: 0.8 },
          ],
        }),
    };
  };
  const r = await getInterests('test-user');
  assert.equal(r.source, 'engram');
  const stamped = r.interests.find((i) => i.label === 'stamped')!;
  const unstamped = r.interests.find((i) => i.label === 'unstamped')!;
  assert.equal(stamped.updatedAt, Date.parse('2026-08-01T00:00:00.000Z'));
  // Omitted rather than null: the popup renders the line only when the key is present, so emitting a
  // null would put a bare "updated" with nothing after it on screen.
  assert.ok(!('updatedAt' in unstamped), 'an unstamped interest must omit the field entirely');
});
