// `tabzero` CLI — one-command setup, plus the query surface any agent can shell out to.
// IMPORTANT: this file must not import anything that pulls in `node:sqlite` (db/index), because it
// may run on a Node that needs --experimental-sqlite. The daemon is launched as a child process with
// that flag added when the Node version requires it, and the query commands go over HTTP to the
// running daemon rather than opening the database a second time.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { intro, outro, password, confirm, spinner, log, isCancel, cancel } from '@clack/prompts';
import { ENV_PATH, DATA_DIR, PORT, TOKEN, hardenPath } from './core/config.js';
import { explainGlobalFailure, planGlobalInstall } from './core/global-command.js';
import { looksLikeId, pickByLabel } from './core/trail-ref.js';
import { VERSION } from './core/version.js';

const REPO = 'https://github.com/prajjwalyd/TabZero';
const DOCS_ENGRAM = `${REPO}/blob/main/docs/engram.md`;

// --- environment / paths ---
const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/server/dist
const PKG_ROOT = join(here, '..', '..'); // <pkg>
const IS_REPO = existsSync(join(PKG_ROOT, 'tsconfig.base.json'));
const EXT_SRC = join(PKG_ROOT, 'extension', 'dist');
const EXT_DEST = join(homedir(), '.tabzero', 'extension');
const INDEX_JS = join(PKG_ROOT, 'server', 'dist', 'index.js');

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const NODE_OK = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 5); // node:sqlite lands in 22.5
const SQLITE_FLAG = NODE_MAJOR === 22 || NODE_MAJOR === 23 ? ['--experimental-sqlite'] : []; // flagless from Node 24

/** OSC 8 terminal hyperlink — cmd/ctrl-click to open. Renders as the plain label where unsupported. */
function link(label: string, url: string): string {
  const OSC = '\x1b]8;;';
  const ST = '\x1b\\';
  return `${OSC}${url}${ST}${label}${OSC}${ST}`;
}

/** Bold text (headings). */
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

/** Open a URL / reveal a folder with the OS default handler (best-effort, never throws). */
function openExternal(target: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore */
  }
}

/** True if a Tab Zero daemon is already answering on the configured port. */
async function isDaemonUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Retro block banner in Tab Zero green. */
function banner(): void {
  const g = '\x1b[38;2;93;138;95m';
  const rst = '\x1b[0m';
  const art = [
    '████████╗ █████╗ ██████╗   ███████╗███████╗██████╗  ██████╗',
    '╚══██╔══╝██╔══██╗██╔══██╗  ╚══███╔╝██╔════╝██╔══██╗██╔═══██╗',
    '   ██║   ███████║██████╔╝    ███╔╝ █████╗  ██████╔╝██║   ██║',
    '   ██║   ██╔══██║██╔══██╗   ███╔╝  ██╔══╝  ██╔══██╗██║   ██║',
    '   ██║   ██║  ██║██████╔╝  ███████╗███████╗██║  ██║╚██████╔╝',
    '   ╚═╝   ╚═╝  ╚═╝╚═════╝   ╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝',
  ]
    .map((l) => '  ' + l)
    .join('\n');
  process.stdout.write(`\n${g}${art}${rst}\n\n`);
}

function bail<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  return v;
}

function requireNode(): void {
  if (NODE_OK) return;
  cancel(
    `Tab Zero needs Node 22.5+ (24 recommended). You're on ${process.versions.node}. Try: nvm install 24`,
  );
  process.exit(1);
}

// --- .env upsert (for the Engram key) ---
function saveEnv(key: string, val: string): void {
  mkdirSync(dirname(ENV_PATH), { recursive: true, mode: 0o700 });
  const line = `${key}=${val}`;
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  body = re.test(body)
    ? body.replace(re, line)
    : (body && !body.endsWith('\n') ? body + '\n' : body) + line + '\n';
  // 0600 explicitly: this file holds the Engram / OpenRouter API keys, and writeFileSync's default
  // 0666-minus-umask leaves it world-readable. `mode` is only applied on create, so chmod after too —
  // otherwise re-running `tabzero key` on an existing 0644 file would silently keep it 0644.
  writeFileSync(ENV_PATH, body, { mode: 0o600 });
  hardenPath(ENV_PATH);
}

// --- steps ---
function stageExtension(): string | null {
  if (!existsSync(EXT_SRC)) return null;
  mkdirSync(dirname(EXT_DEST), { recursive: true });
  cpSync(EXT_SRC, EXT_DEST, { recursive: true });
  return EXT_DEST;
}

async function askEngramKey(): Promise<void> {
  log.info(
    `${bold('Weaviate Engram key')} adds semantic search + agent memory (optional).\nSetup guide -> ${link(DOCS_ENGRAM, DOCS_ENGRAM)}`,
  );
  const key = bail(
    await password({
      message: 'Paste your Engram API key, or press Enter to skip (local mode)',
      mask: '•',
    }),
  );
  const trimmed = (key || '').trim();
  if (!trimmed) {
    log.info('Skipped — local mode (semantic search + agent memory stay off until you add a key).');
    return;
  }
  saveEnv('ENGRAM_API_KEY', trimmed);
  log.success('Engram key saved.');
}

// --- query surface (what an agent shells out to) ---
//
// These talk to the running daemon over HTTP instead of opening SQLite: it keeps this file free of
// node:sqlite (see the header note), avoids a second writer on the database, and reuses the exact
// API the extension already uses. Everything writes plain JSON to stdout under --json so an agent
// can parse it without scraping prose; errors go to stderr with a non-zero exit.

/** Fail cleanly: message on stderr, non-zero exit, no clack chrome (agents parse this). */
function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

async function apiCall(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: init?.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-tabzero-token': TOKEN },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60000), // recaps can involve an LLM call
    });
  } catch {
    return fail(`Tab Zero isn't running on http://127.0.0.1:${PORT}. Start it with \`tabzero start\`.`);
  }
  if (r.status === 401)
    return fail('Unauthorized — the daemon is running with a different token. Restart it.');
  if (!r.ok) return fail(`Tab Zero returned ${r.status} for ${path}.`);
  try {
    return await r.json();
  } catch {
    return fail(`Tab Zero returned invalid JSON for ${path}.`);
  }
}

/** JSON when --json, else the human rendering. */
function emit(json: boolean, data: unknown, human: () => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human()) + '\n');
}

function trailLine(t: any): string {
  const bits = [t.category, `${t.pageCount} pages`, t.status].filter(Boolean).join(', ');
  return `${t.id}\t${t.label}  (${bits})`;
}

/**
 * Resolve a trail id from an id, a label, or a description — in that order of certainty.
 *
 * Semantic search used to be the only path for anything that was not an id, which made naming a trail
 * depend on an embedding: Engram always returns something, so a typo resolved to a confident wrong
 * answer, and `resurrect` then reopens that trail's tabs. Labels are matched exactly first, and only a
 * real description reaches search. Archived trails are included — reaching an old trail by name is
 * exactly what this is for.
 *
 * How it resolved goes to stderr, so it is visible without polluting --json on stdout.
 */
async function resolveTrail(q: string): Promise<string> {
  const query = q.trim();
  if (looksLikeId(query)) return query;

  const { trails } = await apiCall('/trails?archived=1');
  const pick = pickByLabel(Array.isArray(trails) ? trails : [], query);
  if (pick.kind === 'ambiguous') {
    return fail(
      `"${query}" matches ${pick.matches.length} trails — use an id:\n` +
        pick.matches.map((m) => `  ${m.id}\t${m.label}`).join('\n'),
    );
  }
  if (pick.kind === 'one') {
    process.stderr.write(`matched ${pick.how === 'exact' ? 'label' : 'label fragment'}: ${pick.ref.label}\n`);
    return pick.ref.id;
  }

  const { hits } = await apiCall('/search', { method: 'POST', body: { query, limit: 1 } });
  const top = hits?.[0]?.trail;
  if (!top?.id) return fail(`No trail matched "${query}".`);
  process.stderr.write(`matched by meaning: ${top.label}\n`);
  return top.id;
}

async function cmdSearch(query: string, json: boolean): Promise<void> {
  const { hits } = await apiCall('/search', { method: 'POST', body: { query, limit: 8 } });
  emit(json, hits, () => {
    if (!hits.length) return 'No trails matched.';
    const lines = hits.map((h: any) => trailLine(h.trail));
    // Search is semantic; a `[semantic]` suffix on every line said nothing. The one case worth a word is
    // the local-mode fallback, where there is no Engram to ask and these are literal matches instead.
    if (hits.every((h: any) => h.why === 'keyword')) {
      lines.push('', '(Engram is off — these are text matches, not meaning.)');
    }
    return lines.join('\n');
  });
}

async function cmdTrails(json: boolean, includeArchived: boolean): Promise<void> {
  const { trails } = await apiCall(`/trails${includeArchived ? '?archived=1' : ''}`);
  emit(json, trails, () => (trails.length ? trails.map(trailLine).join('\n') : 'No trails yet.'));
}

async function cmdTrail(q: string, json: boolean): Promise<void> {
  const d = await apiCall(`/trails/${encodeURIComponent(await resolveTrail(q))}?summarize=1`);
  emit(json, d, () =>
    [
      `${d.label}  (${d.id})`,
      '',
      d.summary || '(no recap yet)',
      '',
      ...d.pages.map((p: any) => `- ${p.title}\n  ${p.url}`),
    ].join('\n'),
  );
}

async function cmdResurrect(q: string, json: boolean): Promise<void> {
  const id = await resolveTrail(q);
  const r = await apiCall(`/trails/${encodeURIComponent(id)}/resurrect`, { method: 'POST' });
  emit(json, r, () => [`${r.label}  (${r.id})`, '', r.summary || '(no recap yet)', '', ...r.urls].join('\n'));
}

async function cmdWeek(json: boolean): Promise<void> {
  const w = await apiCall('/week');
  emit(json, w, () =>
    [
      w.headline,
      '',
      ...w.stats.map((s: any) => `${s.label}: ${s.value}${s.detail ? ` (${s.detail})` : ''}`),
    ].join('\n'),
  );
}

async function cmdInterests(json: boolean): Promise<void> {
  const r = await apiCall('/interests');
  emit(json, r, () =>
    r.interests.length
      ? r.interests.map((i: any) => `${i.label}  —  ${i.detail}`).join('\n')
      : 'No durable interests yet — they need a few recurring or deep trails.',
  );
}

function startDaemon(): void {
  const child = spawn(process.execPath, [...SQLITE_FLAG, INDEX_JS], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Make `tabzero` a bare command.
 *
 * From a clone, `npm link` from the repo root. Otherwise install from GitHub — NOT `npm i -g tabzero`,
 * which is what this used to do and which 404s: Tab Zero is distributed straight from the repo, not
 * through the npm registry. `files` deliberately excludes tsconfig.base.json, so a GitHub install has
 * IS_REPO=false and took exactly that broken branch.
 */
const GH_SPEC = 'github:prajjwalyd/TabZero';

const realpathSafe = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/**
 * The target of an existing `tabzero` SYMLINK in npm's global folder, or null.
 *
 * One `npm root -g` (a few hundred ms) in exchange for not spending forty seconds on an install that
 * cannot succeed — see planGlobalInstall. Returns null on any doubt, so the fallback is always "just try
 * the install", i.e. the previous behaviour.
 */
function globalLinkTarget(): string | null {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const root = r.status === 0 ? (r.stdout || '').trim() : '';
  if (!root) return null;
  try {
    const p = join(root, 'tabzero');
    return lstatSync(p).isSymbolicLink() ? realpathSync(p) : null;
  } catch { return null; }
}

/** Does `tabzero` actually resolve on PATH? npm can install successfully to a prefix that isn't on it. */
function commandResolves(): boolean {
  const r = spawnSync('tabzero', ['version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

type GlobalInstall = { ok: true } | { ok: false; reason: string; fix: string[] };

function installGlobal(): GlobalInstall {
  const args = IS_REPO ? ['link'] : ['i', '-g', GH_SPEC];
  const cmd = IS_REPO ? 'npm link' : `npm i -g ${GH_SPEC}`;
  // Piped, not ignored: the output IS the diagnosis. Without it the only honest message would be
  // "something went wrong", and the only honest remedy "try again".
  const r = spawnSync('npm', args, { cwd: IS_REPO ? PKG_ROOT : undefined, encoding: 'utf8' });
  if (r.error) {
    const missing = (r.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      reason: missing ? 'npm is not on your PATH.' : `npm could not be run (${r.error.message}).`,
      fix: missing ? ['# install Node.js with npm bundled, then re-run this'] : [cmd],
    };
  }
  if (r.status === 0) return { ok: true };
  return { ok: false, ...explainGlobalFailure(`${r.stdout || ''}\n${r.stderr || ''}`, cmd) };
}

// --- commands ---
async function cmdSetup(): Promise<void> {
  requireNode();
  banner();
  intro('Install');
  const s = spinner();
  s.start('Preparing the extension…');
  const dest = stageExtension();
  s.stop(dest ? 'Extension ready.' : 'Extension build not found.');
  if (!dest) {
    log.error(
      IS_REPO ? 'Run `pnpm build:ext` first.' : 'This install is missing extension/dist — please reinstall.',
    );
    process.exit(1);
  }
  // A log block (not a note box) so the links can be real OSC 8 hyperlinks — clickable and copyable —
  // without breaking a box border. Both are also plain URLs, so they select cleanly.
  log.step(
    `${bold('One-time browser setup')}\n` +
      `1. Open -> ${link('chrome://extensions', 'chrome://extensions')}\n` +
      `2. Enable Developer mode\n` +
      `3. Load unpacked from this folder ->` +
      ` ${link(dest, 'file://' + dest)}`,
  );
  const reveal = bail(
    await confirm({
      message: 'Open the extension folder now (to drag into Load unpacked)?',
      initialValue: true,
    }),
  );
  if (reveal) openExternal(dest);

  await askEngramKey();

  log.step(
    `${bold('Use it from any agent')}\n` +
      `Any agent with shell access can query your trails — nothing to install, nothing to restart:\n` +
      `  tabzero search "gpu pricing"\n  tabzero resurrect "that trip planning"\n  tabzero week\n` +
      `Add --json for machine-readable output; \`tabzero help\` lists every command.`,
  );

  const wantGlobal = bail(
    await confirm({
      message: 'Install `tabzero` as a global command, so you can skip `npx` next time?',
      initialValue: true,
    }),
  );
  if (wantGlobal) {
    const plan = planGlobalInstall({
      link: globalLinkTarget(), pkgRoot: realpathSafe(PKG_ROOT), isRepo: IS_REPO, spec: GH_SPEC,
    });
    if (plan.action === 'skip') {
      // Answering yes and getting an instant, accurate answer — the command works either way.
      log.success(plan.message);
      if (plan.fix) {
        log.info(`To hand the command to this copy instead:\n${plan.fix.map((c) => `  ${c}`).join('\n')}`);
      }
    } else {
      const gs = spinner();
      // Say how long: `npm i -g` on a git spec clones and builds, and an unexplained 40-second pause
      // reads as a hang.
      gs.start(IS_REPO ? 'Linking `tabzero`…' : 'Installing `tabzero` — clones and builds, up to a minute…');
      const r = installGlobal();
      // "Skipped" would be a lie here — the user said yes and we tried. Say it failed, say why, and give
      // a command that is different from the one that just failed.
      gs.stop(r.ok ? 'Installed — run `tabzero` directly from now on.' : 'Global install failed.');
      if (!r.ok) {
        log.warn(
          `${r.reason}\n${bold('To fix it:')}\n` +
          r.fix.map((c) => `  ${c}`).join('\n') +
          `\nNothing is broken meanwhile — \`npx ${GH_SPEC}\` does everything \`tabzero\` does.`,
        );
      } else if (!commandResolves()) {
        // npm reported success but the shim landed somewhere PATH doesn't look. Silence here is how you
        // get "you're all set" followed by `command not found`.
        log.warn(
          'Installed, but `tabzero` does not resolve yet.\n' +
          'Open a new shell, or add the `bin` folder inside `npm prefix -g` to your PATH.',
        );
      }
    }
  }

  if (await isDaemonUp()) {
    outro(`Tab Zero is already running on http://127.0.0.1:${PORT} — you're all set.`);
    return;
  }
  const start = bail(await confirm({ message: 'Start the Tab Zero daemon now?', initialValue: true }));
  if (start) {
    outro(`Data lives in ${DATA_DIR}. Starting the daemon — leave this running while you browse.`);
    startDaemon();
  } else {
    outro(
      `All set. Run \`tabzero start\` (or \`npx ${GH_SPEC} start\`) whenever you want the daemon running.`,
    );
  }
}

async function cmdKey(value?: string): Promise<void> {
  intro('Engram key');
  let key = value;
  if (!key) {
    log.info(`Setup guide: ${link(DOCS_ENGRAM, DOCS_ENGRAM)}`);
    key = bail(await password({ message: 'Paste your Weaviate Engram API key', mask: '•' }));
  }
  const trimmed = (key || '').trim();
  if (!trimmed) {
    cancel('No key entered.');
    process.exit(0);
  }
  saveEnv('ENGRAM_API_KEY', trimmed);
  outro(`Saved to ${ENV_PATH}. Restart the daemon to pick it up.`);
}

async function cmdStart(): Promise<void> {
  requireNode();
  if (await isDaemonUp()) {
    process.stdout.write(`Tab Zero is already running on http://127.0.0.1:${PORT}\n`);
    return;
  }
  stageExtension();
  startDaemon();
}

function cmdPath(): void {
  const dest = stageExtension() || EXT_SRC;
  process.stdout.write(dest + '\n');
}

async function cmdUninstall(): Promise<void> {
  banner();
  intro('Uninstall');

  // 1. The staged extension copy (always under ~/.tabzero).
  if (existsSync(EXT_DEST)) {
    rmSync(EXT_DEST, { recursive: true, force: true });
    log.info('Removed the staged extension folder.');
  }

  // 2. Data is KEPT unless --purge is passed. Uninstalling is usually "stop running this", not "erase my
  //    browsing history", and those should not share a keystroke. Everything needed to resume lives in
  //    DATA_DIR — the database, the auth token, and (installed) the .env holding the Engram key and
  //    user id — so leaving it means a reinstall continues from the same trails and the same Engram
  //    memories instead of a blank slate.
  if (!PURGE) {
    log.info(
      `Kept all your data in ${DATA_DIR}.\n` +
        'Reinstalling picks up exactly where you left off — same trails, same Engram memories.\n' +
        'To erase it instead: `tabzero uninstall --purge`.',
    );
  } else {
    // --yes is the only way to consent without a TTY; absent it a non-interactive run must fail safe.
    const wipe =
      ASSUME_YES ||
      bail(
        await confirm({
          message: `Delete ALL Tab Zero data (${DATA_DIR}) — trails, memory, and your saved Engram key? This cannot be undone.`,
          initialValue: false,
        }),
      );
    if (wipe) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      log.success('All data deleted — clean state.');
    } else log.info(`Kept your data in ${DATA_DIR}.`);
  }

  // Best-effort: drop the global `tabzero` command if one was installed.
  const g = IS_REPO
    ? spawnSync('npm', ['unlink'], { stdio: 'ignore', cwd: PKG_ROOT })
    : spawnSync('npm', ['rm', '-g', 'tabzero'], { stdio: 'ignore' });
  if (g.status === 0) log.info('Removed the global `tabzero` command.');

  outro(
    'Done. Remove the browser extension at chrome://extensions, and stop any running daemon with Ctrl-C.',
  );
}

function usage(): void {
  process.stdout.write(
    'tabzero — close every tab guilt-free\n\n' +
      'Setup:\n' +
      '  tabzero                    Interactive setup (extension + optional Engram key), then start\n' +
      '  tabzero start              Start the local daemon\n' +
      '  tabzero key [value]        Save your Weaviate Engram API key\n' +
      '  tabzero path               Print the extension folder to load unpacked\n' +
      '  tabzero version            Print the installed version\n' +
      '  tabzero uninstall          Stop running it; your trails are KEPT for a reinstall\n' +
      '  tabzero uninstall --purge  …and erase all data too (add --yes to skip the prompt)\n\n' +
      'Query your browsing memory (for you, or any agent with a shell):\n' +
      '  tabzero search [query]     Search trails; empty query lists all, newest first\n' +
      '  tabzero trails [--all]     List trails; --all includes archived (quiet >30d)\n' +
      '  tabzero trail <id|query>   One trail: recap + its pages\n' +
      '  tabzero resurrect <query>  Recap + the exact URLs to reopen\n' +
      '  tabzero week               Stats: deepest rabbit hole, time sinks, late nights\n' +
      '  tabzero interests          Durable cross-trail interests\n\n' +
      'Add --json to any query command for machine-readable output.\n',
  );
}

// --- dispatch ---
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const SHOW_ALL = argv.includes('--all');
// Non-interactive consent for the one destructive prompt. Without this, `uninstall` could not be
// scripted OR tested: clack's confirm needs a TTY, and the only alternative was answering by hand.
const ASSUME_YES = argv.includes('--yes') || argv.includes('-y');
// Deleting the database is opt-IN via an explicitly named flag, not a prompt you can fat-finger. An
// uninstall keeps your trails by default, so reinstalling resumes from the same database and the same
// Engram scope rather than starting over.
const PURGE = argv.includes('--purge');
const FLAGS = new Set(['--json', '--all', '--yes', '-y', '--purge']);
const [cmd, ...rest] = argv.filter((a) => !FLAGS.has(a));
const arg = rest.join(' '); // let queries go unquoted: `tabzero search gpu pricing`

switch (cmd) {
  case undefined:
  case 'setup':
    await cmdSetup();
    break;
  case 'start':
    await cmdStart();
    break;
  case 'key':
    await cmdKey(rest[0]);
    break;
  case 'path':
    cmdPath();
    break;
  case 'uninstall':
    await cmdUninstall();
    break;

  case 'search':
    await cmdSearch(arg, JSON_OUT);
    break;
  case 'trails':
    await cmdTrails(JSON_OUT, SHOW_ALL);
    break;
  case 'trail':
    if (!arg) fail('Usage: tabzero trail <id|query>');
    await cmdTrail(arg, JSON_OUT);
    break;
  case 'resurrect':
    if (!arg) fail('Usage: tabzero resurrect <id|query>');
    await cmdResurrect(arg, JSON_OUT);
    break;
  case 'week':
    await cmdWeek(JSON_OUT);
    break;
  case 'interests':
    await cmdInterests(JSON_OUT);
    break;

  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(VERSION + '\n');
    break;
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    usage();
    process.exit(1);
}
