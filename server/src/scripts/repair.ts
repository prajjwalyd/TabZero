/**
 * One-off repair for a database captured before the privacy and replay fixes existed.
 *
 * Every fix in redact.ts and pipeline.ts is forward-only: it changes what gets written from now on and
 * leaves what is already stored exactly as it was. On a database that has been running for a while,
 * "already stored" can include live credentials and badly wrong counts. This pass fixes the history.
 *
 *   1. Auth-flow pages (sign-in, OAuth, password reset, checkout) are removed. They are never research,
 *      and they are where secrets live. Their event rows keep their timing but lose the address.
 *   2. Secret-bearing param values in every remaining `events.url` / `pages.url` become REDACTED,
 *      with `canonical_url` recomputed to match (merging any rows that collide as a result).
 *   3. `visit_count` is recomputed from the event log using the pipeline's own revisit rule, which
 *      undoes the inflation the extension's queue bug caused — one real visit read as 436.
 *   4. Trail `page_count` / `centroid` are rebuilt for any trail that lost pages, so decay, status and
 *      the interest gate stop being computed from counts that no longer match reality.
 *   5. The vestigial `trails.status` / `trails.liveness` columns are dropped. Both predate those values
 *      becoming read-derived and have been frozen and wrong ever since; the current schema does not
 *      declare them, so only a database from an older build still carries them.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write, which takes a timestamped backup first. Refuses to run
 * while the daemon is up, because it holds the database open and would race these writes.
 */
import { copyFileSync } from 'node:fs';
import { DB_PATH, PORT, hardenPath } from '../core/config.js';
import { db } from '../core/db.js';
import { canonicalize, tokenize, bag } from '../capture/canonical.js';
import { isSensitiveUrl, redact, redactTextParams } from '../capture/redact.js';

const APPLY = process.argv.includes('--apply');
const log = (s: string): void => {
  process.stdout.write(s + '\n');
};

async function daemonIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

interface EventRow {
  id: number;
  url: string | null;
  canonical_url: string | null;
  type: string;
  tab_id: number | null;
  ts: number;
}
interface PageRow {
  canonical_url: string;
  url: string | null;
  title: string | null;
  description: string | null;
  trail_id: string | null;
}

async function main(): Promise<void> {
  if (await daemonIsUp()) {
    process.stderr.write(
      `Tab Zero is running on port ${PORT}. Stop it first — it holds the database open and would race\n` +
        'these writes. Then re-run this command.\n',
    );
    process.exit(1);
  }

  log(APPLY ? '\n  REPAIR — applying changes\n' : '\n  REPAIR — dry run (pass --apply to write)\n');

  // ---- 1. auth-flow pages ----
  const pages = db
    .prepare('SELECT canonical_url, url, title, description, trail_id FROM pages')
    .all() as unknown as PageRow[];
  const authPages = pages.filter((p) => isSensitiveUrl(p.url || p.canonical_url));
  log(`  auth-flow pages to remove ........ ${authPages.length}`);
  for (const p of authPages)
    log(`      - ${(p.title || '').slice(0, 46).padEnd(46)} ${(p.url || '').slice(0, 60)}`);

  // ---- 2. secret params ----
  const events = db
    .prepare('SELECT id, url, canonical_url, type, tab_id, ts FROM events')
    .all() as unknown as EventRow[];
  const authEvents = events.filter((e) => isSensitiveUrl(e.url));
  const redactEvents = events.filter((e) => !isSensitiveUrl(e.url) && e.url && redact(e.url) !== e.url);
  const redactPages = pages.filter(
    (p) => !isSensitiveUrl(p.url || p.canonical_url) && p.url && redact(p.url) !== p.url,
  );
  log(`  event urls to blank (auth flow) .. ${authEvents.length}`);
  log(`  event urls to redact ............. ${redactEvents.length}`);
  log(`  page urls to redact .............. ${redactPages.length}`);

  // Titles too. Chrome reports the raw URL as the title until the page supplies one, so an OAuth
  // request can sit in `title` while `url` was already clean — a leak URL redaction cannot see.
  const titleRows = db
    .prepare("SELECT id, title FROM events WHERE title IS NOT NULL AND title LIKE '%=%'")
    .all() as unknown as { id: number; title: string }[];
  const badTitles = titleRows.filter((r) => redactTextParams(r.title) !== r.title);
  const pageTitleRows = db
    .prepare("SELECT canonical_url, title FROM pages WHERE title IS NOT NULL AND title LIKE '%=%'")
    .all() as unknown as { canonical_url: string; title: string }[];
  const badPageTitles = pageTitleRows.filter((r) => redactTextParams(r.title) !== r.title);
  log(`  titles carrying a secret ......... ${badTitles.length} event + ${badPageTitles.length} page`);
  for (const r of badPageTitles.slice(0, 4)) log(`      - ${r.title.slice(0, 84)}`);

  // ---- vestigial columns ----
  //
  // `status` and `liveness` were stored before those values became read-derived, and nothing has read or
  // written them since. A dead column is not inert: on a real database the stored `status` was wrong for
  // 20 of 24 rows, only ever held `forming`/`live` (the two values the old writer knew how to produce),
  // and `liveness` was 0 everywhere — so anyone opening the file would reasonably conclude decay was
  // broken. This lives here rather than in db.ts because DROP COLUMN rewrites the table, and that should
  // happen behind a backup and a daemon check, not unprompted at boot.
  const trailCols = (db.prepare('PRAGMA table_info(trails)').all() as unknown as { name: string }[]).map(
    (c) => c.name,
  );
  const vestigial = ['status', 'liveness'].filter((c) => trailCols.includes(c));
  log(`  vestigial columns to drop ........ ${vestigial.length ? vestigial.join(', ') : 'none'}`);

  // ---- 3. visit_count from the log ----
  //
  // The pipeline's rule, replayed: a navigate counts only when the tab actually moved to a different
  // url than it last showed, AND the event is strictly newer than the page's last sighting. That second
  // clause is what makes a re-delivered batch (same original timestamps) a no-op. `close` clears the
  // tab's memory, exactly as the live path does.
  const tabCanon = new Map<number, string>();
  const lastSeen = new Map<string, number>();
  const recomputed = new Map<string, number>();
  for (const e of events) {
    const url = isSensitiveUrl(e.url) ? null : redact(e.url);
    const canon = url ? (canonicalize(url)?.canonical ?? null) : null;
    const tab = e.tab_id ?? -1;
    if (e.type === 'close') {
      tabCanon.delete(tab);
      continue;
    }
    if (!canon) continue;
    const moved = tabCanon.get(tab) !== canon;
    tabCanon.set(tab, canon);
    const seen = lastSeen.get(canon);
    if (seen === undefined) {
      recomputed.set(canon, 1);
      lastSeen.set(canon, e.ts);
      continue;
    }
    if (e.type === 'navigate' && moved && e.ts > seen)
      recomputed.set(canon, (recomputed.get(canon) ?? 1) + 1);
    lastSeen.set(canon, Math.max(seen, e.ts));
  }

  const current = db.prepare('SELECT canonical_url, visit_count FROM pages').all() as unknown as {
    canonical_url: string;
    visit_count: number;
  }[];
  const drops = current
    .map((c) => {
      const canonOf = (u: string) => canonicalize(redact(u) || u)?.canonical ?? u;
      return { url: c.canonical_url, from: c.visit_count, to: recomputed.get(canonOf(c.canonical_url)) ?? 1 };
    })
    .filter((d) => d.from !== d.to)
    .sort((a, b) => b.from - b.to - (a.from - a.to));
  log(`  pages with a wrong visit_count ... ${drops.length}`);
  for (const d of drops.slice(0, 8))
    log(`      ${String(d.from).padStart(5)} -> ${String(d.to).padEnd(4)} ${d.url.slice(0, 62)}`);
  if (drops.length > 8) log(`      ... and ${drops.length - 8} more`);

  if (!APPLY) {
    log('\n  Nothing written. Re-run with --apply to make these changes.\n');
    return;
  }

  // ---- apply ----
  const backup = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(DB_PATH, backup);
  hardenPath(backup); // the backup is a full browsing history too
  log(`\n  backup written .................. ${backup}`);

  // A privacy repair that leaves the secret bytes in the file has not repaired anything. By default
  // SQLite marks freed pages as reusable without overwriting them, so a deleted URL stays readable with
  // `strings` until something happens to reuse that page. secure_delete zeroes them on free instead.
  db.exec('PRAGMA secure_delete = ON');

  db.exec('BEGIN');
  try {
    // 1 + 2: events. Auth flows lose their address; everything else gets redacted in place.
    const blank = db.prepare('UPDATE events SET url = NULL, canonical_url = NULL WHERE id = ?');
    for (const e of authEvents) blank.run(e.id);
    const setEv = db.prepare('UPDATE events SET url = ?, canonical_url = ? WHERE id = ?');
    for (const e of redactEvents) {
      const u = redact(e.url)!;
      setEv.run(u, canonicalize(u)?.canonical ?? null, e.id);
    }

    // Auth-flow pages: drop the row outright.
    const delPage = db.prepare('DELETE FROM pages WHERE canonical_url = ?');
    const touchedTrails = new Set<string>();
    for (const p of authPages) {
      if (p.trail_id) touchedTrails.add(p.trail_id);
      delPage.run(p.canonical_url);
    }
    // Their checkpoint membership goes too, or resurrect would try to reopen a page that no longer exists.
    for (const p of authPages)
      db.prepare('DELETE FROM checkpoint_pages WHERE canonical_url = ?').run(p.canonical_url);

    // Remaining pages: redact url, recompute canonical. A redaction can make two rows collide
    // (`?token=a` and `?token=b` both become `?token=REDACTED`) — keep the first, drop the duplicate.
    for (const p of redactPages) {
      const u = redact(p.url)!;
      const newCanon = canonicalize(u)?.canonical ?? p.canonical_url;
      if (newCanon !== p.canonical_url) {
        const clash = db.prepare('SELECT 1 FROM pages WHERE canonical_url = ?').get(newCanon);
        if (clash) {
          delPage.run(p.canonical_url);
          continue;
        }
      }
      db.prepare('UPDATE pages SET url = ?, canonical_url = ? WHERE canonical_url = ?').run(
        u,
        newCanon,
        p.canonical_url,
      );
    }

    // Titles carrying a URL-borne secret.
    const setEvTitle = db.prepare('UPDATE events SET title = ? WHERE id = ?');
    for (const r of badTitles) setEvTitle.run(redactTextParams(r.title), r.id);
    const setPgTitle = db.prepare('UPDATE pages SET title = ? WHERE canonical_url = ?');
    for (const r of badPageTitles) setPgTitle.run(redactTextParams(r.title), r.canonical_url);

    // 3: visit counts, from the log.
    const setVisits = db.prepare('UPDATE pages SET visit_count = ? WHERE canonical_url = ?');
    for (const row of db.prepare('SELECT canonical_url FROM pages').all() as unknown as {
      canonical_url: string;
    }[]) {
      setVisits.run(recomputed.get(row.canonical_url) ?? 1, row.canonical_url);
    }

    // 4: rebuild page_count and centroid for trails that lost pages, and re-dirty them so the next
    // enrichment pass renames/recaps anything whose contents changed under it.
    for (const trailId of touchedTrails) {
      const rows = db
        .prepare('SELECT title, description, url, canonical_url FROM pages WHERE trail_id = ?')
        .all(trailId) as unknown as PageRow[];
      if (!rows.length) {
        db.prepare('DELETE FROM trails WHERE id = ?').run(trailId);
        db.prepare('DELETE FROM checkpoint_pages WHERE trail_id = ?').run(trailId);
        continue;
      }
      const cen: Record<string, number> = {};
      for (const r of rows) {
        const c = canonicalize(r.url || r.canonical_url);
        if (!c) continue;
        for (const [k, v] of Object.entries(bag(tokenize(r.title || '', c, r.description || '')))) {
          cen[k] = (cen[k] ?? 0) + v;
        }
      }
      db.prepare(
        'UPDATE trails SET page_count = ?, centroid = ?, label_dirty = 1, summary_dirty = 1, engram_dirty = 1 WHERE id = ?',
      ).run(rows.length, JSON.stringify(cen), trailId);
    }

    // Any page can also disappear through the collision path above (two urls redacting to the same
    // canonical), not just through the auth-flow removal — so sweep checkpoint membership generally
    // rather than only for the rows we explicitly deleted. A dangling entry would otherwise sit in a
    // working set forever, pointing at a page that no longer exists.
    const orphans = db
      .prepare('DELETE FROM checkpoint_pages WHERE canonical_url NOT IN (SELECT canonical_url FROM pages)')
      .run();
    if (orphans.changes) log(`  orphaned checkpoint rows swept .. ${orphans.changes}`);

    // Vestigial columns. DROP COLUMN fails if a column is indexed; neither of these is, and the whole
    // thing is best-effort — losing a cleanup must not lose the rest of the repair.
    for (const col of vestigial) {
      try {
        db.exec(`ALTER TABLE trails DROP COLUMN ${col}`);
      } catch (e) {
        log(`  could not drop trails.${col}: ${(e as Error).message}`);
      }
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(
      `\n  FAILED, rolled back: ${(e as Error).message}\n  Your data is unchanged; the backup is at ${backup}\n`,
    );
    process.exit(1);
  }

  // Fold the WAL back in and rebuild the file, so the freed (now zeroed) pages actually leave it.
  // VACUUM alone leaves a -wal behind still holding the old pages.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  hardenPath(DB_PATH);
  log('\n  Done. Restart the daemon.\n');
}

await main();
