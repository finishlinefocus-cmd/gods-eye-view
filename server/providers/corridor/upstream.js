import { readResponseJsonCapped } from '../common/http.js';

/** Identify-yourself header every corridor upstream sees (NWS requires one). */
export const CORRIDOR_USER_AGENT =
  'gods-eye-view-corridor/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

export const CORRIDOR_UPSTREAM_TIMEOUT_MS = 15000;
export const CORRIDOR_UPSTREAM_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Fetch one JSON document from a fixed upstream URL with a timeout and a body
 * cap. Redirects are not followed: every corridor URL is a constant the
 * provider owns, so a 3xx is an upstream change worth surfacing, not silently
 * chasing to an unknown host.
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @returns {Promise<any>}
 */
export async function fetchCorridorJson(
  url,
  {
    fetchImpl = fetch,
    headers = {},
    timeoutMs = CORRIDOR_UPSTREAM_TIMEOUT_MS,
    maxBytes = CORRIDOR_UPSTREAM_MAX_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
        'User-Agent': CORRIDOR_USER_AGENT,
        ...headers,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel?.().catch(() => {});
      throw new Error(`upstream redirected (${response.status})`);
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      const err = new Error(`upstream HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return await readResponseJsonCapped(response, maxBytes, controller.signal);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
