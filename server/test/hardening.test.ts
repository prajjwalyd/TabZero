// Two guarantees that are established at MODULE IMPORT, so they can only be tested by starting a fresh
// process with a chosen environment. Both were open before: the data files were world-readable, and
// ENGRAM_BASE was never checked for a scheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8).padStart(4, '0');

const SRC = (f: string) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);

/**
 * Boot config/db in a fresh child process with a chosen env. A child is required because both
 * guarantees are established at module import, and `-e` cannot resolve relative specifiers — so the
 * script is written to a file and imports the source by absolute file: URL.
 */
function boot(env: Record<string, string>, script: string): { status: number | null; stderr: string } {
  const f = join(mkdtempSync(join(tmpdir(), 'tabzero-boot-')), 'boot.mts');
  writeFileSync(f, script);
  const r = spawnSync(join(repo, 'node_modules', '.bin', 'tsx'), [f], {
    cwd: repo,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    encoding: 'utf8',
  });
  rmSync(join(f, '..'), { recursive: true, force: true });
  return { status: r.status, stderr: (r.stderr || '') + (r.stdout || '') };
}

test('the data dir and every DB file are created owner-only, even under a permissive umask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabzero-perm-'));
  try {
    // umask 000 is the adversarial case: without an explicit chmod, SQLite would create -wal/-shm 0666.
    const r = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', TABZERO_PORT: '8783' },
      `process.umask(0o000);
       const { db } = await import(${SRC('core/db.ts')});
       db.prepare('INSERT INTO events (ts, type) VALUES (?, ?)').run(Date.now(), 'navigate');`,
    );
    assert.equal(r.status, 0, `boot failed: ${r.stderr}`);

    assert.equal(mode(dir), '0700', 'the data directory must not be traversable by others');
    for (const f of ['tabzero.db', 'tabzero.db-wal', 'tabzero.db-shm']) {
      const p = join(dir, f);
      try { statSync(p); } catch { continue; } // -wal/-shm vanish on a clean close
      assert.equal(mode(p), '0600', `${f} must be owner-only — it is (part of) the browsing history`);
    }
    assert.equal(mode(join(dir, 'token')), '0600', 'the auth token must be owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a .env holding API keys is clamped to owner-only on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabzero-env-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'ENGRAM_API_KEY=eng_notarealkey\n', { mode: 0o644 }); // the bad starting state
    assert.equal(mode(envFile), '0644', 'precondition: starts world-readable');

    const r = boot(
      { TABZERO_DATA: dir, TABZERO_ROOT: dir, TABZERO_PORT: '8784' },
      `await import(${SRC('core/config.ts')});`,
    );
    assert.equal(r.status, 0, `boot failed: ${r.stderr}`);
    assert.equal(mode(envFile), '0600', 'the file holding the Engram key must be clamped on load');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plaintext ENGRAM_BASE is refused at boot rather than leaking the key over the wire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabzero-tls-'));
  try {
    // Every Engram request carries `Authorization: Bearer <key>` AND the page titles, so http:// would
    // put both in the clear. Failing loudly is the only safe behaviour.
    const bad = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: 'eng_notarealkey', ENGRAM_BASE: 'http://api.engram.weaviate.io/v1', TABZERO_PORT: '8785' },
      `await import(${SRC('core/config.ts')}); console.log('BOOTED');`,
    );
    assert.notEqual(bad.status, 0, 'plaintext base must abort the boot');
    assert.ok(/https/i.test(bad.stderr), `the error should say what is wrong: ${bad.stderr.slice(0, 200)}`);
    assert.ok(!/BOOTED/.test(bad.stderr), 'must not proceed past the check');

    // https is fine...
    const good = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: 'eng_notarealkey', ENGRAM_BASE: 'https://api.engram.weaviate.io/v1', TABZERO_PORT: '8786' },
      `await import(${SRC('core/config.ts')}); console.log('BOOTED');`,
    );
    assert.ok(/BOOTED/.test(good.stderr), `https must be accepted: ${good.stderr.slice(0, 200)}`);

    // ...and so is a loopback mock, which is the documented exception for local development.
    const loop = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: 'eng_notarealkey', ENGRAM_BASE: 'http://127.0.0.1:9999/v1', TABZERO_PORT: '8788' },
      `await import(${SRC('core/config.ts')}); console.log('BOOTED');`,
    );
    assert.ok(/BOOTED/.test(loop.stderr), `loopback must stay usable: ${loop.stderr.slice(0, 200)}`);

    // With no key set nothing is transmitted, so the check must not block an offline user.
    const off = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', ENGRAM_BASE: 'http://whatever.test/v1', TABZERO_PORT: '8789' },
      `await import(${SRC('core/config.ts')}); console.log('BOOTED');`,
    );
    assert.ok(/BOOTED/.test(off.stderr), 'no key means nothing is sent — do not block local mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a FRESH install gets the complete schema — there are no migrations to fall back on', () => {
  // The schema is declared once now, in CREATE TABLE, with no ALTERs behind it. That makes this the test
  // that matters: removing the migrations silently dropped `last_engram_push` and `summary_source` from
  // new installs, because those two had only ever been added by ALTER. Both are load-bearing (the Engram
  // re-push budget; the frozen-recap fix), and a fresh clone would have failed on the first write that
  // touched them. Exercising the writes is the proof — a missing column is a hard SQLite error.
  const dir = mkdtempSync(join(tmpdir(), 'tabzero-fresh-'));
  try {
    const r = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', TABZERO_PORT: '8777' },
      [
        `const { db } = await import(${SRC('core/db.ts')});`,
        "db.prepare(\"INSERT INTO trails (id,label,created,last_active,centroid,page_count,session_count) VALUES ('t_1','x',1,1,'{}',2,1)\").run();",
        "db.prepare('UPDATE trails SET summary = ?, summary_source = ?, summary_dirty = 0 WHERE id = ?').run('a recap','engram','t_1');",
        "db.prepare('UPDATE trails SET engram_dirty = 0, engram_ref = ?, last_engram_push = ? WHERE id = ?').run('run_1',2,'t_1');",
        "db.prepare(\"INSERT INTO pages (canonical_url,url,title,domain,first_seen,last_seen,tokens,description) VALUES ('u','u','t','d',1,1,'[]','desc')\").run();",
        "db.prepare(\"INSERT INTO events (ts,type,url,canonical_url,title,description) VALUES (1,'navigate','u','u','t','desc')\").run();",
        "console.log(JSON.stringify(db.prepare('SELECT summary_source, last_engram_push FROM trails WHERE id = ?').get('t_1')));",
      ].join('\n'),
    );
    assert.equal(r.status, 0, `a fresh install could not complete its own writes: ${r.stderr}`);
    const row = JSON.parse(r.stderr.trim().split('\n').filter((l) => l.startsWith('{')).pop()!);
    assert.equal(row.summary_source, 'engram', 'summary_source must exist and round-trip');
    assert.equal(row.last_engram_push, 2, 'last_engram_push must exist and round-trip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vestigial columns are dropped by repair, and never silently at boot', () => {
  // Moved out of db.ts deliberately: DROP COLUMN rewrites the table, and that belongs behind a backup and
  // a daemon check rather than happening unprompted on someone's only copy of their browsing history.
  const dir = mkdtempSync(join(tmpdir(), 'tabzero-vest-'));
  const legacy = [
    'CREATE TABLE trails (',
    '  id TEXT PRIMARY KEY, label TEXT, one_liner TEXT, status TEXT, created INTEGER,',
    '  last_active INTEGER, liveness REAL, summary TEXT, summary_dirty INTEGER DEFAULT 1,',
    '  label_dirty INTEGER DEFAULT 1, engram_dirty INTEGER DEFAULT 1, engram_ref TEXT,',
    "  centroid TEXT DEFAULT '{}', page_count INTEGER DEFAULT 0, session_count INTEGER DEFAULT 1,",
    '  category TEXT, last_engram_push INTEGER, summary_source TEXT )',
  ].join(' ');
  try {
    const seed = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', TABZERO_PORT: '8778' },
      [
        "const { DatabaseSync } = await import('node:sqlite');",
        `const d = new DatabaseSync(${JSON.stringify(join(dir, 'tabzero.db'))});`,
        `d.exec(${JSON.stringify(legacy)});`,
        "d.prepare('INSERT INTO trails (id,label,status,created,last_active,liveness,page_count,session_count) VALUES (?,?,?,?,?,?,?,?)').run('t_legacy','Legacy trail','live',1,1,0,5,2);",
        'd.close();',
      ].join('\n'),
    );
    assert.equal(seed.status, 0, `seeding the legacy db failed: ${seed.stderr}`);

    // Booting the daemon must leave the table alone.
    const afterBoot = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', TABZERO_PORT: '8779' },
      [
        `const { db } = await import(${SRC('core/db.ts')});`,
        "console.log(JSON.stringify(db.prepare('PRAGMA table_info(trails)').all().map((c) => c.name)));",
      ].join('\n'),
    );
    assert.equal(afterBoot.status, 0, afterBoot.stderr);
    const bootCols = JSON.parse(afterBoot.stderr.trim().split('\n').filter((l) => l.startsWith('[')).pop()!);
    assert.ok(bootCols.includes('status'), 'boot must not rewrite the table unprompted');

    // repair --apply is what removes them, and the row must survive.
    const rep = boot(
      { TABZERO_DATA: dir, ENGRAM_API_KEY: '', TABZERO_PORT: '8781' },
      [
        "process.argv.push('--apply');",
        `await import(${SRC('scripts/repair.ts')});`,
        `const { db } = await import(${SRC('core/db.ts')});`,
        "console.log(JSON.stringify({ cols: db.prepare('PRAGMA table_info(trails)').all().map((c) => c.name), row: db.prepare('SELECT id,label,page_count,session_count FROM trails').get() }));",
      ].join('\n'),
    );
    assert.equal(rep.status, 0, `repair failed: ${rep.stderr}`);
    const { cols, row } = JSON.parse(rep.stderr.trim().split('\n').filter((l) => l.startsWith('{')).pop()!);
    assert.ok(!cols.includes('status'), `status survived repair: ${cols.join(',')}`);
    assert.ok(!cols.includes('liveness'), `liveness survived repair: ${cols.join(',')}`);
    assert.equal(row.id, 't_legacy', 'the row survived');
    assert.equal(row.page_count, 5, 'page_count — what status is DERIVED from — must not be lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
