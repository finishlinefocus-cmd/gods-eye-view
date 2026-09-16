import assert from 'node:assert/strict';
import test from 'node:test';
import {
  corridorAnalystRecords,
  corridorLegend,
  corridorRowChips,
  corridorSummary,
  hasCorridorParam,
  normalizeCorridorParams,
} from './model.js';
import { CORRIDOR_DEFAULT_PARAMS, CORRIDOR_SUBLAYER_IDS } from './constants.js';

test('params normalize to booleans over the defaults and ignore unknown keys', () => {
  const next = normalizeCorridorParams(CORRIDOR_DEFAULT_PARAMS, {
    cams: false,
    air: 'true',
    bogus: 1,
  });
  assert.equal(next.cams, false);
  assert.equal(next.air, true);
  assert.equal(next.bogus, undefined);
  assert.deepEqual(Object.keys(next).sort(), [...CORRIDOR_SUBLAYER_IDS].sort());
  assert.equal(hasCorridorParam({ transit: false }), true);
  assert.equal(hasCorridorParam({ volume: 1 }), false);
});

test('row chips: one toggle per sub-layer with count / DELAYED / OFFLINE / KEY states plus the frame action', () => {
  const params = { ...CORRIDOR_DEFAULT_PARAMS, air: false };
  const status = {
    alerts: { count: 2, delayed: false },
    incidents: { count: 5, delayed: true },
    transit: { count: 0, error: 'upstream HTTP 503' },
    cams: { count: 0, keyRequired: true, keyId: 'ga511' },
    gauges: { count: 113 },
  };
  let framed = 0;
  const chips = corridorRowChips({
    params,
    status,
    onFrame: () => framed++,
    keyGuidance: (id) => `Needs ${id.toUpperCase()}_API_KEY`,
  });
  const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip]));
  byId.frame.onClick();
  assert.equal(framed, 1);
  assert.equal(byId.alerts.label, 'WX ALERTS · 2');
  assert.equal(byId.incidents.label, 'INCIDENTS · DELAYED');
  assert.equal(byId.incidents.state, 'stale');
  assert.equal(byId.transit.label, 'TRANSIT · OFFLINE');
  assert.equal(byId.transit.state, 'degraded');
  assert.equal(byId.cams.label, 'TRAFFIC CAMS · KEY');
  assert.match(byId.cams.title, /GA511_API_KEY/);
  assert.equal(byId.air.active, false);
  assert.deepEqual(byId.air.params, { air: true });
  assert.deepEqual(byId.gauges.params, { gauges: false });
  assert.ok(
    corridorLegend(params).some((row) => row.label === 'I-75 centerline'),
  );
});

test('analyst records and the spoken summary reflect every sub-layer', () => {
  const data = {
    alerts: [
      { id: 'a1', event: 'Heat Advisory', severity: 'Moderate', expires: 'x' },
    ],
    incidents: [
      {
        id: 'i1',
        kind: 'crash',
        type: 'Incident',
        source: 'TDOT',
        lat: 35,
        lon: -85,
      },
    ],
    transit: [
      {
        id: 'marta:1',
        agency: 'marta',
        agencyName: 'MARTA',
        routeId: '119',
        lat: 33.8,
        lon: -84.3,
      },
    ],
    gauges: [
      {
        lid: 'CHAT1',
        name: 'Tennessee River',
        stage: 634,
        floodCategory: 'no_flooding',
        lat: 35.05,
        lon: -85.3,
      },
      {
        lid: 'X',
        name: 'Creek',
        stage: 12,
        floodCategory: 'minor',
        lat: 34,
        lon: -84.9,
      },
    ],
    air: [
      {
        id: 'Atlanta|GA',
        name: 'Atlanta',
        worstAqi: 64,
        worstCategory: 'Moderate',
        lat: 33.7,
        lon: -84.4,
      },
    ],
    cameras: [],
  };
  const records = corridorAnalystRecords(data);
  assert.deepEqual(
    records.map((row) => row.kind),
    ['alert', 'incident', 'transit', 'gauge', 'gauge', 'air'],
  );
  assert.equal(corridorAnalystRecords(data, 2).length, 2);
  const summary = corridorSummary(
    data,
    { cams: { keyRequired: true, count: 0 } },
    { flights: 7 },
  );
  assert.equal(summary.counts.gaugesFlooding, 1);
  assert.equal(summary.counts.flights, 7);
  assert.match(
    summary.text,
    /^Between Chattanooga and Atlanta: 1 active weather alert \(top: Heat Advisory\); 1 road incident; 1 transit vehicle live; 1 river gauge at or above action stage; air quality Moderate \(AQI 64\) at Atlanta; 7 aircraft over the corridor\.$/,
  );
  assert.deepEqual(summary.keyRequired, ['cams']);
});
