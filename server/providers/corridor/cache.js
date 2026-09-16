import { coalesceProxyRequest } from '../common/http.js';

/**
 * Shared TTL cache for the corridor providers.
 *
 * Every corridor feed is fetched by the SERVER on behalf of all browser tabs:
 * one upstream request per TTL window, single-flight while it is in progress,
 * and serve-stale-on-failure so an upstream hiccup degrades to a "delayed"
 * badge rather than an empty map. The staleness ceiling keeps a feed that has
 * been down for a long time from displaying hours-old vehicles as live.
 */
export const CORRIDOR_STALE_MAX_MS = 15 * 60 * 1000;

/**
 * @param {object} options
 * @param {number} options.ttlMs Fresh window.
 * @param {number} [options.staleMaxMs] Longest a failed refresh may serve the previous body.
 * @param {() => number} [options.now] Injected clock for tests.
 */
export function createCorridorCache({
  ttlMs,
  staleMaxMs = CORRIDOR_STALE_MAX_MS,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new TypeError('Corridor cache needs a positive ttlMs');
  /** @type {Map<string, {at:number, value:any, error:string|null}>} */
  const entries = new Map();
  const inFlight = new Map();

  /**
   * Read `key`, refreshing through `produce` when the entry is missing or
   * older than the TTL. Resolves { value, at, delayed, error, cache } where
   * `delayed` is true when the body is older than the TTL (a refresh failed).
   * Throws only when there is no body at all to fall back on.
   */
  async function read(key, produce) {
    const entry = entries.get(key);
    const age = entry ? now() - entry.at : Infinity;
    if (entry && age < ttlMs) return { ...entry, delayed: false, cache: 'HIT' };
    const { promise } = coalesceProxyRequest(inFlight, key, async () => {
      try {
        const value = await produce();
        const fresh = { at: now(), value, error: null };
        entries.set(key, fresh);
        return { ...fresh, delayed: false, cache: 'MISS' };
      } catch (error) {
        const message = error?.message || String(error);
        const previous = entries.get(key);
        if (previous && now() - previous.at <= staleMaxMs) {
          previous.error = message;
          return { ...previous, delayed: true, cache: 'STALE' };
        }
        throw error;
      }
    });
    return promise;
  }

  return {
    read,
    peek: (key) => entries.get(key) || null,
    clear: () => entries.clear(),
  };
}

/** Standard JSON reply helper shared by the corridor routes. */
export function sendCorridorJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}
