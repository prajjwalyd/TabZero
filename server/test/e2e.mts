// Full-lifecycle end-to-end check: a FRESH database, the real daemon and scheduler, the real LLM, and
// the real Engram project under a throwaway user scope. Nothing here touches your live data dir or a
// daemon already running on the default port.
//
//   pnpm build && pnpm test:e2e
//
// Requires ENGRAM_API_KEY (steps 4-5 exercise the live pipeline) and a built server/dist. Takes a few
// minutes: it waits out the 25s settle gate, a real LLM labelling pass, and Engram's async extraction,
// which has been observed to take over four minutes on the free tier. Override the Engram scope with
// TABZERO_E2E_USER; purge that user in the Engram console afterwards to clean up.
//
// This is deliberately NOT part of `pnpm test` — that suite is hermetic, offline, and instant.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.TABZERO_E2E_PORT || 8931);
// Unique per run: trail ids restart at t_1 on a fresh DB, so a fixed scope would let a PREVIOUS
// run's memory for t_1 satisfy this run's recap-upgrade check.
const USER = process.env.TABZERO_E2E_USER || `tz-e2e-${Date.now().toString(36)}`;
const DATA = mkdtempSync(join(tmpdir(), 'tz-e2e-'));
process.env.TABZERO_DATA = DATA; // isolate this process too, so importing the client below is clean
const env = { ...process.env, TABZERO_DATA: DATA, TABZERO_PORT: String(PORT), TABZERO_USER_ID: USER };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const daemon = spawn(process.execPath, [join(REPO, 'server/dist/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let dlog = '';
daemon.stdout.on('data', (d) => (dlog += d));
daemon.stderr.on('data', (d) => (dlog += d));

async function api(path: string, init?: { method?: string; body?: unknown; token?: string }) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.token ? { 'x-tabzero-token': init.token } : {}) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}

// --- wait for boot ---
let health: any = null;
for (let i = 0; i < 60 && !health; i++) {
  try { const h = await api('/health'); if (h.json?.ok) health = h.json; } catch { /* not up */ }
  if (!health) await sleep(500);
}
if (!health) { console.log('daemon never came up:\n' + dlog); process.exit(1); }

console.log('\n## 1. boot + auth bootstrap');
check(!!health.token, 'GET /health hands out a token (extension bootstrap path)', `len ${health.token?.length}`);
check(health.token === readFileSync(join(DATA, 'token'), 'utf8').trim(), 'token matches the 0600 file on disk');
check(health.engram === true, 'Engram enabled for this run');
check((await api('/trails')).status === 401, 'unauthenticated read is rejected', '401');
const TOKEN = health.token;
check((await api('/trails', { token: TOKEN })).status === 200, 'authenticated read is accepted', '200');
console.log('  llm backend:', health.llm, '| user:', health.userId);

// --- realistic browsing, shaped exactly as background.ts sends it ---
const t0 = Date.now() - 5 * 60_000;
type Ev = Record<string, unknown>;
const evs: Ev[] = [];
let ts = t0;
const visit = (tab: number, win: number, url: string, title: string, desc: string, opener?: number) => {
  evs.push({ ts: (ts += 1500), type: 'open', tabId: tab, windowId: win, ...(opener ? { openerTabId: opener } : {}) });
  evs.push({ ts: (ts += 200), type: 'activate', tabId: tab, windowId: win });
  evs.push({ ts: (ts += 800), type: 'navigate', tabId: tab, windowId: win, url, title });
  evs.push({ ts: (ts += 600), type: 'meta', tabId: tab, windowId: win, url, title, heading: title, description: desc });
  evs.push({ ts: (ts += 400), type: 'navigate', tabId: tab, windowId: win, url, title }); // duplicate tick, as Chrome does
};
// Trail A — SQLite concurrency research (4 pages, one link-opened)
visit(101, 1, 'https://sqlite.org/wal.html', 'Write-Ahead Logging', 'SQLite WAL mode allows readers and one writer to proceed concurrently without blocking each other.');
visit(102, 1, 'https://sqlite.org/lockingv3.html', 'File Locking And Concurrency In SQLite Version 3', 'How SQLite implements file locking, rollback journals, and the transition to WAL journalling.', 101);
visit(103, 1, 'https://sqlite.org/pragma.html#pragma_busy_timeout', 'PRAGMA busy_timeout', 'Set how long a connection waits for a lock before returning SQLITE_BUSY.');
visit(104, 1, 'https://kerkour.com/sqlite-for-servers', 'SQLite Concurrency Tuning For Servers', 'Practical settings for using SQLite under concurrent server load: WAL, busy timeout, synchronous NORMAL.');
// Trail B — unrelated shopping (3 pages) so clustering has to separate them
visit(201, 2, 'https://baristahustle.com/blogs/barista-hustle/grind-size-distribution', 'Grind Size Distribution', 'Why particle distribution matters more than average grind size for espresso extraction.');
visit(202, 2, 'https://www.seattlecoffeegear.com/products/df64-grinder', 'DF64 Single Dose Espresso Grinder', 'Flat burr single dose grinder for espresso, 64mm burrs, low retention.');
visit(203, 2, 'https://home-barista.com/grinders/df64-review-t12345.html', 'DF64 Grinder Long Term Review', 'Long term impressions of the DF64 espresso grinder, burr alignment and retention.');

console.log('\n## 2. ingest (POST /events, exactly the extension payload)');
const ing = await api('/events', { method: 'POST', token: TOKEN, body: { events: evs } });
check(ing.json?.ok === true && ing.json?.count === evs.length, 'all events accepted', `${ing.json?.count}/${evs.length}`);

const db = new DatabaseSync(join(DATA, 'tabzero.db'));
const q = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const pages = q('SELECT canonical_url, trail_id, visit_count FROM pages ORDER BY first_seen');
check(pages.length === 7, 'seven pages deduped from 35 events', `${pages.length} pages`);
check(pages.every((p) => p.visit_count === 1), 'duplicate navigate ticks did NOT inflate visit_count',
  `max ${Math.max(...pages.map((p) => p.visit_count))}`);

const trailA = pages.find((p) => p.canonical_url.includes('wal.html'))!.trail_id;
const trailB = pages.find((p) => p.canonical_url.includes('grind-size'))!.trail_id;
check(trailA !== trailB, 'the two topics formed separate trails', `${trailA} vs ${trailB}`);
check(pages.filter((p) => p.trail_id === trailA).length === 4, 'SQLite trail holds its 4 pages');
const espresso = pages.filter((p) => !p.canonical_url.includes('sqlite.org') && !p.canonical_url.includes('kerkour'));
const espressoTrails = new Set(espresso.map((p) => p.trail_id));
check(!espressoTrails.has(trailA), 'no espresso page leaked into the SQLite trail (the real invariant)');
console.log(`    espresso pages split across ${espressoTrails.size} trail(s): ${[...espressoTrails].join(', ')} — lexical clustering, no embeddings`);
check(pages.find((p) => p.canonical_url.includes('lockingv3'))!.trail_id === trailA,
  'link-opened tab followed its opener into the SQLite trail');

console.log('\n## 2b. duplicate batch delivery (the extension queue bug, at the HTTP boundary)');
const before = q('SELECT canonical_url, visit_count FROM pages ORDER BY canonical_url');
for (let i = 0; i < 5; i++) await api('/events', { method: 'POST', token: TOKEN, body: { events: evs } });
const after = q('SELECT canonical_url, visit_count FROM pages ORDER BY canonical_url');
check(JSON.stringify(before) === JSON.stringify(after),
  'five identical re-deliveries changed no visit_count',
  `max before ${Math.max(...before.map((p) => p.visit_count))} / after ${Math.max(...after.map((p) => p.visit_count))}`);
check(q('SELECT COUNT(*) c FROM pages')[0].c === 7, 'and created no duplicate page rows');

console.log('\n## 3. enrichment (real LLM, after the 25s settle gate)');
let labelled: any = null;
for (let i = 0; i < 40 && !labelled; i++) {
  await sleep(5000);
  const rows = q('SELECT id,label,one_liner,category,label_dirty,summary,summary_source FROM trails WHERE label_dirty = 0 AND one_liner IS NOT NULL');
  if (rows.length >= 2) labelled = rows;
  process.stdout.write(`  …waiting for enrich pass (${(i + 1) * 5}s, ${rows.length}/2 labelled)\r`);
}
console.log('');
check(!!labelled, 'both trails were labelled by the real LLM');
for (const t of labelled ?? []) {
  console.log(`    ${t.id}  "${t.label}"  [${t.category}]  ${t.one_liner ?? ''}`);
  check(!!t.label && t.label.length > 3, `${t.id} has a real label`);
  check(!!t.category, `${t.id} got a category`);
}

console.log('\n## 4. Engram push');
let pushed: any = null;
for (let i = 0; i < 30 && !pushed; i++) {
  const rows = q('SELECT id,engram_dirty,engram_ref,last_engram_push FROM trails WHERE engram_dirty = 0 AND engram_ref IS NOT NULL');
  if (rows.length >= 2) pushed = rows; else await sleep(5000);
  process.stdout.write(`  …waiting for Engram flush (${(i + 1) * 5}s, ${rows.length}/2 pushed)\r`);
}
console.log('');
check(!!pushed, 'both trails pushed to Engram (engram_dirty cleared, run id stored)');
if (pushed) console.log('    run ids:', pushed.map((p: any) => p.engram_ref).join(', '));

console.log('\n## 5. recap upgrade: local placeholder -> Engram reconciled');
// Split this by ownership. Engram's extraction latency is NOT ours — observed anywhere from ~2 to
// over 7 minutes on the free tier — but our read path resolving a memory once it exists IS. So wait
// for the memory to appear on Engram's side, then assert our upgrade. If extraction never lands in
// the window, say so plainly rather than failing the build on someone else's queue; the read path is
// verified deterministically the moment a memory does exist.
const { engramSearch } = await import(join(REPO, 'server/src/engram/client.ts'));
let memory: any = null;
for (let i = 0; i < 28 && !memory; i++) {
  const hits = await engramSearch(USER, 'SQLite concurrency WAL');
  memory = hits.find((h: any) => h.trailId === trailA) ?? null;
  process.stdout.write(`  …waiting for Engram extraction (${(i + 1) * 15}s)   \r`);
  if (!memory) await sleep(15000);
}
console.log('');
if (!memory) {
  console.log('  SKIP  Engram had not extracted within 7min — upstream latency, not a code path');
} else {
  console.log('  Engram extracted the memory; now checking our read path upgrades the cached recap');
  const d = await api(`/trails/${trailA}?summarize=1`, { token: TOKEN });
  const src = q('SELECT summary_source FROM trails WHERE id = ?', trailA)[0]?.summary_source;
  check(src === 'engram', 'cached recap upgraded to summary_source=engram once the memory existed', `source=${src}`);
  const served = String(d.json?.summary ?? '').trim();
  check(served === memory.content.trim(),
    'the served recap IS the Engram memory, not a local placeholder that merely looks similar',
    served === memory.content.trim() ? '' : `served ${served.length}ch vs memory ${memory.content.trim().length}ch`);
  console.log('    recap:', String(d.json?.summary).slice(0, 140).replace(/\s+/g, ' '));
}

console.log('\n## 6. tab zero checkpoint');
const openUrls = pages.filter((p) => p.trail_id === trailA).slice(0, 3).map((p) => p.canonical_url);
const zero = await api('/zero', { method: 'POST', token: TOKEN, body: { openUrls } });
check(zero.json?.ok === true, 'POST /zero succeeded');
check(typeof zero.json?.checkpointId === 'number', 'checkpoint row created', `id ${zero.json?.checkpointId}`);
check(zero.json?.finalized >= 1, 'trails finalized at the checkpoint', `${zero.json?.finalized}`);
console.log('    zero result:', JSON.stringify({ ...zero.json, trails: undefined }));

console.log('\n## 7. resurrection = checkpoint set UNION anything since');
const r1 = await api(`/trails/${trailA}/resurrect`, { method: 'POST', token: TOKEN });
check(r1.json?.urls?.length === 3, 'returns exactly the 3 checkpointed tabs, not all 4', `${r1.json?.urls?.length}`);
// now browse one MORE page into that trail, without zeroing again
await api('/events', { method: 'POST', token: TOKEN, body: { events: [
  { ts: Date.now(), type: 'navigate', tabId: 105, windowId: 1, url: 'https://sqlite.org/howtocorrupt.html', title: 'How To Corrupt An SQLite Database File' },
] } });
const r2 = await api(`/trails/${trailA}/resurrect`, { method: 'POST', token: TOKEN });
check(r2.json?.urls?.length === 4, 'a page visited after the checkpoint joins the reopen set', `${r2.json?.urls?.length}`);
check(r2.json.urls.some((u: string) => u.includes('howtocorrupt')), 'the new page is specifically included');

console.log('\n## 8. read surfaces');
const week = await api('/week', { token: TOKEN });
check(Array.isArray(week.json?.stats) && week.json.stats.length > 0, 'week stats render', `${week.json?.stats?.length} stats`);
check(!('emoji' in (week.json.stats[0] ?? {})), 'no dead emoji field on stats');
const search = await api('/search', { method: 'POST', token: TOKEN, body: { query: 'sqlite locking under concurrent writes' } });
check((search.json?.hits?.length ?? 0) > 0, 'semantic/keyword search finds the trail', `${search.json?.hits?.length} hits, why=${search.json?.hits?.[0]?.why}`);
// The semantic branch of searchTrails had never been exercised: every earlier query matched
// lexically, so `why` was always 'keyword'. Paraphrase deliberately, and require at least one hit the
// keyword pass could not have produced.
await sleep(3000); // let any throttling from the polling loop clear before the search assertions
const paraphrases = [
  'what did I decide about the coffee machine',
  'stopping two programs fighting over the same file',
  'keeping many readers from blocking one writer',
];
let semantic: any = null;
for (const qq of paraphrases) {
  const r = await api('/search', { method: 'POST', token: TOKEN, body: { query: qq } });
  const s2 = (r.json?.hits ?? []).find((h: any) => h.why === 'semantic');
  console.log(`    "${qq}" -> ${(r.json?.hits ?? []).map((h: any) => h.trail.id + ':' + h.why).join(', ') || 'no hits'}`);
  if (s2 && !semantic) semantic = { q: qq, hit: s2 };
}
check(!!semantic, 'the Engram semantic branch contributed a hit keyword could not',
  semantic ? `"${semantic.q}" -> ${semantic.hit.trail.id}` : 'only keyword hits across all paraphrases');
check(!semantic || typeof semantic.hit.snippet === 'string', 'semantic hits carry an Engram snippet');

const ints = await api('/interests', { token: TOKEN });
console.log('    interests source:', ints.json?.source, '| count:', ints.json?.interests?.length);

console.log('\n## daemon stderr');
const errs = dlog.split('\n').filter((l) => /error|unhandled|\[engram\]/i.test(l));
console.log(errs.length ? errs.slice(0, 6).map((l) => '    ' + l).join('\n') : '    (clean)');
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
console.log('engram scope used:', USER, '(purge this user in the console to clean up)');
daemon.kill();
rmSync(DATA, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
