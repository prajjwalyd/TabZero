// Reproducible demo seed. Drives realistic navigate + meta events through the REAL ingestion
// pipeline (pipeline.ts), so the resulting trails exercise everything the live extension does:
// canonicalization, metadata/description capture, boilerplate suppression, opener-graph +
// lexical clustering, and categorization. This is the source of truth for demo/screenshot data.
//
//   pnpm seed            # add the demo trails on top of whatever's there
//   pnpm seed --reset    # wipe events/pages/trails first, then seed (keeps your user_id)
//   pnpm seed --reset --enrich   # also run the LLM label/summary pass inline
//
// Run with the daemon STOPPED so there's no write contention on the SQLite file.
import { db, getUserId } from './db.js';
import { ingestEvent } from './pipeline.js';
import { labelTrail, summarizeTrail } from './trails.js';

const RESET = process.argv.includes('--reset');
const ENRICH = process.argv.includes('--enrich');

interface SeedPage { url: string; title: string; desc: string }
interface SeedTrail { daysAgo: number; win: number; pages: SeedPage[] }

const REACT_TAGLINE = 'The library for web and native user interfaces'; // same on every route -> boilerplate

const TRAILS: SeedTrail[] = [
  // --- dev: live, recent ---
  { daysAgo: 0, win: 1, pages: [
    { url: 'https://weaviate.io/developers/weaviate/concepts/engram', title: 'Engram: Agentic Memory | Weaviate',
      desc: 'Engram is Weaviate\'s managed agentic memory: an extract, transform, and commit pipeline that turns raw interactions into durable, queryable memories.' },
    { url: 'https://docs.engram.weaviate.io/api/memories', title: 'Memories API — Engram REST Reference',
      desc: 'Add and search memories over REST. POST /memories accepts a user_id, scope properties, and a discriminated input object; search returns ranked memories.' },
    { url: 'https://weaviate.io/blog/engram-ga', title: 'Engram is now generally available | Weaviate Blog',
      desc: 'Announcing GA of Engram, with topics, user and property scopes, bounded memories, and a Temporal-backed extraction pipeline for AI agents.' },
    { url: 'https://github.com/weaviate/engram-examples', title: 'weaviate/engram-examples: quickstarts for Engram',
      desc: 'Reference quickstarts showing how to commit conversations and retrieve scoped memories from Python and TypeScript over the Engram REST API.' },
  ] },

  // --- learning: a couple days old ---
  { daysAgo: 2, win: 1, pages: [
    { url: 'https://en.wikipedia.org/wiki/Hierarchical_navigable_small_world', title: 'Hierarchical navigable small world - Wikipedia',
      desc: 'HNSW is a graph-based algorithm for approximate nearest neighbor search that builds a multi-layer proximity graph for fast similarity queries.' },
    { url: 'https://arxiv.org/abs/1603.09320', title: 'Efficient and robust approximate nearest neighbor search using HNSW',
      desc: 'The original HNSW paper: a hierarchy of navigable small-world graphs giving logarithmic-scaling approximate nearest neighbor search.' },
    { url: 'https://www.pinecone.io/learn/vector-database/', title: 'What is a Vector Database? - Pinecone',
      desc: 'A vector database indexes embeddings so you can run semantic similarity search at scale, using ANN indexes like HNSW under the hood.' },
  ] },

  // --- travel: live, recent ---
  { daysAgo: 0, win: 2, pages: [
    { url: 'https://www.tripadvisor.com/Tourism-Lisbon', title: 'Lisbon 2026: Best Places to Visit - Tripadvisor',
      desc: 'Plan a trip to Lisbon: Alfama\'s tiled streets, tram 28, miradouro viewpoints, and day trips to Sintra\'s palaces and the beaches of Cascais.' },
    { url: 'https://www.booking.com/city/pt/lisbon.html', title: 'Hotels in Alfama, Lisbon | Booking.com',
      desc: 'Compare boutique guesthouses and hotels in the Alfama district, walking distance to the castle, fado houses, and the riverfront.' },
    { url: 'https://www.skyscanner.net/routes/lis/flights-to-lisbon', title: 'Cheap Flights to Lisbon (LIS) - Skyscanner',
      desc: 'Find and compare flights to Lisbon Portela airport in September, including baggage options and the cheapest departure days.' },
    { url: 'https://www.omio.com/trains/lisbon-sintra', title: 'Lisbon to Sintra by Train - Omio',
      desc: 'Book the regional train from Lisbon Rossio to Sintra: schedules, ticket prices, and how to reach Pena Palace once you arrive.' },
  ] },

  // --- shopping: a week old -> dormant ---
  { daysAgo: 7, win: 3, pages: [
    { url: 'https://www.tomshardware.com/reviews/nvidia-rtx-5090-review', title: 'Nvidia RTX 5090 Review - Tom\'s Hardware',
      desc: 'Benchmarks and specs for the RTX 5090: 4K and ray-tracing performance, power draw, thermals, and whether the price premium is worth it.' },
    { url: 'https://www.newegg.com/p/rtx-5090-founders', title: 'RTX 5090 Founders Edition - Newegg',
      desc: 'Product listing and price for the GeForce RTX 5090 Founders Edition graphics card, with stock status and shipping estimates.' },
    { url: 'https://pcpartpicker.com/list/rtx5090-build', title: '5090 Gaming Build - PCPartPicker',
      desc: 'A parts list built around the RTX 5090: compatible PSU wattage, case clearance, and total build price with a Ryzen CPU.' },
  ] },

  // --- projects: ten days old -> dormant ---
  { daysAgo: 10, win: 4, pages: [
    { url: 'https://www.youtube.com/watch?v=vanbuild01', title: 'Full DIY Van Conversion Timelapse - YouTube',
      desc: 'A start-to-finish camper van conversion: framing, insulation, electrical wiring, water system, and the finished interior layout.' },
    { url: 'https://www.instructables.com/Campervan-Electrical-System/', title: 'Campervan Electrical System - Instructables',
      desc: 'Wiring a 12V camper electrical system: battery bank sizing, solar charging, fuse blocks, and a step-by-step layout diagram.' },
    { url: 'https://www.reddit.com/r/vandwellers/comments/insulation', title: 'Best insulation for a van build? - r/vandwellers',
      desc: 'Community thread comparing wool, foam board, and Thinsulate for insulating a camper van conversion in cold climates.' },
  ] },

  // --- boilerplate demo: react.dev repeats one generic og:description on every route ---
  { daysAgo: 1, win: 1, pages: [
    { url: 'https://react.dev/reference/react/useState', title: 'useState – React', desc: REACT_TAGLINE },
    { url: 'https://react.dev/reference/react/useEffect', title: 'useEffect – React', desc: REACT_TAGLINE },
    { url: 'https://react.dev/reference/react/useMemo', title: 'useMemo – React', desc: REACT_TAGLINE },
  ] },
];

const DAY = 86400000;

if (RESET) {
  db.exec('DELETE FROM events; DELETE FROM pages; DELETE FROM trails;');
  console.log('[seed] cleared events / pages / trails');
}

let tabSeq = 9000;
function emitPage(tab: number, win: number, ts: number, p: SeedPage): void {
  // navigate creates/updates the page and assigns the trail; meta arrives just after with the
  // description (exactly the live ordering), so boilerplate suppression sees prior pages first.
  ingestEvent({ ts, type: 'navigate', tabId: tab, windowId: win, url: p.url, title: p.title });
  ingestEvent({ ts: ts + 300, type: 'meta', tabId: tab, windowId: win, url: p.url, title: p.title, heading: p.title, description: p.desc });
  ingestEvent({ ts: ts + 900, type: 'activate', tabId: tab, windowId: win });
}

for (const tr of TRAILS) {
  const base = Date.now() - tr.daysAgo * DAY;
  const root = tabSeq++;
  // First page opens the "hub" tab.
  ingestEvent({ ts: base, type: 'open', tabId: root, windowId: tr.win });
  emitPage(root, tr.win, base + 1000, tr.pages[0]);
  // Remaining pages are child tabs opened from the hub — the opener graph keeps them one trail.
  let t = base;
  for (let i = 1; i < tr.pages.length; i++) {
    t += 3 * 60000; // three minutes of dwell between opens
    const child = tabSeq++;
    ingestEvent({ ts: t, type: 'open', tabId: child, openerTabId: root, windowId: tr.win });
    emitPage(child, tr.win, t + 1000, tr.pages[i]);
  }
}

const trails = db.prepare('SELECT COUNT(*) c FROM trails WHERE page_count >= 2').get() as { c: number };
const pages = db.prepare('SELECT COUNT(*) c FROM pages').get() as { c: number };
console.log(`[seed] user ${getUserId()} — ${pages.c} pages across ${trails.c} trails`);

if (ENRICH) {
  console.log('[seed] enriching labels + summaries via the LLM (this makes a few model calls)…');
  // Seed runs with the daemon stopped, so enrich every trail directly — no settle gate to respect.
  const ids = db.prepare('SELECT id FROM trails WHERE page_count >= 2 ORDER BY last_active DESC').all() as { id: string }[];
  for (const { id } of ids) {
    await labelTrail(id);
    await summarizeTrail(id, { force: true });
  }
  const rows = db.prepare('SELECT label, category, page_count FROM trails WHERE page_count >= 2 ORDER BY last_active DESC').all() as
    { label: string; category: string | null; page_count: number }[];
  console.log('[seed] trails:');
  for (const r of rows) console.log(`  [${(r.category || '?').padEnd(9)}] ${r.label} (${r.page_count}p)`);
}

console.log('[seed] done. Start the daemon with `pnpm backend`.');
