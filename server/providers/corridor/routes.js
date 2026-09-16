import { sendCorridorJson } from './cache.js';
import { corridorKeyStatus } from './keys.js';

/**
 * Parse `/api/corridor/<route>` paths. Returns { route, id } or null.
 *   /status, /alerts, /gauges, /gauges/<LID>/series, /air,
 *   /cameras, /cameras/<id>/frame, /incidents, /transit
 */
export function parseCorridorPath(pathname) {
  const parts = String(pathname || '')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  if (parts.length === 1) {
    if (
      [
        'status',
        'alerts',
        'gauges',
        'air',
        'cameras',
        'incidents',
        'transit',
      ].includes(parts[0])
    )
      return { route: parts[0], id: null };
    return null;
  }
  if (parts.length === 3 && parts[0] === 'gauges' && parts[2] === 'series') {
    let id;
    try {
      id = decodeURIComponent(parts[1]).toUpperCase();
    } catch {
      return null;
    }
    return /^[A-Z0-9]{3,8}$/.test(id) ? { route: 'gauge-series', id } : null;
  }
  if (parts.length === 3 && parts[0] === 'cameras' && parts[2] === 'frame') {
    let id;
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
    return /^(ga511|tdot):[A-Za-z0-9_-]{1,30}$/.test(id)
      ? { route: 'camera-frame', id }
      : null;
  }
  return null;
}

/** Headers every corridor JSON reply carries about freshness. */
export function corridorResultHeaders(result, ttlMs) {
  return {
    'X-Corridor-Cache': result.cache || 'MISS',
    'X-Corridor-Delayed': result.delayed ? '1' : '0',
    ...(Number.isFinite(ttlMs)
      ? { 'X-Corridor-TTL': String(Math.floor(ttlMs / 1000)) }
      : {}),
  };
}

/**
 * Build the request handler over a set of providers. Kept apart from the Vite
 * plugin so tests can drive it with fake providers and a fake response.
 */
export function createCorridorHandler(providers, { env = process.env } = {}) {
  const jsonRoutes = {
    alerts: providers.alerts,
    gauges: providers.gauges,
    air: providers.air,
    cameras: providers.cameras,
    incidents: providers.incidents,
    transit: providers.transit,
  };

  const fail = (res, error, label) => {
    if (error?.code === 'KEY_REQUIRED') {
      sendCorridorJson(res, 402, { error: 'key_required', keyId: error.keyId });
      return;
    }
    const status =
      Number.isInteger(error?.status) && error.status >= 400
        ? error.status
        : 502;
    if (status >= 500)
      console.warn(`[Corridor ${label}]`, error?.message || String(error));
    sendCorridorJson(res, status, {
      error:
        status === 502
          ? `${label} upstream unavailable`
          : error?.message || 'error',
    });
  };

  return async function handle(req, res) {
    if (req.method !== 'GET') {
      sendCorridorJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const parsed = parseCorridorPath(
      new URL(req.url || '/', 'http://localhost').pathname,
    );
    if (!parsed) {
      sendCorridorJson(res, 404, { error: 'Unknown corridor route' });
      return;
    }
    const { route, id } = parsed;
    if (route === 'status') {
      sendCorridorJson(res, 200, {
        keys: corridorKeyStatus(env),
        providers: Object.fromEntries(
          Object.entries(jsonRoutes).map(([name, provider]) => [
            name,
            { ttlMs: provider.ttlMs },
          ]),
        ),
      });
      return;
    }
    if (route === 'gauge-series') {
      try {
        const result = await providers.gauges.readSeries(id);
        sendCorridorJson(
          res,
          200,
          result.value,
          corridorResultHeaders(result, providers.gauges.ttlMs),
        );
      } catch (error) {
        fail(res, error, 'gauges');
      }
      return;
    }
    if (route === 'camera-frame') {
      try {
        const frame = await providers.cameras.readFrame(id);
        res.writeHead(200, {
          'Content-Type': frame.contentType || 'image/jpeg',
          'Cache-Control': 'no-store',
          'X-Corridor-Camera': id,
        });
        res.end(Buffer.from(frame.bytes));
      } catch (error) {
        fail(res, error, 'cameras');
      }
      return;
    }
    const provider = jsonRoutes[route];
    try {
      const result = await provider.read();
      sendCorridorJson(
        res,
        200,
        result.value,
        corridorResultHeaders(result, provider.ttlMs),
      );
    } catch (error) {
      fail(res, error, route);
    }
  };
}
