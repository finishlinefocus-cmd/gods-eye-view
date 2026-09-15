import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atcFeedsOfKind,
  chooseAtcFeed,
  defaultAtcKind,
  findAtcAirport,
  findAtcFeed,
  greatCircleNm,
  isKnownAtcMount,
  isPlausibleAtcMount,
  nearestAtcAirport,
  nearestAtcSelection,
  normalizeIcao,
  resolveAtcAirportQuery,
} from './directory.js';
import { classifyFeedKind, normalizeFeedKind } from './feedKinds.js';
import { LIVEATC_AIRPORTS } from './liveatcFeeds.js';

const feed = (mount, label, kind, online = true) => ({
  mount,
  label,
  kind,
  online,
  pageStatus: online ? 'UP' : 'DOWN',
  frequencies: [],
});

const FIXTURE = Object.freeze([
  {
    icao: 'KSFO',
    name: 'San Francisco International',
    lat: 37.6213,
    lon: -122.379,
    elevationFt: 13,
    feeds: [
      feed('ksfo_gnd', 'KSFO Ground', 'ground'),
      feed('ksfo_twr', 'KSFO Tower', 'tower'),
      feed('ksfo_app2', 'KSFO NORCAL App', 'approach'),
      feed('zoa_35', 'ZOA Oakland Center (35)', 'center'),
    ],
  },
  {
    icao: 'KOAK',
    name: 'Oakland International',
    lat: 37.7126,
    lon: -122.2197,
    elevationFt: 9,
    feeds: [
      feed('koak_twr_old', 'KOAK Tower (old)', 'tower', false),
      feed('koak_twr', 'KOAK Tower', 'tower'),
      feed('koak_dep', 'NORCAL Departure', 'departure'),
    ],
  },
  {
    icao: 'KDEN',
    name: 'Denver International',
    lat: 39.8561,
    lon: -104.6737,
    elevationFt: 5434,
    feeds: [
      feed('kden_twr', 'KDEN Tower', 'tower'),
      feed('kden_gnd', 'KDEN Ground', 'ground'),
    ],
  },
]);

const SAN_DIEGO = {
  icao: 'KSAN',
  name: 'San Diego International',
  lat: 32.7338,
  lon: -117.1933,
  elevationFt: 17,
  feeds: [feed('ksan1_twr', 'KSAN Tower #1', 'tower')],
};

test('feed kinds classify by label first, then mount, leftmost position wins', () => {
  assert.equal(classifyFeedKind('KSFO Tower', 'ksfo_twr'), 'tower');
  assert.equal(
    classifyFeedKind('KSFO Del/Gnd (Alt)/Twr (Alt)', 'ksfo_gnd2'),
    'clearance',
  );
  assert.equal(classifyFeedKind('KSFO Ground/Tower', 'ksfo_gnd_twr'), 'ground');
  assert.equal(
    classifyFeedKind('KSFO NORCAL App 28L/R', 'ksfo_app2'),
    'approach',
  );
  assert.equal(
    classifyFeedKind('KSFO Dep 120.9/127.0', 'ksfo_dep1'),
    'departure',
  );
  assert.equal(classifyFeedKind('ZOA Oakland Center (35)', 'zoa_35'), 'center');
  assert.equal(classifyFeedKind('KSFO D-ATIS', 'ksfo_atis'), 'other');
  assert.equal(classifyFeedKind('', 'zny_ctr'), 'center');
  assert.equal(classifyFeedKind('', 'kjfk_del'), 'clearance');
  assert.equal(normalizeFeedKind('Tower'), 'tower');
  assert.equal(normalizeFeedKind('TRACON'), 'approach');
  assert.equal(normalizeFeedKind('garbage'), null);
  assert.equal(normalizeFeedKind(undefined), null);
});

test('airport lookup accepts ICAO, IATA and free text', () => {
  assert.equal(normalizeIcao(' sfo '), 'KSFO');
  assert.equal(normalizeIcao('KSFO'), 'KSFO');
  assert.equal(normalizeIcao('San Francisco'), '');
  assert.equal(findAtcAirport('sfo', FIXTURE).icao, 'KSFO');
  assert.equal(findAtcAirport('KZZZ', FIXTURE), null);
  assert.equal(
    resolveAtcAirportQuery('San Francisco tower', FIXTURE).icao,
    'KSFO',
  );
  const withSanDiego = [...FIXTURE, SAN_DIEGO];
  assert.equal(
    resolveAtcAirportQuery('San Francisco', withSanDiego).icao,
    'KSFO',
  );
  assert.equal(resolveAtcAirportQuery('san', withSanDiego).icao, 'KSAN');
  assert.equal(
    resolveAtcAirportQuery('play ksfo ground', FIXTURE).icao,
    'KSFO',
  );
  assert.equal(resolveAtcAirportQuery('Oakland', FIXTURE).icao, 'KOAK');
  assert.equal(resolveAtcAirportQuery('denver approach', FIXTURE).icao, 'KDEN');
  assert.equal(resolveAtcAirportQuery('KDEN', FIXTURE).icao, 'KDEN');
  assert.equal(resolveAtcAirportQuery('tower', FIXTURE), null);
  assert.equal(resolveAtcAirportQuery('', FIXTURE), null);
});

test('mount validation rejects anything outside the directory', () => {
  assert.ok(isPlausibleAtcMount('ksfo_twr'));
  assert.ok(!isPlausibleAtcMount('../etc'));
  assert.ok(!isPlausibleAtcMount('KSFO_TWR'));
  assert.ok(!isPlausibleAtcMount(''));
  assert.ok(!isPlausibleAtcMount(null));
  assert.ok(isKnownAtcMount('ksfo_twr', FIXTURE));
  assert.ok(
    isKnownAtcMount('koak_twr_old', FIXTURE),
    'offline feeds stay addressable',
  );
  assert.ok(!isKnownAtcMount('ksfo_twr?x=1', FIXTURE));
  assert.ok(!isKnownAtcMount('kzzz_twr', FIXTURE));
  assert.deepEqual(findAtcFeed('zoa_35', FIXTURE).airport.icao, 'KSFO');
  assert.equal(findAtcFeed('zoa_35', FIXTURE).feed.kind, 'center');
});

test('nearest airport uses great-circle distance', () => {
  assert.ok(
    Math.abs(greatCircleNm(37.6213, -122.379, 37.7126, -122.2197) - 9.35) < 0.1,
  );
  const nearOakland = nearestAtcAirport(37.75, -122.2, FIXTURE);
  assert.equal(nearOakland.airport.icao, 'KOAK');
  assert.ok(nearOakland.distanceNm < 3);
  const nearDenver = nearestAtcAirport(39.5, -105, FIXTURE);
  assert.equal(nearDenver.airport.icao, 'KDEN');
  assert.equal(nearestAtcAirport(NaN, 0, FIXTURE), null);
  assert.equal(nearestAtcAirport(0, 0, []), null);
});

test('kind defaulting: tower when low and close, approach in terminal range, center beyond', () => {
  const sfo = FIXTURE[0];
  assert.equal(
    defaultAtcKind({ distanceNm: 3, altitudeFt: 1500, airport: sfo }),
    'tower',
  );
  assert.equal(
    defaultAtcKind({ distanceNm: 3, altitudeFt: 9000, airport: sfo }),
    'approach',
  );
  assert.equal(
    defaultAtcKind({ distanceNm: 25, altitudeFt: 1500, airport: sfo }),
    'approach',
  );
  assert.equal(
    defaultAtcKind({ distanceNm: 90, altitudeFt: 35000, airport: sfo }),
    'center',
  );
  assert.equal(
    defaultAtcKind({ distanceNm: 90, altitudeFt: 35000, airport: FIXTURE[2] }),
    'approach',
  );
  assert.equal(defaultAtcKind({}), 'approach');
});

test('feed choice honours the requested kind, prefers online, and falls back sensibly', () => {
  const oak = FIXTURE[1];
  assert.equal(
    chooseAtcFeed(oak, 'tower').mount,
    'koak_twr',
    'online tower before offline one',
  );
  assert.deepEqual(
    atcFeedsOfKind(oak, 'tower').map((entry) => entry.mount),
    ['koak_twr', 'koak_twr_old'],
  );
  assert.equal(
    chooseAtcFeed(oak, 'approach').mount,
    'koak_dep',
    'approach falls back to departure',
  );
  assert.equal(chooseAtcFeed(oak, 'center').mount, 'koak_dep');
  assert.equal(chooseAtcFeed(FIXTURE[2], 'center').mount, 'kden_twr');
  assert.equal(chooseAtcFeed(FIXTURE[0], 'bogus').mount, 'ksfo_twr');
  assert.equal(chooseAtcFeed({ icao: 'X', feeds: [] }, 'tower'), null);
});

test('nearest selection for a tracked aircraft is one click from the right feed', () => {
  const onFinal = nearestAtcSelection(
    { lat: 37.65, lon: -122.35, altitudeM: 600 },
    FIXTURE,
  );
  assert.equal(onFinal.airport.icao, 'KSFO');
  assert.equal(onFinal.kind, 'tower');
  assert.equal(onFinal.feed.mount, 'ksfo_twr');

  const descending = nearestAtcSelection(
    { lat: 37.2, lon: -122.0, altitudeM: 3000 },
    FIXTURE,
  );
  assert.equal(descending.airport.icao, 'KSFO');
  assert.equal(descending.kind, 'approach');
  assert.equal(descending.feed.mount, 'ksfo_app2');

  const cruising = nearestAtcSelection(
    { lat: 36.0, lon: -121.0, altitudeM: 11000 },
    FIXTURE,
  );
  assert.equal(cruising.kind, 'center');
  assert.equal(cruising.feed.mount, 'zoa_35');

  // Denver sits at 5,434 ft MSL: 6,500 ft MSL on short final is still tower altitude.
  const denverFinal = nearestAtcSelection(
    { lat: 39.9, lon: -104.7, altitudeM: 1981 },
    FIXTURE,
  );
  assert.equal(denverFinal.kind, 'tower');
  assert.equal(denverFinal.feed.mount, 'kden_twr');

  assert.equal(nearestAtcSelection({ lat: 37.65, lon: -122.35 }, []), null);
  assert.equal(nearestAtcSelection(null, FIXTURE), null);
});

test('committed directory is well formed', () => {
  assert.ok(Array.isArray(LIVEATC_AIRPORTS));
  const seen = new Set();
  for (const airport of LIVEATC_AIRPORTS) {
    assert.match(airport.icao, /^K[A-Z]{3}$/);
    assert.ok(!seen.has(airport.icao), `duplicate ${airport.icao}`);
    seen.add(airport.icao);
    assert.ok(Number.isFinite(airport.lat) && Number.isFinite(airport.lon));
    assert.ok(Number.isFinite(airport.elevationFt));
    assert.ok(Array.isArray(airport.feeds));
    for (const entry of airport.feeds) {
      assert.ok(
        isPlausibleAtcMount(entry.mount),
        `${airport.icao} mount ${entry.mount}`,
      );
      assert.equal(typeof entry.label, 'string');
      assert.equal(typeof entry.online, 'boolean');
      assert.equal(normalizeFeedKind(entry.kind) || 'other', entry.kind);
    }
  }
});
