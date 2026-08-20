/**
 * Delete Engram memories whose trail no longer exists locally.
 *
 * Deleting a trail now removes its memory as part of the same operation (see engramForgetTrail), so new
 * orphans are not created. This is for the ones already there: trails deleted before that existed, or a
 * delete where the remote half failed. They are not harmless — an orphan comes back in every semantic
 * search, taking one of the ten slots a search returns, and the content stays in the project after the
 * user asked for it to be gone. Search hides them (`if (!t) continue`), which is exactly why they went
 * unnoticed.
 *
 * DISCOVERY IS BEST-EFFORT, and it cannot be otherwise: Engram has no list or filter endpoint
 * (`GET /memories` is 405), so the only way to see a memory is to make search return it. This probes
 * with every local trail's own text plus a set of deliberately broad queries — orphans are, by
 * definition, the memories least like anything you currently have, so probing only with current labels
 * is exactly the wrong strategy. Expect to run it more than once; each pass reports what it saw.
 *
 * DRY RUN BY DEFAULT. --apply deletes. --force overrides the ratio guard in prune.ts. Reads are free, so
 * a dry run costs nothing but time.
 */
import { db } from '../core/db.js';
import { getUserId } from '../core/db.js';
import { ENGRAM_ENABLED, INTEREST_TOPIC } from '../core/config.js';
import { engramSearch, engramDeleteMemories } from '../engram/client.js';
import { planEngramPrune, type FoundMemory } from '../engram/prune.js';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const log = (s: string): void => {
  process.stdout.write(s + '\n');
};

/** Broad probes, to surface memories that resemble nothing you currently have. */
const WIDE_PROBES = [
  'what has this person been doing',
  'anything at all, any topic',
  'work, code, and technical reading',
  'travel, food, shopping, hobbies, sport, entertainment',
  'news, politics, and current events',
  'health, money, and admin',
  'documentation, reference, and how-to guides',
  'something abandoned a long time ago',
];

async function main(): Promise<void> {
  if (!ENGRAM_ENABLED) {
    log('\n  Engram is off (no ENGRAM_API_KEY) — nothing to prune.\n');
    return;
  }
  log(APPLY ? '\n  ENGRAM PRUNE — applying\n' : '\n  ENGRAM PRUNE — dry run (pass --apply to delete)\n');

  const trails = db.prepare('SELECT id, label, one_liner FROM trails').all() as unknown as {
    id: string;
    label: string | null;
    one_liner: string | null;
  }[];
  const localTrailIds = new Set(trails.map((t) => t.id));
  log(`  local trails: ${localTrailIds.size}`);

  const userId = getUserId();
  const probes = [
    ...WIDE_PROBES,
    ...trails.map((t) => `${t.label || ''} ${t.one_liner || ''}`.trim()).filter(Boolean),
  ];

  const found = new Map<string, FoundMemory>();
  for (const [i, q] of probes.entries()) {
    const hits = await engramSearch(userId, q);
    for (const h of hits) {
      // Interests are user-scoped with no trail_id: they belong to no trail and are never orphans.
      if (!h.id || !h.trailId || h.topic === INTEREST_TOPIC) continue;
      found.set(h.id, { id: h.id, trailId: h.trailId, content: h.content });
    }
    process.stdout.write(`\r  probing ${i + 1}/${probes.length} — ${found.size} trail memories seen  `);
  }
  log('');

  const plan = planEngramPrune({ found: [...found.values()], localTrailIds, force: FORCE });
  if (!plan.ok) {
    log(`\n  REFUSED: ${plan.refusal}\n`);
    process.exitCode = 1;
    return;
  }

  log(`  matched a live trail: ${plan.keeping}`);
  log(`  orphaned:             ${plan.orphans.length}\n`);
  if (!plan.orphans.length) {
    log('  Nothing to prune — every memory found belongs to a trail you still have.\n');
    return;
  }
  for (const m of plan.orphans) {
    log(`    ${m.trailId.padEnd(8)} ${m.id}  ${m.content.replace(/\s+/g, ' ').slice(0, 72)}`);
  }

  if (!APPLY) {
    log('\n  Dry run — nothing deleted. Re-run with --apply.\n');
    return;
  }
  const { deleted, failed } = await engramDeleteMemories(
    userId,
    plan.orphans.map((m) => m.id),
  );
  log(`\n  Deleted ${deleted}${failed ? `, ${failed} failed` : ''}. Run again to catch any the probes missed.\n`);
}

await main();
