import { BACKEND, authHeaders } from './config.js';
import { iconSvg, brandMark, STAT_ICON } from './icons.js';
import { longestFitting } from './truncate.js';

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
interface Week { headline: string; stats: Stat[] }
/** `source` is load-bearing: 'engram' is real cross-trail synthesis, 'local' is a weaker stand-in. */
interface Interests { source: 'engram' | 'local'; interests: { label: string; detail?: string; updatedAt?: number }[] }

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

type View = 'trails' | 'week' | 'interests';
let view: View = 'trails';
let groupBy = false;
/** Last list fetched from /trails, so typing can filter it client-side with no network call. */
let loaded: Trail[] = [];

/**
 * Per-view data cache — the reason switching tabs no longer flickers.
 *
 * Every renderer used to do `main.innerHTML = ''` and THEN await its fetch, so the pane sat visibly
 * empty for the whole round trip and the content popped in afterwards. Switching tabs flashed blank
 * every single time, including back to a view already seen a second earlier.
 *
 * Now a view paints from cache synchronously, and the network call only ever *replaces* what is
 * already on screen. Combined with paint()'s single atomic swap, there is no frame in which the pane
 * is empty.
 */
const cache: { trails: Trail[] | null; week: Week | null; interests: Interests | null } =
  { trails: null, week: null, interests: null };
/** Signature of what is currently painted per view, so identical data never triggers a repaint. */
const painted: Record<View, string> = { trails: '', week: '', interests: '' };
/** Guards against a slow response for one view landing after the user has switched to another. */
let viewSeq = 0;

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Swap the pane's contents in ONE operation. `replaceChildren` on a pre-built fragment means the
 * browser never paints an intermediate empty state — which is exactly what the old
 * clear-then-append-later pattern did.
 */
function paint(build: (out: DocumentFragment) => void): void {
  const frag = document.createDocumentFragment();
  build(frag);
  const main = $('main');
  main.replaceChildren(frag);
  // Any paint invalidates every view's signature, and only repaint() re-claims one. Without this,
  // search results (which paint into the same pane) would leave `painted.trails` still matching the
  // trail list, so switching back to Trails would skip the repaint and leave the results on screen.
  painted.trails = painted.week = painted.interests = '';
  if (REDUCED_MOTION) return;
  main.classList.remove('swap');
  void main.offsetWidth; // force a reflow so the animation restarts on every swap
  main.classList.add('swap');
}

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
  void prefetch(); // warm the other tabs so the FIRST switch is instant too, not just repeat visits
  document.querySelectorAll<HTMLElement>('.seg').forEach((t) =>
    t.addEventListener('click', () => {
      const next = t.dataset.view as View;
      if (next === view) return; // re-clicking the active tab must not trigger a pointless repaint
      view = next;
      document.querySelectorAll('.seg').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      void render();
    }),
  );
  const box = $('search') as HTMLInputElement;
  box.addEventListener('input', onType);
  box.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const q = box.value.trim();
    if (q) void runSearch(q);
  });
  $('nukeBtn').addEventListener('click', onNuke);
  $('refreshBtn').addEventListener('click', () => void refresh());
  $('groupToggle').addEventListener('click', () => {
    groupBy = !groupBy;
    $('groupToggle').classList.toggle('active', groupBy);
    void render();
  });
}

/**
 * Load the views the user is not looking at yet, in the background.
 *
 * `/week` is local and quick; `/interests` can involve an Engram round trip with a 15s ceiling, so it
 * must never sit on a path the user is waiting on. Doing it here means the tab is already warm by the
 * time they click it, and a failure is silent — render() will simply try again on demand.
 */
async function prefetch(): Promise<void> {
  try { cache.week ??= (await api.get('/week')) as Week; } catch { /* render() retries on demand */ }
  if (view === 'week') paintView(); // they got there before we did — upgrade the skeleton in place
  try { cache.interests ??= (await api.get('/interests')) as Interests; } catch { /* as above */ }
  if (view === 'interests') paintView();
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
    // Explicit refresh means "get me current data" — drop the caches for the views we are not about
    // to re-fetch, so switching to one afterwards doesn't hand back a pre-refresh snapshot.
    if (view !== 'trails') cache.trails = null;
    if (view !== 'week') cache.week = null;
    if (view !== 'interests') cache.interests = null;
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

/**
 * Switch to / refresh the current view without ever showing an empty pane.
 *
 * Order matters: paint whatever is cached FIRST (synchronously), then fetch, then repaint only if the
 * data actually changed. On a cold view there is nothing to paint, so a skeleton of the right shape
 * stands in — never a blank box that resizes when content lands.
 */
async function render(): Promise<void> {
  const seq = ++viewSeq;
  const isTrails = view === 'trails';
  $('searchWrap').style.display = isTrails ? 'block' : 'none';
  if (!isTrails) $('listBar').style.display = 'none';

  const hadCache = paintView();
  if (!hadCache) paintSkeleton();

  try {
    if (view === 'trails') cache.trails = ((await api.get('/trails')).trails as Trail[]) || [];
    else if (view === 'week') cache.week = (await api.get('/week')) as Week;
    else cache.interests = (await api.get('/interests')) as Interests;
  } catch {
    // Only surface the failure if there was nothing to show; otherwise leave the cached view in place.
    if (seq === viewSeq && !hadCache) {
      paint((o) => o.appendChild(el('div', 'empty', 'Couldn’t load that — is the backend running?')));
    }
    return;
  }
  if (seq !== viewSeq) return; // the user switched away mid-flight; do not clobber their current view
  if (view === 'trails') loaded = cache.trails!;
  paintView();
}

/** Paint the current view from cache. False when nothing is cached yet. */
function paintView(): boolean {
  if (view === 'trails') {
    if (!cache.trails) return false;
    return repaint('trails', cache.trails, () => paintTrails(cache.trails!));
  }
  if (view === 'week') {
    if (!cache.week) return false;
    return repaint('week', cache.week, () => paintWeek(cache.week!));
  }
  if (!cache.interests) return false;
  return repaint('interests', cache.interests, () => paintInterests(cache.interests!));
}

/**
 * Repaint only when the data differs from what is already on screen. Without this, every fetch
 * repaints identical content — a second visible swap for no reason, which reads as a flicker of its
 * own on an explicit refresh.
 */
function repaint(key: View, data: unknown, build: () => void): boolean {
  const sig = JSON.stringify(data);
  if (painted[key] === sig) return true;
  build();            // paint() clears all signatures as it swaps...
  painted[key] = sig; // ...so claim this one afterwards, not before
  return true;
}

/** Placeholder of roughly the right shape, so a cold view doesn't jump when real content arrives. */
function paintSkeleton(): void {
  const rows = view === 'week' ? 4 : 3;
  paint((out) => {
    const wrap = el('div', view === 'week' ? 'stats' : undefined);
    for (let i = 0; i < rows; i++) wrap.appendChild(el('div', view === 'week' ? 'skel skel-card' : 'skel skel-row'));
    out.appendChild(wrap);
  });
}

function paintTrails(list: Trail[]): void {
  const bar = $('listBar');
  bar.style.display = list.length ? 'flex' : 'none';
  $('listCount').textContent = `${list.length} trail${list.length === 1 ? '' : 's'}`;

  paint((out) => {
    if (!list.length) {
      out.appendChild(el('div', 'empty', 'No trails yet. Browse a little — Tab Zero reconciles your open tabs into research trails automatically.'));
      return;
    }

    // Always newest-first.
    const sorted = list.slice().sort((a, b) => b.lastActive - a.lastActive);

    if (!groupBy) {
      // Flat, latest-first — each row carries a category pill.
      for (const t of sorted) out.appendChild(trailRow(t, undefined, undefined, true));
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
      out.appendChild(head);
      for (const t of items) out.appendChild(trailRow(t));
    }
  });
}

/**
 * Two-step delete, confirmed inline on the row itself.
 *
 * Inline rather than `confirm()`: a modal dialog from an extension popup is jarring, and in some
 * contexts is suppressed entirely — which would turn a destructive action into a silent one.
 *
 * The wording is deliberately specific about scope. This deletes the trail, its pages, and the matching
 * rows in the raw event log, so it is a real local delete rather than a hide. It cannot delete the
 * memory Engram has already reconciled — Engram's REST API has no delete — and saying "deleted" without
 * that caveat would be a promise the product can't keep.
 */
function askDelete(row: HTMLElement, t: Trail): void {
  if (row.querySelector('.confirm')) return; // already asking
  const bar = el('div', 'confirm');
  const msg = el('div', 'confirm-msg');
  msg.innerHTML = `Delete <b>${t.label.replace(/</g, '&lt;')}</b> and its ${t.pageCount} page${t.pageCount === 1 ? '' : 's'}?`
    + '<span class="confirm-note">Removes them from the local log too. Any memory Engram already '
    + 'reconciled stays.';
  bar.appendChild(msg);

  const actions = el('div', 'confirm-actions');
  const no = el('button', 'confirm-cancel', 'Cancel');
  const yes = el('button', 'confirm-go', 'Delete') as HTMLButtonElement;
  no.addEventListener('click', () => bar.remove());
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    yes.textContent = 'Deleting…';
    try {
      const r = await fetch(`${BACKEND}/trails/${encodeURIComponent(t.id)}`, {
        method: 'DELETE',
        headers: await authHeaders(),
      });
      if (!r.ok) throw new Error(String(r.status));
      // Drop it from the cache as well as the DOM, or the next repaint from cache brings it back.
      if (cache.trails) cache.trails = cache.trails.filter((x) => x.id !== t.id);
      loaded = loaded.filter((x) => x.id !== t.id);
      cache.week = null;       // page/trail totals and every stat just changed
      cache.interests = null;  // the durable-trail fallback may have drawn on this trail
      row.remove();
      const remaining = cache.trails?.length ?? 0;
      $('listCount').textContent = `${remaining} trail${remaining === 1 ? '' : 's'}`;
    } catch {
      yes.disabled = false;
      yes.textContent = 'Delete';
      msg.innerHTML = 'Couldn’t delete that — is the backend running?';
    }
  });
  actions.append(no, yes);
  bar.appendChild(actions);
  row.appendChild(bar);
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

  const del = el('button', 'icon-btn danger-btn') as HTMLButtonElement;
  del.innerHTML = iconSvg('trash', 14);
  del.title = 'Delete this trail';
  del.setAttribute('aria-label', `Delete trail: ${t.label}`);
  del.addEventListener('click', (e) => { e.stopPropagation(); askDelete(row, t); });
  top.appendChild(del);
  row.appendChild(top);

  // One-liner + meta are full-width rows (indented to the title) so text isn't boxed into the
  // narrow column beside the Resurrect button.
  if (t.oneLiner) row.appendChild(el('div', 'trail-one', t.oneLiner));
  const meta = el('div', 'trail-meta');
  meta.appendChild(el('span', 'meta-text', `${t.pageCount} pages · ${t.topDomain || '—'} · ${rel(t.lastActive)}`));
  // How this result surfaced (search only). The tag's job is to answer "why is this row here?", so it
  // names the thing that matched — the words, or the meaning. It used to read "keyword" / "memory":
  // "memory" is our internal word for the Engram layer and told the user nothing about the match, which
  // is exactly the row they most need explained, since it shares no words with what they typed.
  if (why) {
    const semantic = why === 'semantic';
    const tag = el('span', 'match-tag ' + (semantic ? 'via-memory' : 'via-keyword'));
    tag.innerHTML = iconSvg(semantic ? 'sparkle' : 'search', 11) +
      `<span>${semantic ? 'meaning' : 'text'}</span>`;
    tag.title = semantic
      ? 'Found by meaning, not words — Engram\'s semantic memory matched this trail to your query'
      : 'Found because your words appear in this trail';
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
      // `d.resurrectUrls`, NOT `d.pages`: the server already resolved the checkpoint working set and
      // applied the cap. Deriving the list from `d.pages` here reopened the trail's entire history and
      // meant the checkpoint tables were written but never read by the only UI that reopens tabs.
      const urls: string[] = (d?.resurrectUrls || []).filter(Boolean);
      const reopen = el('button', 'reopen') as HTMLButtonElement;
      reopen.innerHTML = iconSvg('reopen', 13) + `<span>Reopen ${urls.length} tab${urls.length === 1 ? '' : 's'}</span>`;
      reopen.disabled = urls.length === 0;
      reopen.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Open every url counted on the label. The old `slice(0, 25)` capped here instead, so a
        // 60-page trail promised "Reopen 60 tabs" and delivered 25.
        urls.forEach((u) => chrome.tabs.create({ url: u, active: false }));
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

/**
 * One line above search results explaining what the row tags mean.
 *
 * The tags themselves cannot carry the idea — two words in a 9px pill will not convey "this is the
 * retrieval strategy that surfaced this row", and renaming them (keyword/memory -> text/meaning) did not
 * fix that. Explaining it once, at the point of use, is what makes the pills read as shorthand for
 * something already understood.
 *
 * Built from the kinds ACTUALLY present, not as a fixed legend: with Engram off every row is a text
 * match, and defining a `meaning` tag that appears nowhere on screen is just noise. Shown only for
 * search results — typing filters locally, produces no tags, and needs no legend.
 */
function searchLegend(hits: Hit[]): HTMLElement {
  const kinds = new Set(hits.map((h) => h.why));
  const wrap = el('div', 'search-legend');
  const entry = (why: 'keyword' | 'semantic', explain: string) => {
    if (!kinds.has(why)) return;
    const semantic = why === 'semantic';
    const item = el('span', 'legend-item');
    const tag = el('span', 'match-tag ' + (semantic ? 'via-memory' : 'via-keyword'));
    tag.innerHTML = iconSvg(semantic ? 'sparkle' : 'search', 10) +
      `<span>${semantic ? 'meaning' : 'text'}</span>`;
    item.appendChild(tag);
    item.appendChild(el('span', 'legend-text', explain));
    wrap.appendChild(item);
  };
  entry('keyword', 'your words matched');
  entry('semantic', 'Engram matched the idea');
  return wrap;
}

let searchSeq = 0;
async function runSearch(q: string): Promise<void> {
  const main = $('main');
  const seq = ++searchSeq;
  $('listBar').style.display = 'none'; // the group toggle applies to the list, not search results

  // Show a loading state — the semantic pass hits Engram Cloud and can take a moment. Unlike a tab
  // switch this spinner is wanted: the user pressed Enter and a cloud round trip is genuinely pending.
  paint((out) => {
    const loading = el('div', 'searching');
    loading.appendChild(el('span', 'spinner'));
    loading.appendChild(el('span', undefined, 'Searching your memory…'));
    out.appendChild(loading);
  });

  try {
    const { hits } = await api.post('/search', { query: q });
    if (seq !== searchSeq) return; // a newer keystroke superseded this search
    paint((out) => {
      if (!hits?.length) { out.appendChild(el('div', 'empty', `Nothing matched “${q}” yet.`)); return; }
      const sorted = (hits as Hit[]).slice().sort((a, b) => b.trail.lastActive - a.trail.lastActive);
      out.appendChild(searchLegend(sorted));
      for (const h of sorted) out.appendChild(trailRow(h.trail, h.why, h.snippet, true));
    });
  } catch {
    if (seq !== searchSeq) return;
    paint((out) => out.appendChild(el('div', 'empty', 'Search failed — is the backend running?')));
  }
}

/**
 * Typing FILTERS the trails already on screen — no network, no debounce, no spinner. Semantic search
 * only runs on Enter (runSearch).
 *
 * It used to fire a debounced /search on every keystroke, and that endpoint awaits Engram Cloud
 * unconditionally. So typing "gpu pricing" made ~5 cloud round trips on prefixes like "gpu pric",
 * which carry no meaning to embed, and each one blanked the list for a spinner. A prefix is the wrong
 * input for semantic search; a complete thought is, and Enter is how you say you have one.
 */
const onType = (e: Event): void => {
  const q = (e.target as HTMLInputElement).value.trim();
  searchSeq++; // supersede any in-flight semantic search
  if (!q) { void render(); return; }
  filterLoaded(q);
};

/** Narrow the loaded trails by literal substring — label, one-liner, category, domain. */
function filterLoaded(q: string): void {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = loaded.filter((t) => {
    const hay = `${t.label} ${t.oneLiner ?? ''} ${t.category} ${t.topDomain ?? ''}`.toLowerCase();
    return toks.every((w) => hay.includes(w));
  });
  $('listBar').style.display = 'none';
  paint((out) => {
    if (!hits.length) {
      // The filter can only see what's loaded; Engram can see meaning. Make that escalation obvious.
      const d = el('div', 'empty');
      d.innerHTML = `No loaded trail matches \u201c${q}\u201d.<br/>Press <b>Enter</b> to search your memory semantically.`;
      out.appendChild(d);
      return;
    }
    const sorted = hits.slice().sort((a, b) => b.lastActive - a.lastActive);
    for (const t of sorted) out.appendChild(trailRow(t, undefined, undefined, true));
    const hint = el('div', 'empty', 'Press Enter to search your full memory, including archived trails.');
    hint.style.paddingTop = '18px';
    out.appendChild(hint);
  });
}

function paintWeek(wk: Week): void {
  paint((out) => {
    out.appendChild(el('div', 'week-head', wk.headline || ''));
    const grid = el('div', 'stats');
    for (const s of wk.stats || []) {
      const card = el('div', 'stat');
      const ico = el('span', 'stat-ico');
      ico.innerHTML = iconSvg(STAT_ICON[s.key] || 'stack', 16);
      card.appendChild(ico);
      card.appendChild(el('div', 'stat-k', s.label));
      card.appendChild(el('div', 'stat-v', s.value));
      if (s.detail) card.appendChild(el('div', 'stat-d', s.detail));
      grid.appendChild(card);
    }
    out.appendChild(grid);
  });
}

/**
 * Durable cross-trail interests — the themes you keep returning to, as opposed to a single trail.
 *
 * `source` is the whole story here and is shown honestly rather than smoothed over. With a key,
 * Engram synthesizes these across trails and carries their current state ("evaluating X, leaning Y"),
 * so each row is tagged as memory. Without one, the server falls back to listing your most durable
 * individual *trails* — useful, but it is not synthesis, and presenting it as though it were would be
 * a lie the Trails tab immediately contradicts.
 */
function paintInterests(data: Interests): void {
  const items = data.interests || [];
  paint((out) => {
    if (!items.length) {
      const d = el('div', 'empty');
      d.innerHTML = 'No durable interests yet.<br/><br/>An interest forms when a theme recurs across '
        + 'several sessions or becomes a deep investigation — so this fills in after a few days of browsing, '
        + 'not immediately.';
      out.appendChild(d);
      return;
    }

    const head = el('div', 'week-head');
    if (data.source === 'engram') {
      head.textContent = 'What you keep coming back to, synthesized across trails.';
    } else {
      head.innerHTML = 'Your most durable trails. <span class="int-note">Connect Engram to get real '
        + 'cross-trail synthesis with current state.</span>';
    }
    out.appendChild(head);

    for (const it of items) {
      const row = el('div', 'interest');
      // Deliberately NO per-row provenance tag. In search results `text`/`meaning` discriminates —
      // rows on that screen matched different ways. Here every row has the same source, so a tag
      // repeated on all of them carries no information, steals width from a label that is often a
      // paragraph, and weakens the search tag by reusing its idiom where nothing is being told apart.
      // The header states the source once, which is the right number of times.
      //
      // Engram is asked for "a short phrase led by the activity" but does not always comply — real
      // memories arrive as 250-character paragraphs. Clamped to three lines with a `more…` toggle
      // (attached below only where text is genuinely clipped) and the full text on hover.
      row.appendChild(interestLabel(it.label));
      const meta = [it.detail, it.updatedAt ? `updated ${rel(it.updatedAt)}` : ''].filter(Boolean).join(' · ');
      if (meta) row.appendChild(el('div', 'interest-detail', meta));
      out.appendChild(row);
    }
  });
  fitInterestLabels(); // needs layout, so only after paint() has inserted the rows
}

/**
 * Collapsed interest text with the toggle INLINE, continuing the sentence: `…terminal ...more`.
 *
 * Done in JS rather than with `-webkit-line-clamp` because the clamp paints its own ellipsis and there is
 * no way to suppress it — so a clamp plus a separate control gave two ellipses and put `more…` on its own
 * line. Truncating the string ourselves means exactly one ellipsis, at the point where the text stops.
 *
 * The budget is characters, not measured lines. A measured version would have to lay out, read back
 * scrollHeight, and re-truncate to make room for the toggle on the last line — and would still only be
 * right for one font size. At this popup's fixed width a character budget lands within a line either way,
 * which is all the precision the effect needs.
 */
/**
 * Collapsed interest text: exactly three lines, with the toggle inline and continuing the sentence.
 *
 * Two things a character budget could not deliver, which is why this measures instead.
 *
 * 1. THREE LINES, GUARANTEED. A fixed character count is not a line count — 165 characters rendered as
 *    four lines at this width. So the body is binary-searched against the element's real height: the
 *    longest prefix whose rendered height still fits `MAX_LINES` wins. That also handles the toggle
 *    wrapping onto a line of its own, because a wrapped toggle makes the element taller and the search
 *    rejects that prefix automatically. No special case needed.
 *
 * 2. A VISIBLE SPACE before the toggle. A leading ordinary space inside an inline element is collapsible
 *    whitespace and got eaten, giving `thought_signature)...more`. A non-breaking space cannot be
 *    collapsed, so it always renders — and as a bonus it glues the toggle to the preceding word, so
 *    `...more` can never end up stranded alone.
 *
 * Measuring requires layout, so this runs as a pass AFTER paint() has put the rows in the document.
 */
const MAX_LINES = 3;

function interestLabel(text: string): HTMLElement {
  const label = el('div', 'interest-label');
  label.title = text;
  label.dataset.full = text;
  label.appendChild(el('span', 'interest-text', text));
  label.appendChild(el('button', 'more-btn'));
  return label;
}


function fitInterestLabels(): void {
  for (const label of document.querySelectorAll<HTMLElement>('.interest-label')) {
    const full = label.dataset.full;
    const body = label.querySelector<HTMLElement>('.interest-text');
    const toggle = label.querySelector<HTMLButtonElement>('.more-btn');
    if (!full || !body || !toggle) continue;

    const lh = parseFloat(getComputedStyle(label).lineHeight) || 19;
    const maxH = lh * MAX_LINES + 1; // +1 absorbs sub-pixel rounding

    // Does the whole thing already fit? Then there is nothing to reveal and no toggle to show.
    toggle.hidden = true;
    body.textContent = full;
    if (label.scrollHeight <= maxH) continue;

    toggle.hidden = false;
    toggle.textContent = '\u00A0...more';

    // Longest prefix that still fits in MAX_LINES *including* the toggle.
    const short = longestFitting(full, (candidate) => {
      body.textContent = candidate;
      return label.scrollHeight <= maxH;
    });
    body.textContent = short;

    let open = false;
    toggle.onclick = () => {
      open = !open;
      body.textContent = open ? full : short;
      toggle.textContent = open ? '\u00A0less' : '\u00A0...more';
    };
  }
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
  $('listBar').style.display = 'none';
  paint((out) => {
    const d = el('div', 'down-msg');
    d.innerHTML = 'Tab Zero backend isn\'t running.<br/>Start it with <code>pnpm backend</code>, then reopen this popup.';
    out.appendChild(d);
  });
}

void init();
