import { BACKEND, authHeaders } from './config.js';
import { iconSvg, brandMark, STAT_ICON } from './icons.js';

const api = {
  get: async (p: string) => fetch(BACKEND + p, { headers: await authHeaders() }).then((r) => r.json()),
  post: async (p: string, body?: unknown) =>
    fetch(BACKEND + p, { method: 'POST', headers: await authHeaders(true), body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()),
};

interface Trail {
  id: string; label: string; oneLiner: string | null; status: string;
  liveness: number; pageCount: number; lastActive: number; topDomain: string | null; category: string;
}
interface Hit { trail: Trail; why: 'semantic' | 'keyword'; snippet?: string }
interface Stat { key: string; label: string; value: string; detail?: string }

// Display order + labels for category grouping (mirrors server/src/trails/categories.ts).
const CAT_ORDER = ['dev', 'learning', 'news', 'social', 'media', 'shopping', 'travel', 'finance', 'work', 'projects', 'general'];
const CAT_LABEL: Record<string, string> = {
  dev: 'Code & Docs', learning: 'Learning & Research', news: 'News & Reading', social: 'Social',
  media: 'Entertainment', shopping: 'Shopping', travel: 'Travel', finance: 'Finance',
  work: 'Work & Productivity', projects: 'Projects & DIY', general: 'Other',
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
function el(tag: string, cls?: string, txt?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function rel(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>;
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

let view: 'trails' | 'week' = 'trails';
let groupBy = false;

/**
 * Flag whether this platform uses classic (always-visible, gutter-reserving) scrollbars, so popup.css
 * only takes over the styling where that's already the native behaviour. Measuring is the only honest
 * test — an overlay scrollbar is painted over the content and so costs no layout width, while a
 * classic one narrows the client box. `overflow-y: scroll` forces the bar to exist for the probe.
 */
function markScrollbarMode(): void {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow-y:scroll';
  document.body.appendChild(probe);
  const classic = probe.offsetWidth > probe.clientWidth;
  probe.remove();
  document.documentElement.classList.toggle('classic-scrollbars', classic);
}

async function init(): Promise<void> {
  markScrollbarMode();
  $('brandMark').innerHTML = brandMark(22);
  $('searchIco').innerHTML = iconSvg('search', 15);
  $('refreshBtn').innerHTML = iconSvg('refresh', 15);
  $('gtIco').innerHTML = iconSvg('stack', 13);

  await refresh();
  document.querySelectorAll<HTMLElement>('.seg').forEach((t) =>
    t.addEventListener('click', () => {
      view = t.dataset.view as 'trails' | 'week';
      document.querySelectorAll('.seg').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      void render();
    }),
  );
  ($('search') as HTMLInputElement).addEventListener('input', debounce(onSearch, 280));
  $('nukeBtn').addEventListener('click', onNuke);
  $('refreshBtn').addEventListener('click', () => void refresh());
  $('groupToggle').addEventListener('click', () => {
    groupBy = !groupBy;
    $('groupToggle').classList.toggle('active', groupBy);
    void render();
  });
}

// Extension-wide refresh: re-check the backend, tab count, and re-render the current view.
let refreshing = false;
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const btn = $('refreshBtn');
  btn.classList.add('spinning');
  try {
    const h = await api.get('/health');
    setStatus(true, h);
    void updateTabCount();
    const q = view === 'trails' ? ($('search') as HTMLInputElement).value.trim() : '';
    if (q) await runSearch(q);
    else await render();
  } catch {
    setStatus(false);
    renderBackendDown();
  } finally {
    btn.classList.remove('spinning');
    refreshing = false;
  }
}

function setStatus(ok: boolean, h?: any): void {
  const s = $('status');
  s.className = 'status ' + (ok ? 'ok' : 'down');
  s.title = ok ? `connected · engram ${h.engram ? 'on' : 'off'} · llm ${h.llm} · ${h.trails} trails` : 'backend not running';
}

async function updateTabCount(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const n = tabs.filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('edge')).length;
    $('tabCount').textContent = String(n);
  } catch { $('tabCount').textContent = '–'; }
}

async function render(): Promise<void> {
  const isTrails = view === 'trails';
  $('searchWrap').style.display = isTrails ? 'block' : 'none';
  if (view === 'week') { $('listBar').style.display = 'none'; return renderWeek(); }
  const main = $('main');
  main.innerHTML = '';
  const { trails } = await api.get('/trails');
  const list = (trails as Trail[]) || [];

  const bar = $('listBar');
  bar.style.display = list.length ? 'flex' : 'none';
  $('listCount').textContent = `${list.length} trail${list.length === 1 ? '' : 's'}`;

  if (!list.length) {
    main.appendChild(el('div', 'empty', 'No trails yet. Browse a little — Tab Zero reconciles your open tabs into research trails automatically.'));
    return;
  }

  // Always newest-first.
  const sorted = list.slice().sort((a, b) => b.lastActive - a.lastActive);

  if (!groupBy) {
    // Flat, latest-first — each row carries a category pill.
    for (const t of sorted) main.appendChild(trailRow(t, undefined, undefined, true));
    return;
  }

  // Grouped by category; groups ordered by their most-recent trail. The header names the
  // category, so rows inside a group don't repeat it as a pill.
  const groups = new Map<string, Trail[]>();
  for (const t of sorted) {
    const k = CAT_ORDER.includes(t.category) ? t.category : 'general';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ra = Math.max(...groups.get(a)!.map((t) => t.lastActive));
    const rb = Math.max(...groups.get(b)!.map((t) => t.lastActive));
    return rb - ra || CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b);
  });
  for (const k of keys) {
    const items = groups.get(k)!;
    const head = el('div', 'cat-head');
    head.appendChild(el('span', 'cat-label', CAT_LABEL[k] || k));
    head.appendChild(el('span', 'cat-count', String(items.length)));
    main.appendChild(head);
    for (const t of items) main.appendChild(trailRow(t));
  }
}

function trailRow(t: Trail, why?: string, snippet?: string, pill = false): HTMLElement {
  const row = el('div', 'trail ' + t.status);

  const top = el('div', 'trail-top');
  const dot = el('span', 'dot');
  dot.title = t.status === 'dormant' ? 'Dormant trail — no recent activity' : 'Live trail — recently active';
  top.appendChild(dot);

  const h = el('div', 'trail-h');
  const label = el('div', 'trail-label');
  label.append(document.createTextNode(t.label));
  h.appendChild(label);
  // The category pill gets its own line so every card lines up regardless of title length.
  if (pill && t.category) {
    const pr = el('div', 'trail-pill');
    pr.appendChild(el('span', 'cat-pill', CAT_LABEL[t.category] || t.category));
    h.appendChild(pr);
  }
  top.appendChild(h);

  const btn = el('button', 'resurrect') as HTMLButtonElement;
  const setBtn = (txt: string) => { btn.innerHTML = iconSvg('resurrect', 13) + `<span>${txt}</span>`; };
  setBtn('Resurrect');
  top.appendChild(btn);
  row.appendChild(top);

  // One-liner + meta are full-width rows (indented to the title) so text isn't boxed into the
  // narrow column beside the Resurrect button.
  if (t.oneLiner) row.appendChild(el('div', 'trail-one', t.oneLiner));
  const meta = el('div', 'trail-meta');
  meta.appendChild(el('span', 'meta-text', `${t.pageCount} pages · ${t.topDomain || '—'} · ${rel(t.lastActive)}`));
  // How this result surfaced (search only): semantic = Engram memory (highlighted), else keyword.
  if (why) {
    const tag = el('span', 'match-tag ' + (why === 'semantic' ? 'via-memory' : 'via-keyword'));
    tag.innerHTML = iconSvg(why === 'semantic' ? 'sparkle' : 'search', 11) +
      `<span>${why === 'semantic' ? 'memory' : 'keyword'}</span>`;
    tag.title = why === 'semantic'
      ? 'Surfaced by Engram semantic memory — matched by meaning'
      : 'Matched a keyword in this trail';
    meta.appendChild(tag);
  }
  row.appendChild(meta);

  const detail = el('div', 'trail-detail');
  detail.style.display = 'none';
  if (snippet) detail.appendChild(el('div', 'summary', snippet));
  row.appendChild(detail);

  let loaded = false;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Toggle closed if already open.
    if (detail.style.display !== 'none') { detail.style.display = 'none'; setBtn('Resurrect'); return; }
    detail.style.display = 'block';
    if (loaded) { setBtn('Hide'); return; }

    btn.disabled = true; setBtn('…');
    detail.innerHTML = '';
    const summaryEl = el('div', 'summary loading', 'Resurrecting…');
    detail.appendChild(summaryEl);

    try {
      // Fast path: fetch pages/urls (no LLM) so the user can reopen tabs immediately.
      const d = await api.get(`/trails/${t.id}`);
      const urls: string[] = (d?.pages || []).map((p: { url: string }) => p.url).filter(Boolean);
      const reopen = el('button', 'reopen') as HTMLButtonElement;
      reopen.innerHTML = iconSvg('reopen', 13) + `<span>Reopen ${urls.length} tab${urls.length === 1 ? '' : 's'}</span>`;
      reopen.addEventListener('click', (ev) => {
        ev.stopPropagation();
        urls.slice(0, 25).forEach((u) => chrome.tabs.create({ url: u, active: false }));
        const s = reopen.querySelector('span'); if (s) s.textContent = 'Reopened';
        void updateTabCount();
      });
      detail.appendChild(reopen);

      // Show any cached recap instantly as a placeholder, then always resurrect: that path prefers
      // Engram's authored memory and upgrades a stale local placeholder (and caches the result).
      if (d?.summary) {
        summaryEl.textContent = d.summary;
        summaryEl.classList.remove('loading');
      } else {
        summaryEl.textContent = 'Writing recap…';
      }
      const r = await api.post(`/trails/${t.id}/resurrect`);
      if (r?.summary) {
        summaryEl.textContent = r.summary;
        summaryEl.classList.remove('loading');
      } else if (!d?.summary) {
        summaryEl.textContent = 'No recap available.';
        summaryEl.classList.remove('loading');
      }
      loaded = true;
      setBtn('Hide');
    } catch {
      summaryEl.textContent = 'Couldn’t reach the backend. Is it running?';
      summaryEl.classList.remove('loading');
      setBtn('Retry');
    } finally {
      btn.disabled = false;
    }
  });
  return row;
}

let searchSeq = 0;
async function runSearch(q: string): Promise<void> {
  const main = $('main');
  const seq = ++searchSeq;
  $('listBar').style.display = 'none'; // the group toggle applies to the list, not search results

  // Show a loading state — the semantic pass hits Engram Cloud and can take a moment.
  main.innerHTML = '';
  const loading = el('div', 'searching');
  loading.appendChild(el('span', 'spinner'));
  loading.appendChild(el('span', undefined, 'Searching your memory…'));
  main.appendChild(loading);

  try {
    const { hits } = await api.post('/search', { query: q });
    if (seq !== searchSeq) return; // a newer keystroke superseded this search
    main.innerHTML = '';
    if (!hits?.length) { main.appendChild(el('div', 'empty', `Nothing matched “${q}” yet.`)); return; }
    const sorted = (hits as Hit[]).slice().sort((a, b) => b.trail.lastActive - a.trail.lastActive);
    for (const h of sorted) main.appendChild(trailRow(h.trail, h.why, h.snippet, true));
  } catch {
    if (seq !== searchSeq) return;
    main.innerHTML = '';
    main.appendChild(el('div', 'empty', 'Search failed — is the backend running?'));
  }
}

const onSearch = (e: Event): void => {
  const q = (e.target as HTMLInputElement).value.trim();
  if (!q) { searchSeq++; void render(); return; } // cancel any in-flight search, restore the list
  void runSearch(q);
};

async function renderWeek(): Promise<void> {
  const main = $('main');
  main.innerHTML = '';
  const wk = await api.get('/week');
  main.appendChild(el('div', 'week-head', wk.headline || ''));
  const grid = el('div', 'stats');
  for (const s of (wk.stats || []) as Stat[]) {
    const card = el('div', 'stat');
    const ico = el('span', 'stat-ico');
    ico.innerHTML = iconSvg(STAT_ICON[s.key] || 'stack', 16);
    card.appendChild(ico);
    card.appendChild(el('div', 'stat-k', s.label));
    card.appendChild(el('div', 'stat-v', s.value));
    if (s.detail) card.appendChild(el('div', 'stat-d', s.detail));
    grid.appendChild(card);
  }
  main.appendChild(grid);
}

let armed = false;
async function onNuke(): Promise<void> {
  const btn = $('nukeBtn') as HTMLButtonElement;
  if (!armed) {
    armed = true;
    btn.textContent = 'Click again to close everything';
    btn.classList.add('armed');
    setTimeout(() => { if (armed) { armed = false; btn.textContent = 'Reach Tab Zero'; btn.classList.remove('armed'); } }, 4000);
    return;
  }
  armed = false; btn.classList.remove('armed'); btn.textContent = 'Reaching zero…';
  chrome.runtime.sendMessage({ type: 'nuke' });
  setTimeout(() => window.close(), 250);
}

function renderBackendDown(): void {
  $('searchWrap').style.display = 'none';
  const main = $('main');
  main.innerHTML = '';
  const d = el('div', 'down-msg');
  d.innerHTML = 'Tab Zero backend isn\'t running.<br/>Start it with <code>pnpm backend</code>, then reopen this popup.';
  main.appendChild(d);
}

void init();
