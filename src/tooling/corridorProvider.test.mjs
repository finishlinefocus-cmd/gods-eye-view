import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  corridorProxy,
  createCorridorHandler,
  createCorridorProviders,
  parseCorridorPath,
} from '../../server/providers/corridor.js';
import { createCamerasProvider } from '../../server/providers/corridor/cameras.js';
import { createIncidentsProvider } from '../../server/providers/corridor/incidents.js';
import { createCorridorTransitProvider } from '../../server/providers/corridor/transit.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const fixture = (name) =>
  readFileSync(
    new URL(`../../scripts/fixtures/corridor/${name}`, import.meta.url),
    'utf8',
  );

class FakeResponse extends EventEmitter {
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }
  end(body) {
    this.body = body;
    this.emit('finish');
  }
  json() {
    return JSON.parse(String(this.body));
  }
}

const jsonResponse = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function drive(handler, url) {
  const res = new FakeResponse();
  await handler({ method: 'GET', url }, res);
  return res;
}

test('corridor path parsing admits only the fixed routes and well-formed ids', () => {
  assert.deepEqual(parseCorridorPath('/alerts'), { route: 'alerts', id: null });
  assert.deepEqual(parseCorridorPath('/gauges/chat1/series'), {
    route: 'gauge-series',
    id: 'CHAT1',
  });
  assert.deepEqual(parseCorridorPath('/cameras/ga511:186/frame'), {
    route: 'camera-frame',
    id: 'ga511:186',
  });
  assert.deepEqual(parseCorridorPath('/cameras/ga511%3A186/frame'), {
    route: 'camera-frame',
    id: 'ga511:186',
  });
  assert.equal(parseCorridorPath('/gauges/../x/series'), null);
  assert.equal(parseCorridorPath('/gauges/CHAT1'), null);
  assert.equal(parseCorridorPath('/cameras/https://evil.example/frame'), null);
  assert.equal(parseCorridorPath('/cameras/other:1/frame'), null);
  assert.equal(parseCorridorPath('/cameras/%E0%A4%A/frame'), null);
  assert.equal(parseCorridorPath('/nope'), null);
  assert.equal(parseCorridorPath('/'), null);
});

test('corridor plugin is registered in the local provider set under /api/corridor', () => {
  const plugin = localProviderPlugins().find(
    (entry) => entry.name === 'corridor-proxy',
  );
  assert.ok(plugin);
  const mounted = [];
  plugin.configureServer({
    middlewares: { use: (path) => mounted.push(path) },
  });
  assert.deepEqual(mounted, ['/api/corridor']);
  assert.equal(typeof corridorProxy().configurePreviewServer, 'function');
});

test('handler: JSON routes carry cache/delayed headers, key gating answers 402, unknown routes 404', async () => {
  const providers = {
    alerts: {
      ttlMs: 90000,
      read: async () => ({
        value: { alerts: [] },
        delayed: true,
        cache: 'STALE',
      }),
    },
    gauges: {
      ttlMs: 600000,
      read: async () => ({
        value: { gauges: [] },
        delayed: false,
        cache: 'HIT',
      }),
      readSeries: async (lid) => {
        if (lid !== 'CHAT1') {
          const err = new Error('Gauge not in corridor');
          err.status = 404;
          throw err;
        }
        return {
          value: { gauge: { lid }, series: { points: [] } },
          delayed: false,
          cache: 'MISS',
        };
      },
    },
    air: {
      ttlMs: 3600000,
      read: async () => {
        throw new Error('upstream HTTP 503');
      },
    },
    cameras: {
      ttlMs: 3600000,
      read: async () => {
        const err = new Error('key');
        err.code = 'KEY_REQUIRED';
        err.keyId = 'ga511';
        throw err;
      },
      readFrame: async () => {
        const err = new Error('key');
        err.code = 'KEY_REQUIRED';
        err.keyId = 'ga511';
        throw err;
      },
    },
    incidents: {
      ttlMs: 60000,
      read: async () => ({
        value: { incidents: [{ id: 'x' }] },
        delayed: false,
        cache: 'MERGED',
      }),
    },
    transit: {
      ttlMs: 20000,
      read: async () => ({
        value: { vehicles: [] },
        delayed: false,
        cache: 'MERGED',
      }),
    },
  };
  const handler = createCorridorHandler(providers, {
    env: { GA511_API_KEY: '' },
  });

  let res = await drive(handler, '/alerts');
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Corridor-Delayed'], '1');
  assert.equal(res.headers['X-Corridor-Cache'], 'STALE');
  assert.equal(res.headers['X-Corridor-TTL'], '90');

  res = await drive(handler, '/incidents');
  assert.equal(res.headers['X-Corridor-Delayed'], '0');
  assert.deepEqual(res.json().incidents, [{ id: 'x' }]);

  res = await drive(handler, '/gauges/CHAT1/series');
  assert.equal(res.status, 200);
  assert.equal(res.json().gauge.lid, 'CHAT1');
  res = await drive(handler, '/gauges/ZZZZ9/series');
  assert.equal(res.status, 404);

  res = await drive(handler, '/air');
  assert.equal(
    res.status,
    502,
    'an upstream failure with nothing cached is a 502, never a crash',
  );

  res = await drive(handler, '/cameras');
  assert.equal(res.status, 402);
  assert.deepEqual(res.json(), { error: 'key_required', keyId: 'ga511' });
  res = await drive(handler, '/cameras/ga511:1/frame');
  assert.equal(res.status, 402);

  res = await drive(handler, '/status');
  assert.equal(res.json().keys.ga511.set, false);
  assert.equal(res.json().providers.transit.ttlMs, 20000);

  res = await drive(handler, '/whatever');
  assert.equal(res.status, 404);
  const post = new FakeResponse();
  await handler({ method: 'POST', url: '/alerts' }, post);
  assert.equal(post.status, 405);
});

test('cameras: the frame relay only fetches allowlisted URLs from the keyed inventory', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith('https://511ga.org/api/v2/get/cameras'))
      return jsonResponse(fixture('ga511-cameras.json'));
    if (String(url) === 'https://511ga.org/map/Cctv/186')
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    throw new Error(`unexpected fetch ${url}`);
  };
  const keyless = createCamerasProvider({ fetchImpl, env: {} });
  await assert.rejects(
    () => keyless.read(),
    (error) => error.code === 'KEY_REQUIRED' && error.keyId === 'ga511',
  );
  assert.equal(requested.length, 0, 'no key, no upstream request');

  const cameras = createCamerasProvider({
    fetchImpl,
    env: { GA511_API_KEY: 'secret-key' },
  });
  const list = await cameras.read();
  assert.deepEqual(
    list.value.cameras.map((camera) => camera.id),
    ['ga511:1'],
    'Savannah (outside) and the evil-host view are dropped',
  );
  assert.deepEqual(
    list.value.sources.map((source) => [
      source.id,
      source.ok,
      source.keyRequired === true,
    ]),
    [
      ['ga511', true, false],
      ['tdot', false, true],
    ],
  );
  assert.ok(requested[0].includes('key=secret-key'));
  assert.equal(
    JSON.stringify(list.value).includes('secret-key'),
    false,
    'the key never leaves the server',
  );

  assert.equal(
    await cameras.snapshotUrlFor('ga511:1'),
    'https://511ga.org/map/Cctv/186',
  );
  assert.equal(await cameras.snapshotUrlFor('ga511:3'), null);
  assert.equal(await cameras.snapshotUrlFor('ga511:1/../evil'), null);
  assert.equal(await cameras.snapshotUrlFor('https://evil.example/x'), null);
  const frame = await cameras.readFrame('ga511:1');
  assert.equal(frame.contentType, 'image/jpeg');
  assert.equal(frame.bytes.length, 4);
  await assert.rejects(() => cameras.readFrame('ga511:999'), /Unknown camera/);
  assert.equal(
    requested.filter((url) => url.includes('/api/v2/')).length,
    1,
    'inventory is cached across calls',
  );
});

test('incidents: publishers are merged, a failed publisher degrades to its own slice, GA is key-gated', async () => {
  let hc911Down = false;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('Smartway_Events'))
      return jsonResponse(fixture('tdot-smartway-events.json'));
    if (target.includes('HC911temp')) {
      if (hc911Down) return new Response('down', { status: 503 });
      return jsonResponse(fixture('hc911-calls.json'));
    }
    if (target.startsWith('https://511ga.org/api/v2/get/event'))
      return jsonResponse(fixture('ga511-events.json'));
    throw new Error(`unexpected fetch ${target}`);
  };
  const keyless = createIncidentsProvider({ fetchImpl, env: {} });
  const first = await keyless.read();
  const byId = Object.fromEntries(
    first.value.sources.map((source) => [source.id, source]),
  );
  assert.equal(byId.tdot.ok, true);
  assert.equal(byId.hc911.ok, true);
  assert.equal(byId.ga511.keyRequired, true);
  assert.ok(
    first.value.incidents.every((incident) => incident.agency !== 'ga511'),
  );
  assert.ok(
    first.value.incidents.some((incident) => incident.agency === 'tdot'),
  );

  const keyed = createIncidentsProvider({
    fetchImpl,
    env: { GA511_API_KEY: 'k' },
  });
  const withGa = await keyed.read();
  assert.ok(
    withGa.value.incidents.some(
      (incident) => incident.id === 'ga511:GDOT-EV-1',
    ),
  );
  assert.ok(
    !withGa.value.incidents.some(
      (incident) => incident.id === 'ga511:GDOT-EV-2',
    ),
    'I-95 event is outside the corridor',
  );

  hc911Down = true;
  const degraded = createIncidentsProvider({ fetchImpl, env: {} });
  const result = await degraded.read();
  const slices = Object.fromEntries(
    result.value.sources.map((source) => [source.id, source]),
  );
  assert.equal(slices.hc911.ok, false);
  assert.match(slices.hc911.error, /503/);
  assert.equal(slices.tdot.ok, true);
  assert.ok(
    result.value.incidents.length > 0,
    'the healthy publisher still renders',
  );
});

test('transit: MARTA is delegated to the GTFS-RT proxy; CARTA needs its key and surfaces API errors', async () => {
  let payload = fixture('carta-error.json');
  const fetchImpl = async () => jsonResponse(payload);
  const keyless = createCorridorTransitProvider({ fetchImpl, env: {} });
  const off = await keyless.read();
  assert.deepEqual(
    off.value.gtfsFeeds.map((feed) => feed.id),
    ['marta'],
  );
  assert.equal(off.value.sources[0].keyRequired, true);

  const keyed = createCorridorTransitProvider({
    fetchImpl,
    env: { CARTA_BUSTIME_KEY: 'k' },
  });
  const errored = await keyed.read();
  assert.equal(errored.value.sources[0].ok, false);
  assert.match(errored.value.sources[0].error, /No API access key/);

  payload = fixture('carta-vehicles.json');
  const fresh = createCorridorTransitProvider({
    fetchImpl,
    env: { CARTA_BUSTIME_KEY: 'k' },
  });
  const ok = await fresh.read();
  assert.deepEqual(
    ok.value.vehicles.map((vehicle) => vehicle.id),
    ['carta:101'],
  );
});

test('createCorridorProviders wires every route the handler expects', () => {
  const providers = createCorridorProviders({
    fetchImpl: async () => {
      throw new Error('offline');
    },
    env: {},
  });
  assert.deepEqual(Object.keys(providers).sort(), [
    'air',
    'alerts',
    'cameras',
    'gauges',
    'incidents',
    'transit',
  ]);
  assert.equal(typeof providers.gauges.readSeries, 'function');
  assert.equal(typeof providers.cameras.readFrame, 'function');
});
