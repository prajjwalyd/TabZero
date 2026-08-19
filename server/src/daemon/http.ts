import http from 'node:http';
import { HOST, PORT, TOKEN, ENGRAM_ENABLED } from '../core/config.js';
import { db, getUserId } from '../core/db.js';
import { ingestEvent } from '../capture/pipeline.js';
import {
  listTrails, getTrailDetail, getTrail, resurrectUrls, searchTrails, weekInTabs, summarizeTrail, getInterests, deleteTrail,
} from '../trails/trails.js';
import { LLM_BACKEND } from '../core/llm.js';
import { zeroCheckpoint } from '../trails/checkpoint.js';
import { noteActivity } from './scheduler.js';
import type { TabEventInput } from '../core/types.js';

// Deliberately NO `Access-Control-Allow-*` headers. This daemon serves your entire browsing history
// on localhost, and a wildcard ACAO let any page you visited read it cross-origin. The extension
// doesn't need CORS at all — MV3 `host_permissions` exempt its fetches from it — so withholding the
// headers blocks web pages while leaving the extension unaffected. It's also what makes returning
// the auth token from /health safe: a page can send that request but can't read the response.
//
// ...but ONLY in combination with the Host check below. Withholding CORS headers is not on its own a
// secret boundary — see ALLOWED_HOSTS.
function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff', // never let a response be re-interpreted as script/HTML
  });
  res.end(JSON.stringify(body));
}

/**
 * The Host values this daemon will answer to. Anything else is treated as a DNS-rebinding attempt.
 *
 * Withholding CORS headers stops a page on `evil.com` from READING a cross-origin response. It does
 * nothing once the request is *same*-origin — and an attacker can make it same-origin without
 * touching this machine: serve a page from `evil.com`, then re-resolve `evil.com` to 127.0.0.1. The
 * browser now believes `http://evil.com:8787` is the page's own origin, sends the fetch here, and
 * hands the response back to the page. CORS is never consulted. `/health` would surrender the token,
 * and the token unlocks the complete browsing history.
 *
 * The fix is that the browser always sends, in `Host`, the origin it believes it is talking to. Under
 * rebinding that is `evil.com:8787`; the extension and CLI always send a loopback name. Pinning Host
 * to the names we actually serve separates the two, and is the standard defense for a local daemon.
 */
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
  '127.0.0.1', 'localhost', '[::1]',
]);

// An event batch is the only large body we accept; 4MB is far above a real one (40 events, capped
// client-side) and far below anything that pressures memory. Without a cap, `data += c` grows
// unbounded on a single request.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

type BodyResult = { ok: true; body: any } | { ok: false; code: 400 | 413 };

function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let data = '';
    let bytes = 0;
    let settled = false;
    const finish = (r: BodyResult) => { if (!settled) { settled = true; resolve(r); } };
    req.on('data', (c) => {
      // Once over the limit we keep draining but stop accumulating: memory is bounded either way, and
      // destroying the socket here would reset the connection before the 413 could flush, so the
      // client would see ECONNRESET instead of being told what was wrong.
      if (settled) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        data = '';
        return finish({ ok: false, code: 413 });
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return finish({ ok: true, body: {} });
      // Malformed JSON is a 400, not a silently-empty object: quietly coercing it to `{}` made a
      // broken client look like an empty-but-valid request, which is indistinguishable from success.
      try { finish({ ok: true, body: JSON.parse(data) }); } catch { finish({ ok: false, code: 400 }); }
    });
    req.on('error', () => finish({ ok: false, code: 400 }));
  });
}

/** 400/413 from readBody, rendered. */
function sendBodyError(res: http.ServerResponse, code: 400 | 413): void {
  send(res, code, { error: code === 413 ? 'payload too large' : 'invalid json' });
}

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...(args as any[])) as { c: number }).c;
}

export function startHttp(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      // FIRST, before anything else including /health: reject any Host we don't serve. This is the
      // anti-DNS-rebinding gate; see ALLOWED_HOSTS. It has to precede the token check, because the
      // whole point of the attack is to read the token out of /health, which needs no token.
      if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) {
        return send(res, 403, { error: 'forbidden' });
      }

      if (req.method === 'OPTIONS') return send(res, 204, {});
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      const path = url.pathname;

      if (path !== '/health' && req.headers['x-tabzero-token'] !== TOKEN) {
        return send(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, {
          ok: true,
          token: TOKEN, // how the extension bootstraps auth; unreadable to web pages (no CORS headers)
          userId: getUserId(),
          engram: ENGRAM_ENABLED,
          llm: LLM_BACKEND,
          trails: count('SELECT COUNT(*) c FROM trails WHERE page_count >= 2'),
          pages: count('SELECT COUNT(*) c FROM pages'),
        });
      }

      if (req.method === 'POST' && path === '/events') {
        const r = await readBody(req);
        if (!r.ok) return sendBodyError(res, r.code);
        const events: TabEventInput[] = Array.isArray(r.body?.events) ? r.body.events.slice(0, 500) : [];
        let n = 0;
        for (const e of events) {
          try { ingestEvent(e); n++; } catch (err) { console.error('[ingest]', (err as Error).message); }
        }
        if (n) noteActivity(); // kick the scheduler back to base cadence
        return send(res, 200, { ok: true, count: n });
      }

      if (req.method === 'GET' && path === '/trails') {
        const limit = Number(url.searchParams.get('limit') || 0) || undefined;
        const includeArchived = url.searchParams.get('archived') === '1';
        return send(res, 200, { trails: listTrails({ limit, includeArchived }) });
      }

      const m = path.match(/^\/trails\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const detail = await getTrailDetail(m[1], { summarize: url.searchParams.get('summarize') === '1' });
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'not found' });
      }

      if (req.method === 'DELETE' && m) {
        const res2 = deleteTrail(m[1]);
        return res2 ? send(res, 200, res2) : send(res, 404, { error: 'not found' });
      }

      const rm = path.match(/^\/trails\/([^/]+)\/resurrect$/);
      if (req.method === 'POST' && rm) {
        const t = getTrail(rm[1]);
        if (!t) return send(res, 404, { error: 'not found' });
        const summary = await summarizeTrail(rm[1]);
        return send(res, 200, { id: rm[1], label: t.label, summary, urls: resurrectUrls(rm[1]) });
      }

      if (req.method === 'POST' && path === '/search') {
        const r = await readBody(req);
        if (!r.ok) return sendBodyError(res, r.code);
        const query = String(r.body?.query || '').slice(0, 1000); // an unbounded query reaches the LLM/Engram
        const hits = await searchTrails(getUserId(), query, Number(r.body?.limit) || 5);
        return send(res, 200, { hits });
      }

      if (req.method === 'GET' && path === '/week') {
        return send(res, 200, weekInTabs());
      }

      if (req.method === 'GET' && path === '/interests') {
        return send(res, 200, await getInterests(getUserId()));
      }

      if (req.method === 'POST' && path === '/zero') {
        const r = await readBody(req);
        if (!r.ok) return sendBodyError(res, r.code);
        const openUrls: string[] = Array.isArray(r.body?.openUrls)
          ? r.body.openUrls.filter((u: unknown): u is string => typeof u === 'string').slice(0, 2000)
          : [];
        return send(res, 200, await zeroCheckpoint(openUrls));
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[http]', (e as Error).stack || (e as Error).message);
      return send(res, 500, { error: 'internal' });
    }
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use — Tab Zero is probably already running.\n  (Change it with TABZERO_PORT, or stop the other instance.)\n`);
    } else {
      console.error('[http]', e.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST);
  return server;
}
