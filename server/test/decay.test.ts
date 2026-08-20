// computeLiveness/statusFor are the decay model every trail list, ranking, and interest gate depends
// on. They live in trails.ts, which opens the SQLite handle on import — so point the data dir at a
// throwaway directory BEFORE that import lands, and the real .tabzero is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-test-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = ''; // never reach the network from a unit test

const { computeLiveness, statusFor, listTrails, countListedTrails, recapNeedsRefresh } = await import('../src/trails/trails.ts');
const { db } = await import('../src/core/db.ts');
const cfg = await import('../src/core/config.ts');

const DAY = 86400000;
const NOW = 1_800_000_000_000; // fixed clock — these are pure functions, so no wall time involved

after(() => rmSync(tmp, { recursive: true, force: true }));

test('liveness decays monotonically as a trail goes stale', () => {
  const at = (days: number) => computeLiveness(10, 3, NOW - days * DAY, NOW);
  const series = [0, 1, 3, 7, 30].map(at);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] < series[i - 1], `expected decay at step ${i}: ${series.join(' > ')}`);
  }
  assert.ok(
    series.every((v) => v >= 0),
    'liveness went negative',
  );
});

test('liveness halves after exactly one half-life', () => {
  const fresh = computeLiveness(10, 3, NOW, NOW);
  const aged = computeLiveness(10, 3, NOW - cfg.DECAY_HALFLIFE_DAYS * DAY, NOW);
  assert.ok(Math.abs(aged - fresh / 2) < 0.01, `${aged} should be ~half of ${fresh}`);
});

test('more pages and more sessions both raise liveness', () => {
  assert.ok(computeLiveness(20, 3, NOW, NOW) > computeLiveness(5, 3, NOW, NOW));
  assert.ok(computeLiveness(10, 8, NOW, NOW) > computeLiveness(10, 1, NOW, NOW));
});

test('future timestamps are clamped, not rewarded', () => {
  assert.equal(computeLiveness(10, 3, NOW + 5 * DAY, NOW), computeLiveness(10, 3, NOW, NOW));
});

test('statusFor walks forming -> live -> dormant -> archived', () => {
  assert.equal(statusFor(cfg.MIN_TRAIL_PAGES - 1, NOW, NOW), 'forming');
  assert.equal(statusFor(cfg.MIN_TRAIL_PAGES, NOW, NOW), 'live');
  assert.equal(statusFor(5, NOW - (cfg.DORMANT_AFTER_DAYS + 1) * DAY, NOW), 'dormant');
  assert.equal(statusFor(5, NOW - (cfg.ARCHIVE_AFTER_DAYS + 1) * DAY, NOW), 'archived');
});

test('an under-sized trail stays forming no matter how stale', () => {
  assert.equal(statusFor(cfg.MIN_TRAIL_PAGES - 1, NOW - 365 * DAY, NOW), 'forming');
});

// listTrails is the one place status filtering is applied, and both branches of `includeArchived`
// have to stay reachable — the option was previously dead and got removed for exactly that reason.
test('listTrails hides archived and forming trails, and --all reveals archived', () => {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO trails (id, label, created, last_active, centroid, page_count, session_count)
     VALUES (?, ?, ?, ?, '{}', ?, 1)`,
  );
  const stale = now - (cfg.ARCHIVE_AFTER_DAYS + 5) * DAY;
  ins.run('t_arch', 'Archived one', stale, stale, 5);
  ins.run('t_live', 'Live one', now, now, 5);
  ins.run('t_form', 'Still forming', now, now, cfg.MIN_TRAIL_PAGES - 1);

  const ids = (o?: { includeArchived?: boolean }) => listTrails(o).map((t) => t.id);

  assert.deepEqual(ids(), ['t_live'], 'default list should show only the live trail');
  assert.ok(ids({ includeArchived: true }).includes('t_arch'), '--all should reveal archived');
  assert.ok(ids({ includeArchived: true }).includes('t_live'), '--all should still show live');
  assert.ok(!ids({ includeArchived: true }).includes('t_form'), 'forming stays hidden either way');
});

// The local interest fallback used to admit `dwell >= 8min` on its own, which let a single absorbing
// sitting ("India vs New Zealand T20 Final" — 4 pages, 31 minutes, 1 session) present itself as a
// durable research interest. Durability now means recurrence across sessions or real depth.
test('the local interest fallback needs recurrence or depth, not just a long sitting', async () => {
  const { getInterests } = await import('../src/trails/trails.ts');
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO trails (id, label, created, last_active, centroid, page_count, session_count)
     VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  );
  ins.run('t_rec', 'Recurring theme', now, now, 4, 2); // returned across sessions -> qualifies
  ins.run('t_deep', 'Deep investigation', now, now, 10, 1); // sustained depth -> qualifies
  ins.run('t_sitting', 'One long sitting', now, now, 4, 1); // neither -> must not qualify

  // Dwell is irrelevant now, so give the disqualified trail plenty of it.
  db.prepare(
    `INSERT INTO pages (canonical_url, url, title, domain, first_seen, last_seen, visit_count, total_dwell_ms, trail_id, tokens)
     VALUES ('https://x.test/a', 'https://x.test/a', 'a', 'x.test', ?, ?, 1, ?, 't_sitting', '[]')`,
  ).run(now, now, 45 * 60 * 1000);

  const res = await getInterests('test-user');
  assert.equal(res.source, 'local', 'no Engram key in this test, so the fallback must be used');
  const labels = res.interests.map((i) => i.label);
  assert.ok(labels.includes('Recurring theme'), 'recurrence qualifies');
  assert.ok(labels.includes('Deep investigation'), 'depth qualifies');
  assert.ok(!labels.includes('One long sitting'), '45 minutes in one session is not a durable interest');
});

// A trail recapped locally before Engram finished extracting must keep asking Engram. Gating only on
// missing-or-dirty froze the placeholder permanently — it left 9 of 20 trails in a real database
// showing a local recap that could never upgrade, silently voiding "Engram authors your recaps".
test('a fresh LOCAL recap still needs refreshing while Engram is on', () => {
  const row = (summary: string | null, dirty: number, source: string | null) => ({
    summary,
    summary_dirty: dirty,
    summary_source: source,
  });

  // The bug: fresh, not dirty, but authored locally.
  assert.equal(
    recapNeedsRefresh(row('a local recap', 0, 'local'), true),
    true,
    'local placeholder must retry Engram',
  );
  assert.equal(
    recapNeedsRefresh(row('a heuristic recap', 0, 'heuristic'), true),
    true,
    'heuristic must retry too',
  );

  // Engram's own recap is canonical — stop asking.
  assert.equal(recapNeedsRefresh(row('engram prose', 0, 'engram'), true), false, 'an Engram recap is final');

  // With Engram off there is nothing to upgrade to, so a fresh local recap must NOT burn an LLM call.
  assert.equal(
    recapNeedsRefresh(row('a local recap', 0, 'local'), false),
    false,
    'no key: keep the placeholder',
  );

  // Missing or dirty always needs work, either way.
  for (const engramOn of [true, false]) {
    assert.equal(recapNeedsRefresh(row(null, 0, null), engramOn), true, 'no recap yet');
    assert.equal(recapNeedsRefresh(row('stale', 1, 'engram'), engramOn), true, 'dirty recap');
  }
});

// The count the popup footer and the "tab zero" screen both display comes from /health, and it was a
// bare `page_count >= 2` with no archive filter — so the screen announced "36 tabs closed. Saved as 20
// research trails" directly above a list of 13. Two implementations of one predicate, drifted. This
// pins them to each other; the boundary case is checked separately because that is where an off-by-one
// between SQL and statusFor would hide.
test('the /health count is exactly what the trail list shows', () => {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO trails (id, label, created, last_active, centroid, page_count, session_count)
     VALUES (?, ?, ?, ?, '{}', ?, 1)`,
  );
  const stale = now - (cfg.ARCHIVE_AFTER_DAYS + 3) * DAY;
  ins.run('c_arch', 'Long gone', stale, stale, 6);
  ins.run('c_live', 'Current', now, now, 6);
  ins.run('c_form', 'One page', now, now, cfg.MIN_TRAIL_PAGES - 1);

  const listed = listTrails().length;
  assert.ok(
    listTrails({ includeArchived: true }).length > listed,
    'fixture must include an archived trail, or this asserts nothing',
  );
  assert.equal(countListedTrails(), listed, 'the count and the list must never disagree');
});

test('the archive cutoff falls on the same side for the count and for statusFor', () => {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO trails (id, label, created, last_active, centroid, page_count, session_count)
     VALUES (?, ?, ?, ?, '{}', 6, 1)`,
  );
  // Exactly at the boundary statusFor calls archived (`days >= ARCHIVE_AFTER_DAYS`).
  const edge = now - cfg.ARCHIVE_AFTER_DAYS * DAY;
  const before = countListedTrails(now);
  ins.run('c_edge', 'Right on the line', edge, edge);
  assert.equal(statusFor(6, edge, now), 'archived', 'statusFor archives at the boundary');
  assert.equal(countListedTrails(now), before, 'so the count must not include it either');
});
