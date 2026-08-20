// Deleting a trail has to delete Engram's copy of it too.
//
// It didn't, because the API was believed to have no delete. It has a per-memory one — verified against
// the live service: `DELETE /memories/{id}` answers 404 `memory not found` for an unknown id, while
// `GET /memories` is 405, so there is no filter or bulk route and ids can only come from search.
//
// The consequences of skipping it were not cosmetic: an orphaned memory came back in every semantic
// search (invisible only because searchTrails drops hits whose trail is gone), it occupied one of the ten
// slots a search returns, and content the user asked to be rid of stayed in their project.
//
// fetch is stubbed, so the real client, the real URL construction and the real trail_id filtering all run.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-engdel-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = 'eng_test_key';
process.env.ENGRAM_BASE = 'https://engram.test/v1';

const { engramForgetTrail } = await import('../src/engram/client.ts');

after(() => rmSync(tmp, { recursive: true, force: true }));

/** Memories the fake Engram holds: [id, trail_id | null]. */
let store: [string, string | null][] = [];
let deletes: string[] = [];
let searches: string[] = [];
let deleteStatus = 200;

beforeEach(() => {
  deletes = [];
  searches = [];
  deleteStatus = 200;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const u = String(url);
    if (init?.method === 'DELETE') {
      deletes.push(u);
      return { ok: deleteStatus < 400, status: deleteStatus, text: async () => '{}' };
    }
    searches.push(JSON.parse(init.body).query);
    const memories = store.map(([id, trail_id]) => ({
      id,
      content: 'a memory',
      properties: trail_id ? { trail_id } : {},
      topic: trail_id ? 'TrailSummary' : 'ResearchInterest',
      score: 0.9,
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ memories }) };
  };
});

test('only the target trail’s memories are deleted', async () => {
  store = [['m_mine', 't_7'], ['m_other', 't_8'], ['m_interest', null]];
  const r = await engramForgetTrail('test-user', 't_7', ['Origami helmet folds']);

  assert.equal(r.deleted, 1);
  assert.equal(r.failed, 0);
  assert.equal(deletes.length, 1, `deleted the wrong number of memories: ${deletes.join(', ')}`);
  assert.match(deletes[0], /\/memories\/m_mine\?user_id=test-user$/, 'id and user_id both in the URL');
});

test('a cross-trail interest is never collateral damage', async () => {
  // ResearchInterest memories are user-scoped with no trail_id: many trails contributed to them, so
  // deleting one trail must not erase one. The filter is on trail_id, which excludes them structurally.
  store = [['m_interest', null]];
  const r = await engramForgetTrail('test-user', 't_7', ['anything']);
  assert.equal(r.deleted, 0);
  assert.deepEqual(deletes, [], 'an untagged memory must never be touched');
});

test('a memory found by both probes is deleted once', async () => {
  store = [['m_mine', 't_7']];
  const r = await engramForgetTrail('test-user', 't_7', ['Label and recap', 'Label']);
  assert.ok(searches.length >= 2, 'both probes ran');
  assert.equal(deletes.length, 1, 'but the id was de-duplicated across them');
  assert.equal(r.deleted, 1);
});

test('404 counts as gone, not as a failure', async () => {
  // Already deleted is the outcome we wanted. Reporting it as an error would make a clean delete look
  // broken and invite a pointless retry.
  store = [['m_mine', 't_7']];
  deleteStatus = 404;
  const r = await engramForgetTrail('test-user', 't_7', ['x']);
  assert.equal(r.deleted, 1);
  assert.equal(r.failed, 0);
});

test('a real failure is reported, so an orphan is never silently left', async () => {
  store = [['m_mine', 't_7']];
  deleteStatus = 500;
  const r = await engramForgetTrail('test-user', 't_7', ['x']);
  assert.equal(r.deleted, 0);
  assert.equal(r.failed, 1);
});

// ---- pruning orphans ----
//
// The sweep compares Engram's memories against the local trails table and deletes what has no match.
// That comparison is the whole feature and also the whole danger: if the local side is empty or is the
// wrong database, every memory looks orphaned and the sweep wipes the project. These pin the refusals,
// which matter more than the deletions.
const { planEngramPrune } = await import('../src/engram/prune.ts');
const mem = (id: string, trailId: string) => ({ id, trailId, content: `memory ${id}` });

test('an empty local database is refused, not treated as "everything is an orphan"', () => {
  // A wiped data dir, a pinned TABZERO_USER_ID on a fresh DB, or a data dir that resolved somewhere
  // unexpected all look identical to this function — and that last one was a real bug here.
  const plan = planEngramPrune({ found: [mem('m1', 't_1')], localTrailIds: new Set(), force: false });
  assert.equal(plan.ok, false);
  assert.match((plan as any).refusal, /no trails/i);
});

test('orphans outnumbering live trails needs an explicit --force', () => {
  const found = [mem('m1', 't_9'), mem('m2', 't_8'), mem('m3', 't_7')];
  const localTrailIds = new Set(['t_1']);
  assert.equal(planEngramPrune({ found, localTrailIds, force: false }).ok, false);
  const forced = planEngramPrune({ found, localTrailIds, force: true });
  assert.equal(forced.ok, true);
  assert.equal((forced as any).orphans.length, 3, 'and then it proceeds with all of them');
});

test('only memories whose trail is gone are selected', () => {
  const plan = planEngramPrune({
    found: [mem('m_live', 't_1'), mem('m_dead', 't_99'), mem('m_live2', 't_2')],
    localTrailIds: new Set(['t_1', 't_2']),
    force: false,
  }) as any;
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.orphans.map((m: any) => m.id), ['m_dead']);
  assert.equal(plan.keeping, 2, 'and it reports what it deliberately left alone');
});

test('the same memory seen by several probes is counted once', () => {
  const plan = planEngramPrune({
    found: [mem('m_dead', 't_99'), mem('m_dead', 't_99'), mem('m_dead', 't_99')],
    localTrailIds: new Set(['t_1']),
    force: false,
  }) as any;
  assert.equal(plan.orphans.length, 1);
});
