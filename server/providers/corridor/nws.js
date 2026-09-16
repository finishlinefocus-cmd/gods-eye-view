import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import {
  alertZonePath,
  normalizeNwsAlerts,
} from '../../../src/layers/corridor/normalize.js';

/**
 * NWS active alerts for the corridor (api.weather.gov, no key).
 *
 * Alerts are fetched statewide for TN+GA (one request), then trimmed to the
 * corridor. Most alerts carry no polygon of their own, only UGC zone ids, so
 * zone geometry is fetched lazily from the API's own /zones routes and kept
 * for the life of the process (zone shapes do not change). Zones that never
 * touch the corridor are remembered as such so they cost one request ever.
 */
export const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?area=TN,GA&status=actual';
export const NWS_ALERTS_TTL_MS = 90 * 1000;
const NWS_ZONE_ORIGIN = 'https://api.weather.gov';
const NWS_ZONE_FETCH_CONCURRENCY = 3;
const NWS_ZONE_CACHE_LIMIT = 600;

export function createNwsAlertsProvider({ fetchImpl = fetch } = {}) {
  const cache = createCorridorCache({ ttlMs: NWS_ALERTS_TTL_MS });
  /** @type {Map<string, object|null>} UGC → geometry (null = fetch failed) */
  const zones = new Map();

  async function zoneGeometry(url) {
    const path = alertZonePath(url);
    if (!path) return null;
    const id = path.slice(path.lastIndexOf('/') + 1);
    if (zones.has(id)) return zones.get(id);
    try {
      const feature = await fetchCorridorJson(`${NWS_ZONE_ORIGIN}${path}`, {
        fetchImpl,
        headers: { Accept: 'application/geo+json' },
      });
      const geometry = feature?.geometry || null;
      if (zones.size >= NWS_ZONE_CACHE_LIMIT)
        zones.delete(zones.keys().next().value);
      zones.set(id, geometry);
      return geometry;
    } catch (error) {
      console.warn('[Corridor NWS] zone fetch failed', id, error?.message);
      return null;
    }
  }

  async function resolveZones(payload) {
    const wanted = new Set();
    for (const feature of payload?.features || []) {
      if (feature?.geometry) continue;
      for (const url of feature?.properties?.affectedZones || []) {
        if (alertZonePath(url)) wanted.add(String(url));
      }
    }
    const queue = [...wanted];
    const workers = Array.from(
      { length: Math.min(NWS_ZONE_FETCH_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length) await zoneGeometry(queue.shift());
      },
    );
    await Promise.all(workers);
    const resolved = new Map();
    for (const [id, geometry] of zones)
      if (geometry) resolved.set(id, geometry);
    return resolved;
  }

  async function produce() {
    const payload = await fetchCorridorJson(NWS_ALERTS_URL, {
      fetchImpl,
      headers: { Accept: 'application/geo+json' },
    });
    const zoneGeometries = await resolveZones(payload);
    return {
      updated: payload?.updated || new Date().toISOString(),
      alerts: normalizeNwsAlerts(payload, zoneGeometries),
    };
  }

  return {
    id: 'alerts',
    ttlMs: NWS_ALERTS_TTL_MS,
    read: () => cache.read('alerts', produce),
    _zones: zones,
  };
}
