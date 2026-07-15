// Fresh start. Wipes the local SQLite DB (trails, pages, events, categories, checkpoints, and the
// stored user_id) so the next daemon start regenerates everything — including a NEW user_id, which
// gives a clean Engram scope without needing a delete-all the REST API doesn't offer.
//
//   pnpm reset          # wipe local DB; next start = fresh user_id + fresh Engram scope
//
// Run with the daemon STOPPED. Old Engram memories are scoped to the previous user_id and become
// orphaned (harmless — search skips trails that no longer exist locally); purge them in the Engram
// console if you want the storage/quota back. Imports ONLY config (never db.ts) so nothing recreates
// the file we're deleting.
import { existsSync, rmSync } from 'node:fs';
import { DB_PATH, ENGRAM_ENABLED, USER_ID } from './config.js';

let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) { rmSync(p); console.log(`  removed ${p}`); removed++; }
}

console.log(removed ? '\n✓ Local DB wiped.' : '\n(no local DB found — already clean)');
if (USER_ID) {
  console.log(`  TABZERO_USER_ID is pinned to "${USER_ID}" — that scope is kept. Change/remove it for a new scope.`);
} else {
  console.log('  A fresh user_id is generated on the next `pnpm backend` (or set TABZERO_USER_ID to pin one).');
}
if (ENGRAM_ENABLED) {
  console.log('\nEngram: memories under any PREVIOUS user_id are now orphaned (harmless).');
  console.log('  New pushes use the current user_id + whatever topic descriptions are live in your Engram console.');
  console.log('  To reclaim the old ones, purge that user in the console.');
}
console.log('\nNext:  pnpm seed   (optional demo data)   →   pnpm backend');
