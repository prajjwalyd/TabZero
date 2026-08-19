// Which database does a given invocation open?
//
// There are two layouts — <repo>/.tabzero for a dev checkout, ~/.tabzero for an install — and exactly one
// question decides between them. It used to be answered partly by process.cwd(), which meant an INSTALLED
// copy run from inside a clone adopted the clone's database and .env, while the same command run from a
// different directory used ~/.tabzero. That is a silent split: `tabzero search` reports an empty history
// and nothing looks wrong. Observed for real — `npx github:prajjwalyd/TabZero` from a checkout staged its
// extension under ~/.tabzero while writing the Engram key into the repo's .env.
//
// config.ts imports nothing but node: builtins, so copying that one file somewhere else is a faithful
// stand-in for an installed copy: `here` lands outside any repo, which is the whole point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = join(repo, 'node_modules', '.bin', 'tsx');

/** DB_PATH as the config.ts at `mod` resolves it, imported by absolute path with cwd `cwd`. */
function resolveDbPathOf(mod: string, cwd: string, home: string): string {
  const r = spawnSync(TSX, ['-e', `import('${mod}').then((m) => console.log(m.DB_PATH));`], {
    cwd,
    encoding: 'utf8',
    // Every override cleared: the point is what the *defaults* resolve to.
    env: {
      ...process.env,
      HOME: home,
      NODE_NO_WARNINGS: '1',
      TABZERO_DATA: '',
      TABZERO_ROOT: '',
      TABZERO_DB: '',
    },
  });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The same, for a copy of config.ts placed at `dir` — i.e. code that lives outside any repo. */
function resolveDbPath(dir: string, cwd: string, home: string): string {
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, 'config.ts');
  copyFileSync(join(repo, 'server', 'src', 'core', 'config.ts'), copy);
  return resolveDbPathOf(copy, cwd, home);
}

test('an installed copy keeps its own data dir even when run from inside a clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabzero-datadir-'));
  try {
    // cwd is the repo — the tempting, wrong signal — but the code lives outside it.
    const dbPath = resolveDbPath(join(root, 'installed'), repo, join(root, 'home'));
    assert.equal(
      dbPath,
      join(root, 'home', '.tabzero', 'tabzero.db'),
      'an install must not adopt the checkout it happens to be launched from',
    );
    assert.ok(!dbPath.startsWith(repo), `it must never reach into the repo: ${dbPath}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dev checkout still uses the repo, whatever directory you launch it from', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabzero-datadir-'));
  try {
    // The real in-repo config.ts, launched with cwd somewhere else entirely: `pnpm backend` from a
    // subdirectory, a script invoked by absolute path, an editor task. All must stay on the dev database.
    const dbPath = resolveDbPathOf(
      join(repo, 'server', 'src', 'core', 'config.ts'),
      root,
      join(root, 'home'),
    );
    assert.equal(
      dbPath,
      join(repo, '.tabzero', 'tabzero.db'),
      'code living in the repo means the repo data dir, regardless of cwd',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
