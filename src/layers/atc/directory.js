import { LIVEATC_AIRPORTS } from './liveatcFeeds.js';
import { normalizeFeedKind } from './feedKinds.js';

/**
 * Read-side helpers over the committed LiveATC feed directory: lookups by
 * ICAO / mount / free text, great-circle nearest airport, and the "which feed
 * should play" defaulting rule shared by the panel, the tracking HUD and the
 * voice tool. Portable (no DOM, no Node) so the server proxy can reuse the
 * mount allowlist.
 */

const MOUNT_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const EARTH_RADIUS_NM = 3440.065;
const FEET_PER_METRE = 3.28084;

/** Tower is the default within this many nautical miles when low. */
export const ATC_TOWER_RANGE_NM = 10;
/** Below this altitude (feet above the airport) the aircraft is in tower airspace. */
export const ATC_TOWER_CEILING_FT = 3000;
/** Approach / departure control covers roughly this radius. */
export const ATC_TERMINAL_RANGE_NM = 40;

function buildIndexes(airports) {
  const byIcao = new Map();
  const byMount = new Map();
  for (const airport of airports) {
    byIcao.set(airport.icao, airport);
    for (const feed of airport.feeds || []) {
      if (!byMount.has(feed.mount)) byMount.set(feed.mount, { airport, feed });
    }
  }
  return { byIcao, byMount };
}

const INDEX = buildIndexes(LIVEATC_AIRPORTS);

/** Every airport in the directory, in curated order. */
export function listAtcAirports(airports = LIVEATC_AIRPORTS) {
  return airports;
}

/** Normalize an ICAO code: trims, uppercases, and accepts the bare IATA form ("SFO" → "KSFO"). */
export function normalizeIcao(value) {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{4}$/.test(text)) return text;
  if (/^[A-Z]{3}$/.test(text)) return `K${text}`;
  return '';
}

/** Find an airport by ICAO (or IATA) code. */
export function findAtcAirport(icao, airports = LIVEATC_AIRPORTS) {
  const code = normalizeIcao(icao);
  if (!code) return null;
  if (airports === LIVEATC_AIRPORTS) return INDEX.byIcao.get(code) || null;
  return airports.find((airport) => airport.icao === code) || null;
}

/** Whether a string is a syntactically plausible LiveATC mount name. */
export function isPlausibleAtcMount(value) {
  return typeof value === 'string' && MOUNT_PATTERN.test(value);
}

/** Find the directory entry for a mount; null when the mount is not curated. */
export function findAtcFeed(mount, airports = LIVEATC_AIRPORTS) {
  if (!isPlausibleAtcMount(mount)) return null;
  if (airports === LIVEATC_AIRPORTS) return INDEX.byMount.get(mount) || null;
  for (const airport of airports) {
    const feed = (airport.feeds || []).find((entry) => entry.mount === mount);
    if (feed) return { airport, feed };
  }
  return null;
}

/** Whether a mount is in the curated directory (the proxy's allowlist). */
export function isKnownAtcMount(mount, airports = LIVEATC_AIRPORTS) {
  return findAtcFeed(mount, airports) !== null;
}

/**
 * Resolve free text ("San Francisco", "SFO", "ksfo", "JFK tower") to an airport.
 * Codes win; otherwise the airport whose name shares the most query words.
 */
export function resolveAtcAirportQuery(query, airports = LIVEATC_AIRPORTS) {
  const text = String(query || '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  // A bare code wins outright ("sfo", "KSFO"); inside a longer phrase only a
  // four-letter ICAO counts, so the "San" of "San Francisco" cannot become KSAN.
  const whole = findAtcAirport(text, airports);
  if (whole) return whole;
  for (const token of tokens) {
    if (token.length !== 4) continue;
    const byCode = findAtcAirport(token, airports);
    if (byCode) return byCode;
  }
  const stop = new Set([
    'tower',
    'ground',
    'approach',
    'departure',
    'center',
    'clearance',
    'delivery',
    'atc',
    'radio',
    'airport',
    'international',
    'the',
    'at',
  ]);
  const wanted = tokens.filter((token) => !stop.has(token));
  if (!wanted.length) return null;
  let best = null;
  let bestScore = 0;
  for (const airport of airports) {
    const haystack = `${airport.name} ${airport.icao}`.toLowerCase();
    let score = 0;
    for (const token of wanted)
      if (haystack.includes(token)) score += token.length;
    if (score > bestScore) {
      best = airport;
      bestScore = score;
    }
  }
  return best;
}

/** Great-circle distance in nautical miles. */
export function greatCircleNm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest directory airport to a position, with its distance in nautical miles. */
export function nearestAtcAirport(lat, lon, airports = LIVEATC_AIRPORTS) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const airport of airports) {
    const distanceNm = greatCircleNm(lat, lon, airport.lat, airport.lon);
    if (!best || distanceNm < best.distanceNm) best = { airport, distanceNm };
  }
  return best;
}

/** Feeds of one kind, online first, then directory order. */
export function atcFeedsOfKind(airport, kind) {
  const wanted = normalizeFeedKind(kind);
  const feeds = (airport?.feeds || []).filter((feed) => feed.kind === wanted);
  return feeds.slice().sort((a, b) => Number(b.online) - Number(a.online));
}

/**
 * Which kind to default to for an aircraft relative to an airport:
 * tower when low and close, approach/departure inside terminal range, else center.
 */
export function defaultAtcKind({ distanceNm, altitudeFt, airport } = {}) {
  const distance = Number.isFinite(distanceNm) ? distanceNm : Infinity;
  const altitude = Number.isFinite(altitudeFt) ? altitudeFt : Infinity;
  if (distance <= ATC_TOWER_RANGE_NM && altitude <= ATC_TOWER_CEILING_FT)
    return 'tower';
  if (distance <= ATC_TERMINAL_RANGE_NM) return 'approach';
  if (airport && atcFeedsOfKind(airport, 'center').length) return 'center';
  return 'approach';
}

const FALLBACK_ORDER = Object.freeze({
  tower: [
    'tower',
    'ground',
    'approach',
    'departure',
    'center',
    'clearance',
    'other',
  ],
  ground: [
    'ground',
    'tower',
    'clearance',
    'approach',
    'departure',
    'center',
    'other',
  ],
  clearance: [
    'clearance',
    'ground',
    'tower',
    'approach',
    'departure',
    'center',
    'other',
  ],
  approach: [
    'approach',
    'departure',
    'tower',
    'center',
    'ground',
    'clearance',
    'other',
  ],
  departure: [
    'departure',
    'approach',
    'tower',
    'center',
    'ground',
    'clearance',
    'other',
  ],
  center: [
    'center',
    'approach',
    'departure',
    'tower',
    'ground',
    'clearance',
    'other',
  ],
  other: [
    'other',
    'tower',
    'ground',
    'approach',
    'departure',
    'center',
    'clearance',
  ],
});

/**
 * Pick the feed to play at an airport: the requested kind when it has one
 * (online preferred), otherwise the closest substitute position.
 */
export function chooseAtcFeed(airport, kind = 'tower') {
  const wanted = normalizeFeedKind(kind) || 'tower';
  for (const candidate of FALLBACK_ORDER[wanted] || FALLBACK_ORDER.tower) {
    const feeds = atcFeedsOfKind(airport, candidate);
    if (feeds.length) return feeds[0];
  }
  return null;
}

/**
 * The one-click answer for a tracked aircraft: nearest airport, the kind its
 * geometry implies, and the feed to start.
 * @param {{lat:number, lon:number, altitudeM?:number}} position
 */
export function nearestAtcSelection(position, airports = LIVEATC_AIRPORTS) {
  const nearest = nearestAtcAirport(position?.lat, position?.lon, airports);
  if (!nearest) return null;
  // ADS-B altitude is MSL; subtract the field elevation so a jet on final at
  // Denver (5,400 ft MSL) still reads as low.
  const altitudeFt = Number.isFinite(position?.altitudeM)
    ? position.altitudeM * FEET_PER_METRE - (nearest.airport.elevationFt || 0)
    : undefined;
  const kind = defaultAtcKind({
    distanceNm: nearest.distanceNm,
    altitudeFt,
    airport: nearest.airport,
  });
  return {
    airport: nearest.airport,
    distanceNm: nearest.distanceNm,
    kind,
    feed: chooseAtcFeed(nearest.airport, kind),
  };
}
