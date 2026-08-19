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
      content, topic: 'ResearchInterest', properties: {}, score: 0.9 - i * 0.1,
    }));
    return { ok: true, text: async () => JSON.stringify({ memories }) };
  };
}

// Reinstalled every test on purpose: a test that swaps in its own stub must not leak it to the next.
beforeEach(() => { perQuery = {}; queriesSeen = []; installDefaultFetch(); });

test('interests are unioned across probes, not limited to one query\'s ranked subset', async () => {
  // Five interests exist; no single probe retrieves more than two of them.
  perQuery = {
    'the user\'s main ongoing interests, themes, and projects': ['A', 'B'],
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
    'the user\'s main ongoing interests, themes, and projects': ['dup', 'x'],
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
      text: async () => JSON.stringify({
        memories: [
          { content: 'a real interest', topic: 'ResearchInterest', properties: {}, score: 0.9 },
          // A per-trail recap: right topic name AND a trail_id scope. Must not surface as an interest.
          { content: 'You were investigating espresso machines', topic: 'TrailSummary', properties: { trail_id: 't_1' }, score: 0.95 },
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
    'the user\'s main ongoing interests, themes, and projects': Array.from({ length: 14 }, (_, i) => `i${i}`),
  };
  const got = await engramInterests('test-user');
  assert.equal(got.length, 12, 'capped at 12');
  assert.equal(got[0].content, 'i0', 'best-scoring first');
  assert.ok(!got.some((g) => g.content === 'i13'), 'the weakest is what gets dropped');
});
