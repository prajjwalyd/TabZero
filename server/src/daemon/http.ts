import http from 'node:http';
import { HOST, PORT, TOKEN, ENGRAM_ENABLED } from '../core/config.js';
import { db, getUserId } from '../core/db.js';
import { ingestEvent } from '../capture/pipeline.js';
import {
  listTrails, getTrailDetail, getTrail, resurrectUrls, searchTrails, weekInTabs, summarizeTrail, getInterests,
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
function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...(args as any[])) as { c: number }).c;
}

export function startHttp(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
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
        const body = await readBody(req);
        const events: TabEventInput[] = Array.isArray(body?.events) ? body.events : [];
        let n = 0;
        for (const e of events) {
          try { ingestEvent(e); n++; } catch (err) { console.error('[ingest]', (err as Error).message); }
        }
        if (n) noteActivity(); // kick the scheduler back to base cadence
        return send(res, 200, { ok: true, count: n });
      }

      if (req.method === 'GET' && path === '/trails') {
        const limit = Number(url.searchParams.get('limit') || 0) || undefined;
        return send(res, 200, { trails: listTrails({ limit }) });
      }

      const m = path.match(/^\/trails\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const detail = await getTrailDetail(m[1], { summarize: url.searchParams.get('summarize') === '1' });
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'not found' });
      }

      const rm = path.match(/^\/trails\/([^/]+)\/resurrect$/);
      if (req.method === 'POST' && rm) {
        const t = getTrail(rm[1]);
        if (!t) return send(res, 404, { error: 'not found' });
        const summary = await summarizeTrail(rm[1]);
        return send(res, 200, { id: rm[1], label: t.label, summary, urls: resurrectUrls(rm[1]) });
      }

      if (req.method === 'POST' && path === '/search') {
        const body = await readBody(req);
        const hits = await searchTrails(getUserId(), String(body?.query || ''), Number(body?.limit) || 5);
        return send(res, 200, { hits });
      }

      if (req.method === 'GET' && path === '/week') {
        return send(res, 200, weekInTabs());
      }

      if (req.method === 'GET' && path === '/interests') {
        return send(res, 200, await getInterests(getUserId()));
      }

      if (req.method === 'POST' && path === '/zero') {
        const body = await readBody(req);
        const openUrls: string[] = Array.isArray(body?.openUrls)
          ? body.openUrls.filter((u: unknown): u is string => typeof u === 'string')
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
