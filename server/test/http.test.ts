// The daemon's security boundary, driven over a real socket.
//
// This daemon serves an entire browsing history on localhost with no CORS headers, and `/health`
// hands out the auth token that unlocks every other route. The reasoning for why that is safe used to
// stop at "no CORS headers, so a web page can't read the response" — which is true and insufficient.
// CORS is not consulted at all once a request is SAME-origin, and an attacker can make it same-origin
// without touching this machine: serve a page from evil.com, then re-resolve evil.com to 127.0.0.1.
// The browser then treats http://evil.com:PORT as the page's own origin, and hands the response —
// token included — straight back to the page. That is DNS rebinding, and the `Host` header is the
// only thing that distinguishes it from a legitimate call.
//
// These tests exercise the real HTTP server on a real port, because the vulnerability lived in header
// handling: a mocked request object would have proven nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tabzero-http-'));
process.env.TABZERO_DATA = tmp;
process.env.TABZERO_PORT = '8791'; // not 8787 — never collide with a real daemon
process.env.TABZERO_USER_ID = 'test-user';
process.env.ENGRAM_API_KEY = '';

const { startHttp } = await import('../src/daemon/http.ts');
const { TOKEN, PORT } = await import('../src/core/config.ts');

const BASE = `http://127.0.0.1:${PORT}`;
let server: import('node:http').Server;

before(() => {
  server = startHttp();
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** fetch() rewrites Host from the URL, so send the raw request ourselves to control it. */
function rawGet(path: string, host: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ connect }) => {
      const sock = connect(PORT, '127.0.0.1', () => {
        sock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
            (token ? `x-tabzero-token: ${token}\r\n` : '') +
            'Connection: close\r\n\r\n',
        );
      });
      let raw = '';
      sock.on('data', (c: Buffer) => (raw += c.toString()));
      sock.on('end', () => {
        const status = Number(raw.slice(9, 12));
        resolve({ status, body: raw.slice(raw.indexOf('\r\n\r\n') + 4) });
      });
      sock.on('error', reject);
    });
  });
}

test('a rebound Host cannot reach /health — the token stays secret', async () => {
  // The whole attack in one request. Loopback Host works; the attacker's does not.
  const ok = await rawGet('/health', `127.0.0.1:${PORT}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(TOKEN), 'the extension must still be able to bootstrap its token');

  for (const host of ['evil.example.com', `evil.example.com:${PORT}`, 'attacker.test', '169.254.169.254']) {
    const r = await rawGet('/health', host);
    assert.equal(r.status, 403, `Host: ${host} must be refused, got ${r.status}`);
    assert.ok(!r.body.includes(TOKEN), `Host: ${host} leaked the token`);
  }
});

test('the Host gate covers the data routes, and runs before the token comparison', async () => {
  const good = await rawGet('/trails', `localhost:${PORT}`, TOKEN);
  assert.equal(good.status, 200, 'a loopback caller with a token still works');

  // Even holding a valid token, a rebound origin gets nothing.
  const bad = await rawGet('/trails', 'evil.example.com', TOKEN);
  assert.equal(bad.status, 403, 'a rebound Host must be refused on data routes too');

  // Ordering: an UNAUTHENTICATED request from a rebound Host must answer 403 (the Host gate fired),
  // not 401 (the token check fired first). Both refuse, so this isn't a leak either way — but it is
  // the only externally observable proof of the order, and without it a gate moved below the token
  // check passes every other assertion here. We want the token never compared on a hostile request:
  // `!==` on strings is not constant-time, and there is no reason to run it for a caller we are
  // already refusing.
  const unauth = await rawGet('/trails', 'evil.example.com');
  assert.equal(unauth.status, 403, `expected the Host gate to fire first (403), got ${unauth.status}`);
});

test('every loopback name the extension and CLI might use is accepted', async () => {
  for (const host of [
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    '127.0.0.1',
    'localhost',
    `LOCALHOST:${PORT}`,
  ]) {
    const r = await rawGet('/health', host);
    assert.equal(r.status, 200, `Host: ${host} must be allowed (it is us), got ${r.status}`);
  }
});

test('an oversized body is refused instead of being buffered without limit', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tabzero-token': TOKEN },
    body: JSON.stringify({
      events: [
        {
          ts: Date.now(),
          type: 'navigate',
          tabId: 1,
          url: 'https://a.test/',
          title: 'x'.repeat(5 * 1024 * 1024),
        },
      ],
    }),
  });
  assert.equal(res.status, 413, 'a 5MB body must be rejected, not accumulated into a string');
});

test('malformed JSON is a 400, not a silent empty success', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tabzero-token': TOKEN },
    body: '{"events": [ oops',
  });
  assert.equal(res.status, 400, 'a broken client should hear about it, not read as an empty batch');
});

test('responses carry nosniff, and still no CORS headers', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // The Host gate is the real boundary now, but the absent ACAO is still load-bearing defense in
  // depth: it is what stops an ordinary cross-origin read when the Host header is honest.
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no wildcard ACAO may reappear');
});

test('an unauthenticated caller on a valid Host still gets nothing but /health', async () => {
  for (const p of ['/trails', '/week', '/interests']) {
    const r = await rawGet(p, `127.0.0.1:${PORT}`);
    assert.equal(r.status, 401, `${p} must require the token`);
  }
});
