// Adaptive enrichment scheduler. Replaces three fixed setInterval loops that spun forever and
// raced still-growing trails. Each pass self-reschedules: base cadence while there's pending work,
// exponential backoff while the browser is quiet, and an immediate snap back to base the moment new
// activity arrives (noteActivity, called on every ingested batch). The per-trail settle gate lives
// in sync.ts — this layer only decides *how often to look*, never *what is eligible*.
import * as cfg from '../core/config.js';
import { ENGRAM_ENABLED } from '../core/config.js';
import { enrichSettled, flushEngram } from '../engram/sync.js';

let enrichTimer: ReturnType<typeof setTimeout> | null = null;
let engramTimer: ReturnType<typeof setTimeout> | null = null;
let enrichNextAt = 0;
let engramNextAt = 0;
let enrichIdle = 0;
let engramIdle = 0;
let enrichBusy = false;
let engramBusy = false;

const MAX_IDLE_ROUNDS = 8;

function backoff(base: number, rounds: number): number {
  return Math.min(base * 2 ** Math.min(rounds, MAX_IDLE_ROUNDS), cfg.IDLE_BACKOFF_MAX_MS);
}

function scheduleEnrich(delay: number): void {
  if (enrichTimer) clearTimeout(enrichTimer);
  enrichNextAt = Date.now() + delay;
  enrichTimer = setTimeout(runEnrich, delay);
}

function scheduleEngram(delay: number): void {
  if (engramTimer) clearTimeout(engramTimer);
  engramNextAt = Date.now() + delay;
  engramTimer = setTimeout(runEngram, delay);
}

async function runEnrich(): Promise<void> {
  enrichTimer = null;
  enrichBusy = true;
  try {
    const { processed, pending } = await enrichSettled(3, 1);
    // Back off only when nothing is pending at all — not when work exists but is still settling.
    enrichIdle = pending === 0 ? enrichIdle + 1 : 0;
    if (processed) console.log(`[enrich] updated ${processed} trail(s)`);
  } catch (e) {
    console.error('[enrich]', (e as Error).message);
  } finally {
    enrichBusy = false;
    scheduleEnrich(backoff(cfg.ENRICH_INTERVAL_MS, enrichIdle));
  }
}

async function runEngram(): Promise<void> {
  engramTimer = null;
  engramBusy = true;
  try {
    if (ENGRAM_ENABLED) {
      const { pushed, pending } = await flushEngram();
      engramIdle = pending === 0 ? engramIdle + 1 : 0;
      if (pushed) console.log(`[engram] pushed ${pushed} trail(s)`);
    } else {
      engramIdle += 1;
    }
  } catch (e) {
    console.error('[engram]', (e as Error).message);
  } finally {
    engramBusy = false;
    scheduleEngram(backoff(cfg.ENGRAM_INTERVAL_MS, engramIdle));
  }
}

/**
 * Called on every ingested batch. Resets the backoff and, if a pass has drifted out past base
 * cadence, pulls it back — so labels land promptly again when browsing resumes after a quiet spell.
 * Skips rescheduling a pass that's mid-flight (it self-reschedules at base when it finishes).
 */
export function noteActivity(): void {
  enrichIdle = 0;
  engramIdle = 0;
  const now = Date.now();
  if (!enrichBusy && (!enrichTimer || enrichNextAt > now + cfg.ENRICH_INTERVAL_MS)) {
    scheduleEnrich(cfg.ENRICH_INTERVAL_MS);
  }
  if (!engramBusy && (!engramTimer || engramNextAt > now + cfg.ENGRAM_INTERVAL_MS)) {
    scheduleEngram(cfg.ENGRAM_INTERVAL_MS);
  }
}

export function startScheduler(): void {
  scheduleEnrich(cfg.ENRICH_INTERVAL_MS);
  scheduleEngram(cfg.ENGRAM_INTERVAL_MS);
}
