import { startHttp } from './daemon/http.js';
import { HOST, PORT, DB_PATH, ENGRAM_ENABLED } from './core/config.js';
import { getUserId } from './core/db.js';
import { LLM_BACKEND } from './core/llm.js';
import { startScheduler } from './daemon/scheduler.js';

const server = startHttp();

console.log(`
  Tab Zero backend
  → http://${HOST}:${PORT}
  → data:   ${DB_PATH}
  → engram: ${ENGRAM_ENABLED ? 'on' : 'off'}    llm: ${LLM_BACKEND}    user: ${getUserId()}
`);

// One adaptive scheduler owns enrichment (merged label+recap) and Engram flushing: settle-gated so
// it never races a growing trail, and backing off to idle when the browser is quiet. Explicit user
// actions ("tab zero") do the immediate, complete work — see checkpoint.ts.
startScheduler();

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
