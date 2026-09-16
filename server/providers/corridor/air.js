import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import { normalizeAirNowAreas } from '../../../src/layers/corridor/normalize.js';

/**
 * Air quality by AirNow reporting area (US EPA), no key.
 *
 * `airnowgovapi.com/reportingarea/get_state` is the JSON the airnow.gov map
 * itself reads: public-domain EPA observations, but not the documented
 * developer API, so it is treated as best-effort — one request per state per
 * hour (observations change hourly) and a long stale window. The documented
 * keyed API (docs.airnowapi.org) is the drop-in replacement should this move.
 */
export const AIRNOW_STATE_URL = (state) =>
  `https://airnowgovapi.com/reportingarea/get_state?state_code=${state}`;
export const AIRNOW_STATES = Object.freeze(['TN', 'GA']);
export const AIRNOW_TTL_MS = 60 * 60 * 1000;
export const AIRNOW_STALE_MAX_MS = 6 * 60 * 60 * 1000;

export function createAirQualityProvider({ fetchImpl = fetch } = {}) {
  const cache = createCorridorCache({
    ttlMs: AIRNOW_TTL_MS,
    staleMaxMs: AIRNOW_STALE_MAX_MS,
  });

  async function produce() {
    const rows = [];
    for (const state of AIRNOW_STATES) {
      const payload = await fetchCorridorJson(AIRNOW_STATE_URL(state), {
        fetchImpl,
      });
      for (const row of Array.isArray(payload) ? payload : [])
        rows.push({ ...row, stateCode: row.stateCode || state });
    }
    return { areas: normalizeAirNowAreas(rows) };
  }

  return {
    id: 'air',
    ttlMs: AIRNOW_TTL_MS,
    read: () => cache.read('air', produce),
  };
}
