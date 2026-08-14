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

const { computeLiveness, statusFor } = await import('../src/trails/trails.ts');
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
  assert.ok(series.every((v) => v >= 0), 'liveness went negative');
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
