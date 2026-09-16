import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  alertZoneIds,
  normalizeGa511Events,
  normalizeHc911Calls,
  normalizeTdotEvents,
  alertZonePath,
  decimateRing,
  normalizeAirNowAreas,
  normalizeNwpsGauges,
  normalizeNwpsSeries,
  normalizeNwsAlerts,
} from './normalize.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../scripts/fixtures/corridor/${name}`, import.meta.url),
      'utf8',
    ),
  );

test('NWS alerts: polygon warnings and corridor zones survive, coast and exercises do not', () => {
  const zones = new Map(Object.entries(fixture('nws-zones.json')));
  const alerts = normalizeNwsAlerts(fixture('nws-alerts.json'), zones);
  assert.deepEqual(
    alerts.map((alert) => alert.event),
    ['Severe Thunderstorm Warning', 'Heat Advisory'],
  );
  const [warning, advisory] = alerts;
  assert.equal(warning.geometryKind, 'polygon');
  assert.equal(warning.severity, 'Severe');
  assert.equal(warning.expires, '2026-09-15T21:45:00-04:00');
  assert.equal(advisory.geometryKind, 'zones');
  assert.equal(advisory.geometry.type, 'MultiPolygon');
  assert.equal(advisory.geometry.coordinates.length, 2);
  assert.deepEqual(advisory.zones, ['TNZ097', 'GAZ021']);
});

test('NWS alerts: a zone alert with no known geometry is dropped rather than misplaced', () => {
  const alerts = normalizeNwsAlerts(fixture('nws-alerts.json'), new Map());
  assert.deepEqual(
    alerts.map((alert) => alert.event),
    ['Severe Thunderstorm Warning'],
  );
});

test('alert zone helpers only accept NWS zone routes', () => {
  assert.equal(
    alertZonePath('https://api.weather.gov/zones/forecast/TNZ097'),
    '/zones/forecast/TNZ097',
  );
  assert.equal(
    alertZonePath('https://api.weather.gov/zones/county/GAC313'),
    '/zones/county/GAC313',
  );
  assert.equal(
    alertZonePath('https://evil.example/zones/forecast/TNZ097'),
    null,
  );
  assert.equal(alertZonePath('https://api.weather.gov/alerts/active'), null);
  assert.deepEqual(
    alertZoneIds({
      affectedZones: ['https://api.weather.gov/zones/forecast/TNZ097'],
      geocode: { UGC: ['TNZ097', 'GAZ021', 'bogus'] },
    }),
    ['TNZ097', 'GAZ021'],
  );
});

test('decimateRing keeps endpoints and bounds the vertex count', () => {
  const ring = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const out = decimateRing(ring, 100);
  assert.ok(out.length <= 101);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out.at(-1), [999, 999]);
  assert.equal(decimateRing(ring.slice(0, 5), 100).length, 5);
});

test('NWPS gauges: corridor filter, sentinel and out-of-service handling', () => {
  const gauges = normalizeNwpsGauges(fixture('nwps-gauges.json'));
  const lids = gauges.map((gauge) => gauge.lid);
  assert.ok(lids.includes('CHAT1'));
  assert.ok(lids.includes('VING1'));
  assert.ok(!lids.includes('ZZZZ9'), 'outside the corridor');
  const chat = gauges.find((gauge) => gauge.lid === 'CHAT1');
  assert.equal(chat.usgsId, null, 'the bbox listing carries no USGS id');
  assert.equal(chat.stageUnit, 'ft');
  assert.ok(chat.stage > 600 && chat.stage < 700);
  assert.equal(chat.floodCategory, 'no_flooding');
  assert.ok(gauges.every((gauge) => gauge.floodCategory !== 'out_of_service'));
});

test('NWPS series: trailing 24 h window, sentinels dropped, ascending time', () => {
  const payload = fixture('nwps-stageflow-chat1.json');
  const last = Date.parse(payload.observed.data.at(-2).validTime);
  const series = normalizeNwpsSeries(payload, { now: last });
  assert.equal(series.unit, 'ft');
  assert.ok(series.points.length >= 20 && series.points.length <= 25);
  assert.ok(series.points.every((p, i, all) => i === 0 || all[i - 1].t <= p.t));
  assert.ok(series.points.every((p) => p.v > 0));
  assert.equal(normalizeNwpsSeries({}).points.length, 0);
});

test('HC911 calls: one record per incident number, inside the corridor, recent only', () => {
  const payload = fixture('hc911-calls.json');
  const newest = payload.features[0].attributes.Response_Date;
  const calls = normalizeHc911Calls(payload, { now: newest });
  const ids = calls.map((call) => call.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'duplicate incident numbers collapse',
  );
  assert.ok(!ids.includes('hc911:2026-09-99999'), 'outside the corridor');
  assert.ok(
    calls.every(
      (call) => call.agency === 'hc911' && call.county === 'Hamilton',
    ),
  );
  assert.equal(
    normalizeHc911Calls(payload, { now: newest + 7 * 60 * 60 * 1000 }).length,
    0,
    'stale calls age out',
  );
});

test('TDOT events and Georgia 511 events normalize into the shared incident shape', () => {
  const tdot = normalizeTdotEvents(fixture('tdot-smartway-events.json'));
  assert.ok(tdot.length >= 2);
  assert.ok(
    !tdot.some((event) => event.id === 'tdot:9990001'),
    'Knox County crash is outside the corridor',
  );
  assert.ok(
    tdot.every(
      (event) => event.agency === 'tdot' && typeof event.lat === 'number',
    ),
  );
  const ga = normalizeGa511Events(fixture('ga511-events.json'));
  assert.deepEqual(
    ga.map((event) => [event.id, event.kind, event.subtype]),
    [['ga511:GDOT-EV-1', 'crash', 'Major']],
  );
  assert.equal(
    ga[0].startedAt,
    new Date(1789505000 * 1000).toISOString(),
    '511GA epoch seconds are normalised',
  );
});

test('AirNow areas: observed rows grouped per corridor reporting area, worst AQI first', () => {
  const areas = normalizeAirNowAreas(fixture('airnow-areas.json'));
  assert.deepEqual(
    areas.map((area) => area.name),
    ['Atlanta', 'Chattanooga'],
  );
  const chattanooga = areas[1];
  assert.equal(chattanooga.worstAqi, 58);
  assert.equal(chattanooga.worstParameter, 'PM2.5');
  assert.equal(chattanooga.readings.length, 2, 'forecast rows ignored');
  assert.equal(normalizeAirNowAreas(null).length, 0);
});
