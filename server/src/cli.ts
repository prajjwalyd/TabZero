// `tabzero` CLI — one-command setup, plus the query surface any agent can shell out to.
// IMPORTANT: this file must not import anything that pulls in `node:sqlite` (db/index), because it
// may run on a Node that needs --experimental-sqlite. The daemon is launched as a child process with
// that flag added when the Node version requires it, and the query commands go over HTTP to the
// running daemon rather than opening the database a second time.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  intro, outro, password, confirm, spinner, log, isCancel, cancel,
} from '@clack/prompts';
import { ENV_PATH, DATA_DIR, PORT, TOKEN, hardenPath } from './core/config.js';
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
  try { spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}

/** True if a Tab Zero daemon is already answering on the configured port. */
async function isDaemonUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
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
  ].map((l) => '  ' + l).join('\n');
  process.stdout.write(`\n${g}${art}${rst}\n\n`);
}

function bail<T>(v: T | symbol): T {
  if (isCancel(v)) { cancel('Setup cancelled.'); process.exit(0); }
  return v as T;
}

function requireNode(): void {
  if (NODE_OK) return;
  cancel(`Tab Zero needs Node 22.5+ (24 recommended). You're on ${process.versions.node}. Try: nvm install 24`);
  process.exit(1);
}

// --- .env upsert (for the Engram key) ---
function saveEnv(key: string, val: string): void {
  mkdirSync(dirname(ENV_PATH), { recursive: true, mode: 0o700 });
  const line = `${key}=${val}`;
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  body = re.test(body) ? body.replace(re, line) : (body && !body.endsWith('\n') ? body + '\n' : body) + line + '\n';
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
  log.info(`${bold('Weaviate Engram key')} adds semantic search + agent memory (optional).\nSetup guide -> ${link(DOCS_ENGRAM, DOCS_ENGRAM)}`);
  const key = bail(await password({
    message: 'Paste your Engram API key, or press Enter to skip (local mode)',
    mask: '•',
  }));
  const trimmed = (key || '').trim();
  if (!trimmed) { log.info('Skipped — local mode (semantic search + agent memory stay off until you add a key).'); return; }
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
  if (r.status === 401) return fail('Unauthorized — the daemon is running with a different token. Restart it.');
  if (!r.ok) return fail(`Tab Zero returned ${r.status} for ${path}.`);
  try { return await r.json(); } catch { return fail(`Tab Zero returned invalid JSON for ${path}.`); }
}

/** JSON when --json, else the human rendering. */
function emit(json: boolean, data: unknown, human: () => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human()) + '\n');
}

function trailLine(t: any): string {
  const bits = [t.category, `${t.pageCount} pages`, t.status].filter(Boolean).join(', ');
  return `${t.id}\t${t.label}  (${bits})`;
}

/** Resolve a trail id from an id or a natural-language description. */
async function resolveTrail(q: string): Promise<string> {
  if (/^t_/.test(q)) return q;
  const { hits } = await apiCall('/search', { method: 'POST', body: { query: q, limit: 1 } });
  const id = hits?.[0]?.trail?.id;
  if (!id) return fail(`No trail matched "${q}".`);
  return id;
}

async function cmdSearch(query: string, json: boolean): Promise<void> {
  const { hits } = await apiCall('/search', { method: 'POST', body: { query, limit: 8 } });
  emit(json, hits, () =>
    hits.length
      ? hits.map((h: any) => `${trailLine(h.trail)}  [${h.why}]`).join('\n')
      : 'No trails matched.');
}

async function cmdTrails(json: boolean, includeArchived: boolean): Promise<void> {
  const { trails } = await apiCall(`/trails${includeArchived ? '?archived=1' : ''}`);
  emit(json, trails, () => (trails.length ? trails.map(trailLine).join('\n') : 'No trails yet.'));
}

async function cmdTrail(q: string, json: boolean): Promise<void> {
  const d = await apiCall(`/trails/${encodeURIComponent(await resolveTrail(q))}?summarize=1`);
  emit(json, d, () =>
    [`${d.label}  (${d.id})`, '', d.summary || '(no recap yet)', '', ...d.pages.map((p: any) => `- ${p.title}\n  ${p.url}`)].join('\n'));
}

async function cmdResurrect(q: string, json: boolean): Promise<void> {
  const id = await resolveTrail(q);
  const r = await apiCall(`/trails/${encodeURIComponent(id)}/resurrect`, { method: 'POST' });
  emit(json, r, () => [`${r.label}  (${r.id})`, '', r.summary || '(no recap yet)', '', ...r.urls].join('\n'));
}

async function cmdWeek(json: boolean): Promise<void> {
  const w = await apiCall('/week');
  emit(json, w, () =>
    [w.headline, '', ...w.stats.map((s: any) => `${s.label}: ${s.value}${s.detail ? ` (${s.detail})` : ''}`)].join('\n'));
}

async function cmdInterests(json: boolean): Promise<void> {
  const r = await apiCall('/interests');
  emit(json, r, () =>
    r.interests.length
      ? r.interests.map((i: any) => `${i.label}  —  ${i.detail}`).join('\n')
      : 'No durable interests yet — they need a few recurring or deep trails.');
}

function startDaemon(): void {
  const child = spawn(process.execPath, [...SQLITE_FLAG, INDEX_JS], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/** Make `tabzero` a bare command: `npm link` from the repo (dev), `npm i -g` once published. */
function installGlobal(): { ok: boolean; detail: string } {
  const args = IS_REPO ? ['link'] : ['i', '-g', 'tabzero'];
  const r = spawnSync('npm', args, { stdio: 'ignore', cwd: IS_REPO ? PKG_ROOT : undefined });
  if (r.status === 0) return { ok: true, detail: IS_REPO ? 'npm link' : 'npm i -g tabzero' };
  return { ok: false, detail: 'needs different permissions, or the package isn’t published yet' };
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
    log.error(IS_REPO ? 'Run `pnpm build:ext` first.' : 'This install is missing extension/dist — please reinstall.');
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
  const reveal = bail(await confirm({ message: 'Open the extension folder now (to drag into Load unpacked)?', initialValue: true }));
  if (reveal) openExternal(dest);

  await askEngramKey();

  log.step(
    `${bold('Use it from any agent')}\n` +
    `Any agent with shell access can query your trails — nothing to install, nothing to restart:\n` +
    `  tabzero search "gpu pricing"\n  tabzero resurrect "that trip planning"\n  tabzero week\n` +
    `Add --json for machine-readable output; \`tabzero help\` lists every command.`,
  );

  const wantGlobal = bail(await confirm({
    message: 'Install `tabzero` as a global command, so you can skip `npx` next time?',
    initialValue: true,
  }));
  if (wantGlobal) {
    const gs = spinner();
    gs.start('Installing globally…');
    const r = installGlobal();
    gs.stop(r.ok ? 'Installed — run `tabzero` directly from now on.' : 'Skipped the global install.');
    if (!r.ok) log.warn(`Couldn't install globally (${r.detail}). Keep using \`npx tabzero\`.`);
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
    outro('All set. Run `npx tabzero start` whenever you want the daemon running.');
  }
}

async function cmdKey(value?: string): Promise<void> {
  intro('Engram key');
  let key = value;
  if (!key) {
    log.info(`Setup guide: ${link(DOCS_ENGRAM, DOCS_ENGRAM)}`);
    key = bail(await password({ message: 'Paste your Weaviate Engram API key', mask: '•' })) as string;
  }
  const trimmed = (key || '').trim();
  if (!trimmed) { cancel('No key entered.'); process.exit(0); }
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
  if (existsSync(EXT_DEST)) { rmSync(EXT_DEST, { recursive: true, force: true }); log.info('Removed the staged extension folder.'); }

  // 2. All data — destructive, opt-in.
  const wipe = bail(await confirm({
    message: `Delete ALL Tab Zero data (${DATA_DIR}) — trails, memory, and your saved Engram key? This cannot be undone.`,
    initialValue: false,
  }));
  if (wipe) { rmSync(DATA_DIR, { recursive: true, force: true }); log.success('All data deleted — clean state.'); }
  else log.info(`Kept your data in ${DATA_DIR}.`);

  // Best-effort: drop the global `tabzero` command if one was installed.
  const g = IS_REPO ? spawnSync('npm', ['unlink'], { stdio: 'ignore', cwd: PKG_ROOT }) : spawnSync('npm', ['rm', '-g', 'tabzero'], { stdio: 'ignore' });
  if (g.status === 0) log.info('Removed the global `tabzero` command.');

  outro('Done. Remove the browser extension at chrome://extensions, and stop any running daemon with Ctrl-C.');
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
    '  tabzero uninstall          Remove everything + (optionally) all data\n\n' +
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
const FLAGS = new Set(['--json', '--all']);
const [cmd, ...rest] = argv.filter((a) => !FLAGS.has(a));
const arg = rest.join(' '); // let queries go unquoted: `tabzero search gpu pricing`

switch (cmd) {
  case undefined:
  case 'setup': await cmdSetup(); break;
  case 'start': await cmdStart(); break;
  case 'key': await cmdKey(rest[0]); break;
  case 'path': cmdPath(); break;
  case 'uninstall': await cmdUninstall(); break;

  case 'search': await cmdSearch(arg, JSON_OUT); break;
  case 'trails': await cmdTrails(JSON_OUT, SHOW_ALL); break;
  case 'trail':
    if (!arg) fail('Usage: tabzero trail <id|query>');
    await cmdTrail(arg, JSON_OUT);
    break;
  case 'resurrect':
    if (!arg) fail('Usage: tabzero resurrect <id|query>');
    await cmdResurrect(arg, JSON_OUT);
    break;
  case 'week': await cmdWeek(JSON_OUT); break;
  case 'interests': await cmdInterests(JSON_OUT); break;

  case 'version': case '--version': case '-v': process.stdout.write(VERSION + '\n'); break;
  case 'help': case '--help': case '-h': usage(); break;
  default: usage(); process.exit(1);
}
