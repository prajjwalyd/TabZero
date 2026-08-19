// Thin capture layer. MV3 service workers are ephemeral, so we do the minimum here:
// observe tab events, buffer them, and forward batches to the local daemon (which owns all state).
import { BACKEND, authHeaders } from './config.js';

interface Ev {
  ts: number;
  type: 'open' | 'navigate' | 'activate' | 'close' | 'meta';
  tabId: number;
  openerTabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
  favIconUrl?: string | null;
  description?: string | null;
  heading?: string | null;
}

let queue: Ev[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(ev: Ev): void {
  queue.push(ev);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 800);
  if (queue.length >= 40) void flush();
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    const r = await fetch(`${BACKEND}/events`, {
      method: 'POST',
      headers: await authHeaders(true),
      body: JSON.stringify({ events: batch }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    // Delivered — drop the crash mirror. Leaving it behind let a later restore() re-adopt events
    // that had already been ingested, duplicating them.
    try { await chrome.storage.local.remove('tz_queue'); } catch { /* ignore */ }
  } catch {
    // daemon down — put the batch back and mirror it so nothing is lost across SW death
    queue = batch.concat(queue);
    try { await chrome.storage.local.set({ tz_queue: queue.slice(-3000) }); } catch { /* ignore */ }
  } finally {
    flushing = false;
  }
}

/**
 * Adopt the crash mirror after a service-worker restart.
 *
 * `tz_queue` is a MIRROR of this worker's in-memory queue, not a separate backlog — a failed flush
 * writes the events to both. So adopting it while `queue` is non-empty concatenates events we already
 * hold, and every failed-flush/restore cycle then DOUBLES the pending set: one page ended up with a
 * visit_count of 436 from a single real visit (871 navigate events, one tab, one URL, zero URL
 * changes). Only adopt when we have nothing in memory, which is exactly the case the mirror exists
 * for: this worker was restarted and lost the queue.
 */
async function restore(): Promise<void> {
  try {
    if (queue.length) return; // in-memory queue is authoritative; storage is its stale mirror
    const { tz_queue } = await chrome.storage.local.get('tz_queue');
    if (!Array.isArray(tz_queue) || !tz_queue.length) return;
    queue = tz_queue;
    await chrome.storage.local.remove('tz_queue');
    void flush();
  } catch { /* ignore */ }
}

// --- listeners registered synchronously at top level (so a dormant SW is woken) ---

chrome.tabs.onCreated.addListener((tab) => {
  // establish the opener relationship; the page itself is captured on navigate
  enqueue({ ts: Date.now(), type: 'open', tabId: tab.id ?? -1, openerTabId: tab.openerTabId ?? null, windowId: tab.windowId, url: null });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'complete' || changeInfo.title) && tab.url) {
    enqueue({ ts: Date.now(), type: 'navigate', tabId, windowId: tab.windowId, url: tab.url, title: tab.title ?? null, favIconUrl: tab.favIconUrl ?? null });
  }
});

chrome.tabs.onActivated.addListener((info) => {
  enqueue({ ts: Date.now(), type: 'activate', tabId: info.tabId, windowId: info.windowId });
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  enqueue({ ts: Date.now(), type: 'close', tabId, windowId: info.windowId });
});

// --- "Reach Tab Zero" runs HERE, not in the popup: creating the fresh active tab closes
//     the popup, and any async work left in the popup context would be aborted. ---
async function doNuke(): Promise<{ closed: number; trails: number }> {
  let trails = 0;
  try {
    const h = await (await fetch(`${BACKEND}/health`)).json(); // /health needs no auth
    trails = h?.trails ?? 0;
  } catch { /* daemon down — still close the tabs */ }

  const tabs = await chrome.tabs.query({});
  const zeroUrl = chrome.runtime.getURL('zero.html');
  const ids = tabs.filter((t) => t.id != null && !t.pinned && t.url !== zeroUrl).map((t) => t.id!) as number[];
  const closed = ids.length;

  // Snapshot the working set (the http(s) tabs open right now) so the server can checkpoint them,
  // finalize their trails, and flush to Engram. Fire-and-forget — it must not block the nuke.
  const openUrls = tabs
    .map((t) => t.url)
    .filter((u): u is string => !!u && /^https?:/.test(u) && u !== zeroUrl);
  void fetch(`${BACKEND}/zero`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ openUrls }),
  }).catch(() => {});
  const url = chrome.runtime.getURL(`zero.html?closed=${closed}&trails=${trails}`);
  const fresh = await chrome.tabs.create({ url, active: true });
  const toRemove = ids.filter((id) => id !== fresh.id);
  try { await chrome.tabs.remove(toRemove); } catch { /* some may already be gone */ }
  return { closed, trails };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'nuke') {
    doNuke().then(sendResponse).catch(() => sendResponse({ closed: 0, trails: 0 }));
    return true; // async response
  }
  // Metadata-only enrichment forwarded from the content script.
  if (msg?.type === 'meta' && sender.tab?.id != null) {
    enqueue({
      ts: Date.now(), type: 'meta', tabId: sender.tab.id, windowId: sender.tab.windowId,
      url: msg.url ?? sender.tab.url ?? null, title: sender.tab.title ?? null,
      description: msg.description ?? null, heading: msg.heading ?? null,
    });
  }
  return undefined;
});

chrome.alarms.create('tz_flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tz_flush') { void restore(); void flush(); }
});
chrome.runtime.onStartup.addListener(() => void restore());
chrome.runtime.onInstalled.addListener(() => void restore());
void restore();
