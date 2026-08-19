// The `tabzero` CLI, including the destructive parts.
//
// This was the largest untested surface in the project, and the riskiest: `uninstall` deletes the staged
// extension unconditionally and can wipe the entire data directory. Testing it carelessly on a real
// machine destroys the developer's own browsing history — which is exactly why it went untested.
//
// Every side effect is redirected into a temp tree:
//   HOME          -> os.homedir(), which is where the staged extension lives (NOT TABZERO_DATA)
//   TABZERO_DATA  -> the database + token
//   TABZERO_ROOT  -> ENV_PATH, so a test can never touch the repo's real .env
//   PATH          -> a stub `npm`, so `npm unlink` / `npm rm -g` are recorded instead of executed
//
// Without the HOME and PATH redirections in particular, a green test run would have deleted the
// developer's staged extension and unlinked their global command.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TSX = join(repo, 'node_modules', '.bin', 'tsx');
const CLI = join(repo, 'server', 'src', 'cli.ts');
const PORT = '8749';

let root: string;
const paths = () => ({
  home: join(root, 'home'),
  data: join(root, 'data'),
  stub: join(root, 'stub'),
  npmLog: join(root, 'npm.log'),
  extDest: join(root, 'home', '.tabzero', 'extension'),
});

function freshTree(): void {
  root = mkdtempSync(join(tmpdir(), 'tabzero-cli-'));
  const p = paths();
  mkdirSync(p.extDest, { recursive: true });
  mkdirSync(p.data, { recursive: true });
  mkdirSync(p.stub, { recursive: true });
  writeFileSync(join(p.extDest, 'manifest.json'), '{}');
  writeFileSync(join(p.data, 'token'), 'test-token\n');
  // A recorded, inert `npm`. If this is ever bypassed the real npm would unlink the global command.
  writeFileSync(join(p.stub, 'npm'), `#!/bin/sh\necho "npm $*" >> "${p.npmLog}"\nexit 0\n`);
  chmodSync(join(p.stub, 'npm'), 0o755);
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const p = paths();
  const r = spawnSync(TSX, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: p.home,
      TABZERO_DATA: p.data,
      TABZERO_ROOT: root,
      TABZERO_PORT: PORT,
      ENGRAM_API_KEY: '',
      PATH: `${p.stub}:${process.env.PATH}`,
      ...extraEnv,
    },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

beforeEach(freshTree);
after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- uninstall ----

test('uninstall --purge --yes removes the staged extension, the data, and the global command', () => {
  const p = paths();
  const r = run(['uninstall', '--purge', '--yes']);
  assert.equal(r.status, 0, `uninstall failed: ${r.out}`);
  assert.ok(!existsSync(p.extDest), 'the staged extension folder must be gone');
  assert.ok(!existsSync(p.data), 'the data directory must be gone when consent was given');
  assert.match(
    readFileSync(p.npmLog, 'utf8'),
    /npm (unlink|rm -g tabzero)/,
    'it must try to drop the global command',
  );
});

test('a plain uninstall KEEPS the data — no prompt, nothing lost', () => {
  // Uninstalling means "stop running this", not "erase my browsing history", and those must not share a
  // keystroke. Deletion now requires the explicitly named --purge; a plain uninstall does not even ask.
  const p = paths();
  const r = run(['uninstall']);
  assert.match(
    r.out,
    /Kept all your data|picks up exactly where/i,
    `a plain uninstall should say the data was kept: ${r.out.trim().slice(0, 200)}`,
  );
  assert.ok(existsSync(p.data), 'data must survive an unconfirmed uninstall');
  assert.ok(existsSync(join(p.data, 'token')), 'and specifically the token file');
  // The staged extension is documented as unconditional — it is a copy, not user data.
  assert.ok(!existsSync(p.extDest), 'the staged extension copy is still removed');
  assert.notEqual(r.status, null);
});

test('uninstall --purge without --yes still fails safe on a non-interactive run', () => {
  // No TTY, so the confirm cannot be answered. The only safe reading of "no answer" is "keep it".
  const p = paths();
  run(['uninstall', '--purge']);
  assert.ok(existsSync(p.data), 'unanswered --purge must not delete anything');
  assert.ok(existsSync(join(p.data, 'token')), 'and specifically not the token');
});

test('uninstall touches nothing outside the redirected HOME / data dir', () => {
  // Guards the isolation itself: if EXT_DEST ever stops deriving from homedir(), this test would start
  // deleting the real one and we want to know from a failure here, not from lost data.
  const decoy = join(root, 'decoy');
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'keep.txt'), 'untouched');
  run(['uninstall', '--purge', '--yes']);
  assert.ok(existsSync(join(decoy, 'keep.txt')), 'unrelated files must be untouched');
  assert.ok(existsSync(join(repo, 'package.json')), 'the repo itself must be untouched');
});

// ---- commands that need no daemon ----

test('--version prints just the version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+$/, `expected a bare semver, got ${JSON.stringify(r.out)}`);
});

test('help lists the agent query commands', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  for (const c of ['search', 'trails', 'resurrect', 'week', 'interests']) {
    assert.match(r.out, new RegExp(`tabzero ${c}`), `help should document \`tabzero ${c}\``);
  }
});

test('a query with no daemon running exits non-zero and says how to start it', () => {
  // The contract an agent depends on: failure is a non-zero exit plus a message on stderr, never a
  // silent empty result that reads as "you have no trails".
  for (const cmd of [['trails'], ['week'], ['interests'], ['search', 'anything']]) {
    const r = run(cmd);
    assert.notEqual(r.status, 0, `\`${cmd.join(' ')}\` must fail when the daemon is down`);
    assert.match(r.out, /isn't running|start it with/i, `unhelpful message for ${cmd[0]}: ${r.out.trim()}`);
  }
});

// ---- commands against a real daemon ----
//
// Started INSIDE the test that needs it, against that test's own fresh tree. A file-level daemon pinned
// one data directory while beforeEach handed each test a different one (so the CLI authenticated against
// the wrong token), and it stayed up during the "daemon is down" test, which then passed for the wrong
// reason. A distinct port keeps it from ever answering for the no-daemon assertions.
// A port per test: two daemons in sequence on one port race the socket release, and http.ts exits(1) on
// EADDRINUSE, so the second test found nothing listening.
let nextPort = 8740;

async function withDaemon(fn: (env: Record<string, string>) => Promise<void> | void): Promise<void> {
  const p = paths();
  const port = String(nextPort++);
  const env = { TABZERO_DATA: p.data, HOME: p.home, TABZERO_ROOT: root, TABZERO_PORT: port };
  const proc = spawn(TSX, [join(repo, 'server', 'src', 'index.ts')], {
    cwd: repo,
    stdio: 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ENGRAM_API_KEY: '', ...env },
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        up = res.ok;
      } catch {
        /* not up yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up, 'the daemon did not come up');
    await fn(env);
  } finally {
    proc.kill();
  }
}

test('the query commands emit parseable JSON under --json', async () => {
  await withDaemon((env) => {
    // The CLI unwraps the HTTP envelope: `trails --json` is a bare array, not {trails:[...]}. This is the
    // contract an agent parses, so the test asserts what the command actually prints.
    const trails = run(['trails', '--json'], env);
    assert.equal(trails.status, 0, `trails --json failed: ${trails.out}`);
    assert.ok(
      Array.isArray(JSON.parse(trails.out)),
      `trails --json must be a bare array, got ${trails.out.slice(0, 60)}`,
    );

    const week = run(['week', '--json'], env);
    assert.equal(week.status, 0, week.out);
    const wk = JSON.parse(week.out);
    assert.equal(typeof wk.headline, 'string');
    assert.ok(Array.isArray(wk.stats));

    const interests = run(['interests', '--json'], env);
    assert.equal(interests.status, 0, interests.out);
    assert.ok(['engram', 'local'].includes(JSON.parse(interests.out).source));

    const search = run(['search', 'anything', '--json'], env);
    assert.equal(search.status, 0, search.out);
    assert.ok(Array.isArray(JSON.parse(search.out)), 'search --json is a bare array of hits');
  });
});

test('resolving a trail that does not exist fails loudly rather than returning nothing', async () => {
  await withDaemon((env) => {
    const r = run(['trail', 'a-topic-nobody-has-ever-browsed'], env);
    assert.notEqual(r.status, 0, 'must not exit 0 on a miss');
    assert.match(r.out, /No trail matched/i, `expected a clear miss, got: ${r.out.trim()}`);
  });
});

test('uninstall then reinstall resumes from the same database and the same identity', async () => {
  // The whole point of keeping the data: a reinstall must continue the SAME memory, not start over. The
  // three things that make that true all live in DATA_DIR — the database, the auth token, and the stored
  // user_id (the Engram scope). This ingests real events, uninstalls, and boots again to prove it.
  const p = paths();
  let before: { trails: number; pages: number; userId: string; token: string };

  await withDaemon(async (env) => {
    const port = env.TABZERO_PORT;
    const token = readFileSync(join(p.data, 'token'), 'utf8').trim();
    const ev = (url: string, title: string, ts: number) => ({
      ts,
      type: 'navigate',
      tabId: 1,
      windowId: 1,
      url,
      title,
    });
    const now = Date.now();
    await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tabzero-token': token },
      body: JSON.stringify({
        events: [
          ev('https://kiln.example.com/glazes/celadon', 'Celadon Glaze Recipes', now),
          ev('https://kiln.example.com/glazes/tenmoku', 'Tenmoku Glaze Chemistry', now + 1000),
        ],
      }),
    });
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    before = { trails: h.trails, pages: h.pages, userId: h.userId, token };
    assert.ok(before.pages >= 2, `events should have been ingested, saw ${before.pages} pages`);
  });

  // Uninstall WITHOUT --purge.
  const un = run(['uninstall']);
  assert.ok(existsSync(join(p.data, 'tabzero.db')), 'the database must survive');
  assert.ok(existsSync(join(p.data, 'token')), 'the token must survive');
  assert.ok(!existsSync(p.extDest), 'only the staged extension copy is removed');
  assert.match(un.out, /Kept all your data/i);

  // "Reinstall": a fresh daemon against the untouched data dir.
  await withDaemon(async (env) => {
    const h = await (await fetch(`http://127.0.0.1:${env.TABZERO_PORT}/health`)).json();
    assert.equal(h.pages, before.pages, 'every page came back');
    assert.equal(h.trails, before.trails, 'every trail came back');
    assert.equal(h.userId, before.userId, 'same user id => the same Engram memories still match');
    assert.equal(
      readFileSync(join(p.data, 'token'), 'utf8').trim(),
      before.token,
      'same token => the extension re-authenticates without the user doing anything',
    );
    assert.equal(typeof h.version, 'string', '/health reports a version so skew is detectable');
  });
});

// ---- global install diagnosis ----
//
// The wizard's old failure message was three wrong things at once: it said "Skipped the global install"
// after the user said yes, it blamed permissions without having read npm's output (`stdio: 'ignore'`),
// and its remedy was the command that had just failed. These pin the replacement against real npm
// output — captured verbatim from `npm i -g github:prajjwalyd/TabZero` on a machine that had previously
// run `npm link`, which is the failure everyone who developed from a clone will hit.
const { explainGlobalFailure } = await import('../src/core/npm-error.js');
const CMD = 'npm i -g github:prajjwalyd/TabZero';

const NPM_ENOTDIR = `npm error code 236
npm error git dep preparation failed
npm error command /Users/x/.nvm/versions/node/v24.16.0/bin/node /usr/lib/npm/bin/npm-cli.js install --force
npm error npm warn using --force Recommended protections disabled.
npm error npm error code ENOTDIR
npm error npm error syscall rename
npm error npm error path /Users/x/.nvm/versions/node/v24.16.0/lib/node_modules/tabzero
npm error npm error dest /Users/x/.nvm/versions/node/v24.16.0/lib/node_modules/.tabzero-Kb4xmFD7
npm error npm error ENOTDIR: not a directory, rename '/Users/x/lib/node_modules/tabzero' -> '/Users/x/lib/node_modules/.tabzero-Kb4xmFD7'
npm error A complete log of this run can be found in: /Users/x/.npm/_logs/x-debug-0.log`;

test('a leftover `npm link` is named as the cause, and the fix removes it first', () => {
  const r = explainGlobalFailure(NPM_ENOTDIR, CMD);
  assert.match(r.reason, /link/i, `must name the link, not guess: ${r.reason}`);
  assert.doesNotMatch(r.reason, /permission/i, 'ENOTDIR has nothing to do with permissions');
  assert.equal(
    r.fix[0],
    'npm rm -g tabzero',
    'the first step must clear the link — retrying the same command fails the same way',
  );
  assert.ok(r.fix.includes(CMD), 'and then retry the install');
});

test('an unwritable global folder is the one case that does suggest sudo', () => {
  const r = explainGlobalFailure('npm error code EACCES\nnpm error Error: EACCES: permission denied', CMD);
  assert.match(r.reason, /not writable/i);
  assert.equal(r.fix[0], `sudo ${CMD}`);
});

test('an unrecognised failure quotes npm instead of inventing a cause', () => {
  const r = explainGlobalFailure(
    'npm error code ENOTFOUND\nnpm error command failed\nnpm error request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND',
    CMD,
  );
  assert.doesNotMatch(r.reason, /permission/i, 'a network failure must not be reported as permissions');
  assert.match(r.reason, /ENOTFOUND/, `must carry npm's own words: ${r.reason}`);
  // Bookkeeping lines are not a diagnosis.
  assert.doesNotMatch(r.reason, /^npm reported: (code|command|A complete log)/);
});
