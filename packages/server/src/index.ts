import { startHttp } from './http.js';
import { HOST, PORT, DB_PATH, ENGRAM_ENABLED } from './config.js';
import { getUserId } from './db.js';
import { LLM_BACKEND } from './llm.js';
import { enrichLabels, enrichSummaries, flushEngram } from './sync.js';

const server = startHttp();

console.log(`
  ▟ Tab Zero backend
  → http://${HOST}:${PORT}
  → data:   ${DB_PATH}
  → engram: ${ENGRAM_ENABLED ? 'on' : 'off'}    llm: ${LLM_BACKEND}    user: ${getUserId()}
`);

// Enrichment pass: upgrade provisional trail labels with the LLM.
let labeling = false;
setInterval(async () => {
  if (labeling) return;
  labeling = true;
  try {
    const n = await enrichLabels(3);
    if (n) console.log(`[label] named ${n} trail(s)`);
  } catch (e) {
    console.error('[label]', (e as Error).message);
  } finally {
    labeling = false;
  }
}, 15000);

// Pre-warm pass: keep one recap summary fresh at a time so resurrect is usually instant.
let warming = false;
setInterval(async () => {
  if (warming) return;
  warming = true;
  try {
    await enrichSummaries(1);
  } catch (e) {
    console.error('[recap]', (e as Error).message);
  } finally {
    warming = false;
  }
}, 20000);

// Reconciliation pass: push changed trails up to Engram (bounded per-trail memory).
let syncing = false;
setInterval(async () => {
  if (syncing || !ENGRAM_ENABLED) return;
  syncing = true;
  try {
    const n = await flushEngram(20);
    if (n) console.log(`[engram] pushed ${n} trail(s)`);
  } catch (e) {
    console.error('[engram]', (e as Error).message);
  } finally {
    syncing = false;
  }
}, 45000);

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
