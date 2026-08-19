// The extension's capture layer, driven the way Chrome drives it — by invoking the listeners it
// registers — with chrome.* and fetch stubbed. No browser needed, because the part that actually broke
// is plain logic: a queue, a retry, and a crash mirror in chrome.storage.
//
// This is the path that produced the worst bug in the project: a failed flush put the batch back in
// the in-memory queue AND mirrored it to storage, then restore() concatenated the mirror onto the
// queue it was already in, doubling the pending set on every retry cycle. One real visit to a Google
// sign-in page was ingested 436 times (~2^8.8). The daemon has its own guard now, but the duplication
// belongs to the extension and this is where it has to be caught.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the fake browser ---
type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const addTo = (k: string) => ({ addListener: (f: Listener) => (listeners[k] ??= []).push(f) });
const fire = async (k: string, ...args: unknown[]) => {
  for (const f of listeners[k] ?? []) await f(...args);
};

let storage: Record<string, unknown> = {};
let delivered: any[] = []; // events the daemon actually received
let healthCalls = 0;
let failFlushes = 0; // how many /events posts to reject
const tokenFromHealth: string | null = 'tok-abc123';

before(async () => {
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: storage[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(storage, o);
        },
        remove: async (k: string) => {
          delete storage[k];
        },
      },
    },
    tabs: {
      onCreated: addTo('tabCreated'),
      onUpdated: addTo('tabUpdated'),
      onActivated: addTo('tabActivated'),
      onRemoved: addTo('tabRemoved'),
      query: async () => [],
      create: async () => ({ id: 999 }),
      remove: async () => {},
    },
    runtime: {
      onMessage: addTo('message'),
      onStartup: addTo('startup'),
      onInstalled: addTo('installed'),
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    alarms: { create: () => {}, onAlarm: addTo('alarm') },
  };

  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (url.endsWith('/health')) {
      healthCalls++;
      return {
        ok: true,
        json: async () => ({ ok: true, ...(tokenFromHealth ? { token: tokenFromHealth } : {}) }),
      };
    }
    if (url.endsWith('/events')) {
      if (failFlushes > 0) {
        failFlushes--;
        throw new Error('daemon down');
      }
      const body = JSON.parse(init.body);
      delivered.push({ events: body.events, token: init.headers['x-tabzero-token'] });
      return { ok: true, json: async () => ({ ok: true, count: body.events.length }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  await import('../src/background.ts'); // registers its listeners at import, as MV3 requires
});

beforeEach(() => {
  storage = {};
  delivered = [];
  failFlushes = 0;
}); // healthCalls is suite-wide on purpose

/** Simulate Chrome reporting a completed navigation. */
const navigate = (tabId: number, url: string, title: string) =>
  fire('tabUpdated', tabId, { status: 'complete' }, { id: tabId, url, title, windowId: 1 });

const allEvents = () => delivered.flatMap((d) => d.events);
const navUrls = () =>
  allEvents()
    .filter((e: any) => e.type === 'navigate')
    .map((e: any) => e.url);

test('a failed flush then a retry delivers every event exactly once', async () => {
  failFlushes = 1; // the first POST fails, as if the daemon were down

  await navigate(1, 'https://a.test/one', 'One');
  await navigate(2, 'https://a.test/two', 'Two');
  await navigate(3, 'https://a.test/three', 'Three');

  await sleep(1100); // the 800ms debounce fires flush, which fails and mirrors to storage
  assert.equal(delivered.length, 0, 'nothing delivered while the daemon is down');
  assert.ok(Array.isArray(storage.tz_queue), 'the batch was mirrored for crash safety');

  // The one-minute alarm: restore() then flush(). This is the exact sequence that used to double.
  await fire('alarm', { name: 'tz_flush' });
  await sleep(600);

  const urls = navUrls();
  assert.equal(urls.length, 3, `expected 3 navigate events, got ${urls.length} — duplication regressed`);
  assert.deepEqual([...new Set(urls)].sort(), urls.slice().sort(), 'no event delivered twice');
  assert.equal(storage.tz_queue, undefined, 'the mirror is cleared once delivered');
});

test('repeated failures do not compound — five retry cycles still deliver once each', async () => {
  failFlushes = 5;
  await navigate(11, 'https://b.test/x', 'X');
  await navigate(12, 'https://b.test/y', 'Y');
  await sleep(1100);

  // Five alarm cycles while the daemon stays down. The old bug doubled the pending set each time,
  // so by the fifth cycle two events would have become ~64 deliveries.
  for (let i = 0; i < 5; i++) {
    await fire('alarm', { name: 'tz_flush' });
    await sleep(250);
  }
  await fire('alarm', { name: 'tz_flush' }); // daemon back up
  await sleep(600);

  const urls = navUrls();
  assert.equal(urls.length, 2, `expected 2 navigate events after 5 failed cycles, got ${urls.length}`);
  assert.deepEqual([...new Set(urls)].sort(), ['https://b.test/x', 'https://b.test/y']);
});

test('a service-worker restart adopts the mirror instead of losing the queue', async () => {
  // Simulate the worker having died with events pending: storage holds them, memory does not.
  storage.tz_queue = [
    {
      ts: Date.now(),
      type: 'navigate',
      tabId: 50,
      windowId: 1,
      url: 'https://c.test/recovered',
      title: 'Recovered',
    },
  ];
  await fire('startup');
  await sleep(600);
  assert.deepEqual(
    navUrls(),
    ['https://c.test/recovered'],
    'the persisted event was recovered and sent once',
  );
  assert.equal(storage.tz_queue, undefined, 'mirror cleared after delivery');
});

test('the token is fetched from /health once and attached to every post', async () => {
  await navigate(21, 'https://d.test/1', 'D1');
  await sleep(1100);
  await navigate(22, 'https://d.test/2', 'D2');
  await sleep(1100);

  assert.equal(delivered.length, 2, 'two separate flushes');
  assert.ok(
    delivered.every((d) => d.token === 'tok-abc123'),
    'every post carried the bootstrapped token',
  );
  // The token is cached in memory (never chrome.storage), so across this entire run — many flushes
  // over four tests — /health is fetched exactly once. More than one would mean the cache is broken;
  // zero would mean the token never came from the daemon at all.
  assert.equal(healthCalls, 1, `/health fetched ${healthCalls}x across the whole suite, expected exactly 1`);
});
