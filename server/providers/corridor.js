import { createNwsAlertsProvider } from './corridor/nws.js';
import { createGaugesProvider } from './corridor/gauges.js';
import { createAirQualityProvider } from './corridor/air.js';
import { createIncidentsProvider } from './corridor/incidents.js';
import { createCamerasProvider } from './corridor/cameras.js';
import { createCorridorTransitProvider } from './corridor/transit.js';
import { createCorridorHandler } from './corridor/routes.js';

export { createCorridorHandler, parseCorridorPath } from './corridor/routes.js';
export { createCorridorCache } from './corridor/cache.js';
export {
  CORRIDOR_KEYS,
  corridorKey,
  corridorKeyStatus,
} from './corridor/keys.js';

/** Every corridor provider over one fetch implementation and environment. */
export function createCorridorProviders({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  return {
    alerts: createNwsAlertsProvider({ fetchImpl }),
    gauges: createGaugesProvider({ fetchImpl }),
    air: createAirQualityProvider({ fetchImpl }),
    incidents: createIncidentsProvider({ fetchImpl, env }),
    cameras: createCamerasProvider({ fetchImpl, env }),
    transit: createCorridorTransitProvider({ fetchImpl, env }),
  };
}

/**
 * Vite plugin: Chattanooga ↔ Atlanta corridor data pack (`/api/corridor/*`).
 *
 * Every upstream is fetched server-side, clipped to the corridor polygon and
 * cached (30 s – 1 h per source) so any number of browser tabs cost each
 * public API one request per window. A failed refresh serves the previous
 * body with `X-Corridor-Delayed: 1`; a missing provider key answers 402 with
 * the key id. Camera snapshots are relayed only for cameras in the cached
 * inventory (no client-supplied URLs).
 */
export function corridorProxy(options = {}) {
  const providers = createCorridorProviders(options);
  const handler = createCorridorHandler(providers, {
    env: options.env || process.env,
  });
  const install = (server) => {
    server.middlewares.use('/api/corridor', (req, res) => {
      handler(req, res).catch((error) => {
        console.error('[Corridor]', error?.message || String(error));
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Corridor proxy error' }));
        }
      });
    });
  };
  return {
    name: 'corridor-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
