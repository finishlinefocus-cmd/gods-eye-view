import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import { corridorKey } from './keys.js';
import { normalizeCartaVehicles } from '../../../src/layers/corridor/normalize.js';

/**
 * Corridor transit: which GTFS-RT feeds the browser should poll through the
 * existing `/api/transit/vehicles/<id>` proxy (MARTA, keyless), plus CARTA
 * (Chattanooga) vehicles from the Clever Devices BusTime v3 API, which only
 * answers with a key CARTA issues on request (CARTA_BUSTIME_KEY).
 */
export const CARTA_VEHICLES_URL = (key) =>
  `https://bustracker.gocarta.org/bustime/api/v3/getvehicles?format=json&key=${encodeURIComponent(key)}`;
export const CORRIDOR_TRANSIT_TTL_MS = 20 * 1000;
export const CORRIDOR_GTFS_FEEDS = Object.freeze([
  Object.freeze({ id: 'marta', agency: 'marta', agencyName: 'MARTA' }),
]);

export function createCorridorTransitProvider({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const cache = createCorridorCache({ ttlMs: CORRIDOR_TRANSIT_TTL_MS });

  async function read() {
    const key = corridorKey('carta', env);
    let carta = {
      id: 'carta',
      ok: false,
      keyRequired: true,
      keyId: 'carta',
      count: 0,
    };
    let vehicles = [];
    let delayed = false;
    if (key) {
      try {
        const result = await cache.read('carta', async () =>
          normalizeCartaVehicles(
            await fetchCorridorJson(CARTA_VEHICLES_URL(key), { fetchImpl }),
          ),
        );
        vehicles = result.value;
        delayed = result.delayed;
        carta = {
          id: 'carta',
          ok: true,
          delayed: result.delayed,
          count: vehicles.length,
        };
      } catch (error) {
        carta = {
          id: 'carta',
          ok: false,
          error: error?.message || String(error),
          count: 0,
        };
      }
    }
    return {
      value: { gtfsFeeds: CORRIDOR_GTFS_FEEDS, vehicles, sources: [carta] },
      delayed,
      cache: 'MERGED',
    };
  }

  return { id: 'transit', ttlMs: CORRIDOR_TRANSIT_TTL_MS, read };
}
