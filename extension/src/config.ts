// Must match the backend daemon (server/src/core/config.ts).
// Changing the port here is enough — manifest host_permissions cover all of 127.0.0.1/localhost.
export const BACKEND = 'http://127.0.0.1:8787';

/**
 * The daemon mints a random token per install (server/src/core/config.ts::loadToken) instead of
 * shipping a constant every user shares, so the extension has to ask for it. /health is the only
 * unauthenticated route, and the daemon returns no CORS headers — a web page can issue that request
 * but cannot read the response, while the extension can, because MV3 host_permissions exempt its
 * fetches from CORS.
 *
 * Cached in memory only, never in chrome.storage: a service-worker restart just re-fetches (one
 * localhost request), which keeps it self-healing if the token is ever rotated or the data dir wiped.
 * A stored copy would go stale and 401 until someone cleared it by hand.
 */
let cachedToken: string | null = null;

async function authToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const h = await (await fetch(`${BACKEND}/health`)).json();
  const t = typeof h?.token === 'string' ? h.token : '';
  if (t) cachedToken = t; // don't cache a miss — an older/half-started daemon may not have answered yet
  return t;
}

/** Auth headers for a daemon call; pass true when sending a JSON body. */
export async function authHeaders(json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'x-tabzero-token': await authToken() };
  if (json) h['content-type'] = 'application/json';
  return h;
}
