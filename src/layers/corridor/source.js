/**
 * Browser-side reader for the corridor provider routes. Every request goes to
 * this origin's `/api/corridor/*`; the browser never learns an upstream URL.
 * A reply whose `delayed` flag is set carries a body older than the provider's
 * TTL (an upstream refresh failed) and the layer shows it with a badge.
 */
export const CORRIDOR_API_BASE = '/api/corridor';
const GAUGE_LID = /^[A-Z0-9]{3,8}$/;
const CAMERA_ID = /^[a-z0-9][a-z0-9:_-]{0,80}$/i;

export function createCorridorSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = CORRIDOR_API_BASE,
} = {}) {
  async function readJson(path, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${base}${path}`, { signal });
    const delayed = response.headers?.get?.('X-Corridor-Delayed') === '1';
    if (response.status === 402) {
      // Provider present but its key is absent — a configuration state, not a fault.
      const body = await response.json().catch(() => ({}));
      return {
        keyRequired: true,
        keyId: body.keyId || null,
        delayed,
        body: null,
      };
    }
    if (!response.ok)
      throw new Error(`Corridor ${path} returned ${response.status}`);
    const body = await response.json();
    signal?.throwIfAborted();
    return { keyRequired: false, keyId: null, delayed, body };
  }
  return {
    getStatus: (options) => readJson('/status', options),
    getAlerts: (options) => readJson('/alerts', options),
    getGauges: (options) => readJson('/gauges', options),
    getGaugeSeries(lid, options) {
      const id = String(lid || '').toUpperCase();
      if (!GAUGE_LID.test(id)) throw new Error('Invalid gauge id');
      return readJson(`/gauges/${id}/series`, options);
    },
    getAir: (options) => readJson('/air', options),
    getCameras: (options) => readJson('/cameras', options),
    getIncidents: (options) => readJson('/incidents', options),
    getTransit: (options) => readJson('/transit', options),
    /** Same-origin still-image URL for a camera; cache-busted per refresh. */
    getCameraFrameUrl(cameraId, { bust = Date.now() } = {}) {
      const id = String(cameraId || '');
      if (!CAMERA_ID.test(id)) return null;
      return `${base}/cameras/${encodeURIComponent(id)}/frame?t=${bust}`;
    },
  };
}

const centerlineUrl = new URL(
  '../../data/local_data/corridor/i75-centerline.geojson',
  import.meta.url,
).href;

/** Bundled I-75 centerline (OSM extract) and a GTFS-RT reader over the transit proxy. */
export function createCorridorStaticSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getCenterline({ signal } = {}) {
      const response = await fetchImpl(centerlineUrl, {
        signal,
        cache: 'force-cache',
      });
      if (!response.ok)
        throw new Error(`I-75 centerline HTTP ${response.status}`);
      return response.json();
    },
    async getGtfsVehicles(feedId, { signal } = {}) {
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(feedId || '')))
        throw new Error('Invalid transit feed id');
      const response = await fetchImpl(`/api/transit/vehicles/${feedId}`, {
        signal,
      });
      if (!response.ok)
        throw new Error(`Transit ${feedId} returned ${response.status}`);
      const body = await response.json();
      return {
        body,
        delayed: response.headers?.get?.('X-GEV-Cache') === 'STALE-ERROR',
      };
    },
  };
}
