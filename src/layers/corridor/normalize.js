/**
 * @module corridor/normalize
 * @description Pure parsers that turn each upstream payload into the compact
 * records the corridor layer draws. Shared by the Vite providers (which run
 * them once per cache window) and node:test (fixtures under
 * scripts/fixtures/corridor). No Cesium, no Node built-ins, no network.
 */
import { geometryTouchesCorridor, isInsideCorridor } from './constants.js';

const finite = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
};
const text = (value, max = 400) =>
  typeof value === 'string' ? value.slice(0, max) : '';

/** NWPS/USGS sentinel values that mean "missing". */
const MISSING_VALUES = new Set([-999, -9999, -999999]);
const measured = (value) => {
  const n = finite(value);
  return n === null || MISSING_VALUES.has(n) ? null : n;
};

// ---------------------------------------------------------------------------
// NWS active alerts (api.weather.gov/alerts/active)
// ---------------------------------------------------------------------------

const RING_POINT_LIMIT = 160;

/** Keep every Nth vertex of a long ring (first and last preserved). */
export function decimateRing(ring, limit = RING_POINT_LIMIT) {
  if (!Array.isArray(ring) || ring.length <= limit) return ring;
  const step = Math.ceil(ring.length / limit);
  const out = [];
  for (let i = 0; i < ring.length - 1; i += step) out.push(ring[i]);
  out.push(ring[ring.length - 1]);
  return out;
}

/** Decimate every ring of a Polygon/MultiPolygon for a lighter wire payload. */
export function decimateGeometry(geometry, limit = RING_POINT_LIMIT) {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon')
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) =>
        decimateRing(ring, limit),
      ),
    };
  if (geometry.type === 'MultiPolygon')
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring) => decimateRing(ring, limit)),
      ),
    };
  return geometry;
}

/** UGC zone ids named by an alert, from affectedZones URLs or geocode.UGC. */
export function alertZoneIds(properties = {}) {
  const ids = new Set();
  for (const url of properties.affectedZones || []) {
    const match =
      /\/zones\/(?:forecast|county|fire|public)\/([A-Z]{2}[CZ]\d{3})$/.exec(
        String(url),
      );
    if (match) ids.add(match[1]);
  }
  for (const id of properties.geocode?.UGC || []) {
    if (/^[A-Z]{2}[CZ]\d{3}$/.test(String(id))) ids.add(String(id));
  }
  return [...ids];
}

/** Zone URL path an alert names, restricted to the NWS API's own zone routes. */
export function alertZonePath(url) {
  const match =
    /^https:\/\/api\.weather\.gov(\/zones\/(?:forecast|county|fire|public)\/[A-Z]{2}[CZ]\d{3})$/.exec(
      String(url || ''),
    );
  return match ? match[1] : null;
}

/**
 * Reduce a FeatureCollection of alerts to the ones touching the corridor.
 * Alerts without their own polygon borrow zone geometry from
 * `zoneGeometries` (UGC id → GeoJSON geometry); a zone whose geometry is
 * unknown cannot be placed and is dropped (the provider fetches zones first).
 * @param {object} payload api.weather.gov FeatureCollection.
 * @param {Map<string, object>|Record<string, object>} [zoneGeometries]
 * @returns {Array<object>} compact alert records, most severe first.
 */
export function normalizeNwsAlerts(payload, zoneGeometries = new Map()) {
  const lookup = (id) =>
    zoneGeometries instanceof Map
      ? zoneGeometries.get(id)
      : zoneGeometries?.[id];
  const out = [];
  for (const feature of payload?.features || []) {
    const p = feature?.properties || {};
    if (p.status && p.status !== 'Actual') continue;
    const zones = alertZoneIds(p);
    let geometry = feature.geometry || null;
    let geometryKind = geometry ? 'polygon' : 'zones';
    if (!geometry) {
      // Only the zones that touch the corridor are drawn: a statewide
      // advisory naming forty zones must not ship forty polygons.
      const polygons = [];
      for (const id of zones) {
        const zone = lookup(id);
        if (!zone || !geometryTouchesCorridor(zone)) continue;
        if (zone.type === 'Polygon') polygons.push(zone.coordinates);
        else if (zone.type === 'MultiPolygon')
          polygons.push(...zone.coordinates);
      }
      if (!polygons.length) continue;
      geometry = { type: 'MultiPolygon', coordinates: polygons };
    }
    if (!geometryTouchesCorridor(geometry)) continue;
    geometry = decimateGeometry(geometry);
    out.push({
      id: text(p.id || feature.id, 200),
      event: text(p.event, 80),
      severity: text(p.severity, 20) || 'Unknown',
      urgency: text(p.urgency, 20),
      certainty: text(p.certainty, 20),
      headline: text(p.headline, 300),
      areaDesc: text(p.areaDesc, 300),
      sender: text(p.senderName, 80),
      onset: text(p.onset || p.effective, 40),
      expires: text(p.ends || p.expires, 40),
      zones,
      geometryKind,
      geometry,
    });
  }
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  out.sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  return out;
}

// ---------------------------------------------------------------------------
// NOAA NWPS gauges (api.water.noaa.gov/nwps/v1/gauges)
// ---------------------------------------------------------------------------

const GAUGE_STATUS_DROP = new Set(['out_of_service']);

/** Compact gauge records inside the corridor from the NWPS bbox listing. */
export function normalizeNwpsGauges(payload) {
  const out = [];
  for (const gauge of payload?.gauges || []) {
    const lat = finite(gauge?.latitude);
    const lon = finite(gauge?.longitude);
    if (lat === null || lon === null || !isInsideCorridor(lon, lat)) continue;
    const observed = gauge.status?.observed || {};
    const category = text(observed.floodCategory, 40) || 'not_defined';
    if (GAUGE_STATUS_DROP.has(category)) continue;
    const stage = measured(observed.primary);
    const flow = measured(observed.secondary);
    if (stage === null && flow === null) continue;
    out.push({
      lid: text(gauge.lid, 10),
      usgsId: text(gauge.usgsId, 20) || null,
      name: text(gauge.name, 120),
      lat,
      lon,
      stage,
      stageUnit: text(observed.primaryUnit, 10),
      flow,
      flowUnit: text(observed.secondaryUnit, 10),
      floodCategory: category,
      observedAt: text(observed.validTime, 40),
      forecastCategory: text(gauge.status?.forecast?.floodCategory, 40),
      state: text(gauge.state?.abbreviation, 2),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Observed stage/flow points from `/gauges/{lid}/stageflow`, trimmed to the
 * trailing `windowMs` (default 24 h) and to values that were measured.
 */
export function normalizeNwpsSeries(
  payload,
  { windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {},
) {
  const observed = payload?.observed || {};
  const points = [];
  for (const row of observed.data || []) {
    const t = Date.parse(row?.validTime);
    const v = measured(row?.primary);
    if (!Number.isFinite(t) || v === null) continue;
    if (now - t > windowMs) continue;
    points.push({ t, v, flow: measured(row?.secondary) });
  }
  points.sort((a, b) => a.t - b.t);
  return {
    name: text(observed.primaryName, 60),
    unit: text(observed.primaryUnits, 10),
    flowUnit: text(observed.secondaryUnits, 10),
    points,
  };
}

// ---------------------------------------------------------------------------
// AirNow reporting areas (airnowgovapi.com/reportingarea/get_state)
// ---------------------------------------------------------------------------

const AQI_CATEGORY_RANK = {
  Good: 1,
  Moderate: 2,
  'Unhealthy for Sensitive Groups': 3,
  Unhealthy: 4,
  'Very Unhealthy': 5,
  Hazardous: 6,
};

/**
 * Group observed AirNow rows by reporting area inside the corridor. Forecast
 * rows (dataType 'F') are ignored; the worst observed AQI leads.
 */
export function normalizeAirNowAreas(rows) {
  const areas = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.dataType !== 'O') continue;
    const lat = finite(row.latitude);
    const lon = finite(row.longitude);
    const aqi = finite(row.aqi);
    if (lat === null || lon === null || aqi === null) continue;
    if (!isInsideCorridor(lon, lat)) continue;
    const name = text(row.reportingArea, 60);
    if (!name) continue;
    const key = `${name}|${row.stateCode || ''}`;
    let area = areas.get(key);
    if (!area) {
      area = {
        id: key,
        name,
        state: text(row.stateCode, 2),
        lat,
        lon,
        observedAt:
          `${text(row.validDate, 12)} ${text(row.time, 8)} ${text(row.timezone, 5)}`.trim(),
        readings: [],
        worstAqi: -1,
        worstCategory: '',
        worstParameter: '',
      };
      areas.set(key, area);
    }
    const category = text(row.category, 40);
    area.readings.push({ parameter: text(row.parameter, 12), aqi, category });
    if (aqi > area.worstAqi) {
      area.worstAqi = aqi;
      area.worstCategory = category;
      area.worstParameter = text(row.parameter, 12);
    }
  }
  return [...areas.values()].sort(
    (a, b) =>
      (AQI_CATEGORY_RANK[b.worstCategory] || 0) -
        (AQI_CATEGORY_RANK[a.worstCategory] || 0) || b.worstAqi - a.worstAqi,
  );
}

export { AQI_CATEGORY_RANK };

// ---------------------------------------------------------------------------
// Incidents: TDOT Smartway_Events (ArcGIS), Hamilton County 911, GDOT 511
// ---------------------------------------------------------------------------

const epochMs = (value) => {
  const n = finite(value);
  if (n === null) return null;
  // ArcGIS dates are epoch ms; 511GA dates are epoch seconds.
  return n < 1e11 ? n * 1000 : n;
};
const iso = (ms) => (ms === null ? '' : new Date(ms).toISOString());

/** Incident category the layer colors by. */
export function incidentKind(type = '', subtype = '', description = '') {
  const haystack = `${type} ${subtype} ${description}`.toLowerCase();
  if (/crash|accident|collision|wreck|overturn/.test(haystack)) return 'crash';
  if (/closure|closed|full closure/.test(haystack)) return 'closure';
  if (/construction|road ?work|maintenance|repair|paving/.test(haystack))
    return 'roadwork';
  if (
    /hazard|debris|disabled|stall|obstruction|fire|flood|weather/.test(haystack)
  )
    return 'hazard';
  return 'other';
}

/** TDOT Smartway_Events FeatureServer query → corridor incidents. */
export function normalizeTdotEvents(payload) {
  const out = [];
  for (const feature of payload?.features || []) {
    const a = feature?.attributes || {};
    const lon = finite(feature?.geometry?.x);
    const lat = finite(feature?.geometry?.y);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    const type = text(a.EVENT_TYPE, 40);
    const subtype = text(a.EVENT_SUBTYPE, 60);
    const description = text(a.DESCRIPTION, 400);
    out.push({
      id: `tdot:${text(a.ID, 20) || a.OBJECTID}`,
      source: 'TDOT SmartWay',
      agency: 'tdot',
      kind: incidentKind(type, subtype, description),
      type,
      subtype,
      description,
      impact: text(a.VEHICLE_IMPACT, 200),
      direction: text(a.CD_DIRECTION, 30),
      roadway: text(a.CD_ROAD_NAMES, 80),
      county: text(a.COUNTY_NAME, 40),
      closure: a.HAS_CLOSURE === 1 || a.HAS_CLOSURE === true,
      startedAt: iso(epochMs(a.START_DATE)),
      updatedAt: iso(epochMs(a.REVISED_DATE)),
      lat,
      lon,
    });
  }
  return out;
}

/** Hamilton County 911 active calls (ArcGIS "HC911temp") → corridor incidents. */
export function normalizeHc911Calls(
  payload,
  { now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000 } = {},
) {
  const out = [];
  // The layer publishes one row per responding unit, so an incident number
  // can repeat; rows arrive newest first and the first one wins.
  const seen = new Set();
  for (const feature of payload?.features || []) {
    const a = feature?.attributes || {};
    const key = text(a.Master_Incident_Number, 30) || String(a.OBJECTID ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    const lat = finite(a.Latitude ?? feature?.geometry?.y);
    const lon = finite(a.Longitude ?? feature?.geometry?.x);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    const at = epochMs(a.Response_Date);
    if (at !== null && now - at > maxAgeMs) continue;
    const problem = text(a.Problem, 80);
    out.push({
      id: `hc911:${text(a.Master_Incident_Number, 30) || a.OBJECTID}`,
      source: 'Hamilton County 911',
      agency: 'hc911',
      kind: incidentKind('', '', problem),
      type: '911 call',
      subtype: problem,
      description: [problem, text(a.Address, 120)].filter(Boolean).join(' — '),
      impact: '',
      direction: '',
      roadway: text(a.Address, 120),
      county: 'Hamilton',
      closure: false,
      startedAt: iso(at),
      updatedAt: iso(at),
      lat,
      lon,
    });
  }
  return out;
}

/** Georgia 511 `get/event` (keyed) → corridor incidents. */
export function normalizeGa511Events(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const lat = finite(row?.Latitude);
    const lon = finite(row?.Longitude);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    const type = text(row.EventType, 40);
    const description = text(row.Description, 400);
    out.push({
      id: `ga511:${text(row.ID, 40)}`,
      source: 'Georgia 511',
      agency: 'ga511',
      kind:
        row.IsFullClosure === true
          ? 'closure'
          : incidentKind(type, '', description),
      type,
      subtype: text(row.Severity, 20),
      description,
      impact: text(row.LanesAffected, 200),
      direction: text(row.DirectionOfTravel, 30),
      roadway: text(row.RoadwayName, 80),
      county: '',
      closure: row.IsFullClosure === true,
      startedAt: iso(epochMs(row.StartDate ?? row.Reported)),
      updatedAt: iso(epochMs(row.LastUpdated)),
      lat,
      lon,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Traffic cameras: Georgia 511 (keyed list, keyless snapshots) and TDOT (keyed)
// ---------------------------------------------------------------------------

/** Snapshot hosts a camera view URL may point at. Anything else is dropped. */
export const CAMERA_SNAPSHOT_URL_PATTERNS = Object.freeze([
  /^https:\/\/511ga\.org\/map\/Cctv\/\d{1,7}$/,
  /^https:\/\/[a-z0-9.-]+\.tn\.gov\/[^\s?#]*\.(?:jpe?g|png|gif)(?:\?[^\s#]*)?$/i,
  /^https:\/\/[a-z0-9.-]+\.tn\.gov\/[^\s?#]*(?:snapshot|image|still)[^\s#]*$/i,
]);

export function isAllowedCameraSnapshotUrl(url) {
  const value = String(url || '');
  return CAMERA_SNAPSHOT_URL_PATTERNS.some((pattern) => pattern.test(value));
}

/** Georgia 511 `get/cameras` (keyed) → corridor cameras with allowlisted views. */
export function normalizeGa511Cameras(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const lat = finite(row?.Latitude);
    const lon = finite(row?.Longitude);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    const views = [];
    for (const view of row.Views || []) {
      if (!isAllowedCameraSnapshotUrl(view?.Url)) continue;
      if (view.Status && String(view.Status).toLowerCase() !== 'enabled')
        continue;
      views.push({
        id: `ga511:${finite(view.Id) ?? text(view.Id, 12)}`,
        url: String(view.Url),
        label: text(view.Description, 60),
      });
    }
    if (!views.length) continue;
    out.push({
      id: `ga511:${finite(row.Id) ?? text(row.SourceId, 30)}`,
      source: 'Georgia 511',
      agency: 'ga511',
      name: text(row.Name || row.Location, 100),
      roadway: text(row.Roadway, 40),
      direction: text(row.Direction, 20),
      lat,
      lon,
      views,
    });
  }
  return out;
}

/**
 * TDOT OpenData `RoadwayCameras` (keyed) → corridor cameras. The keyed
 * response shape is not publicly documented, so the field names are read
 * tolerantly; a row with no usable snapshot URL is dropped.
 */
export function normalizeTdotCameras(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const lat = finite(row?.latitude ?? row?.Latitude ?? row?.lat);
    const lon = finite(row?.longitude ?? row?.Longitude ?? row?.lon);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    const url =
      row.snapshotUrl ??
      row.SnapshotUrl ??
      row.imageUrl ??
      row.ImageUrl ??
      row.ImageURL ??
      row.url ??
      row.Url;
    if (!isAllowedCameraSnapshotUrl(url)) continue;
    const id = text(
      String(row.id ?? row.Id ?? row.cameraId ?? row.CameraId ?? ''),
      30,
    );
    if (!id) continue;
    out.push({
      id: `tdot:${id}`,
      source: 'TDOT SmartWay',
      agency: 'tdot',
      name: text(
        row.name ??
          row.Name ??
          row.title ??
          row.Title ??
          row.description ??
          row.Description,
        100,
      ),
      roadway: text(row.roadway ?? row.Roadway ?? row.route ?? row.Route, 40),
      direction: text(row.direction ?? row.Direction, 20),
      lat,
      lon,
      views: [{ id: `tdot:${id}`, url: String(url), label: '' }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transit: CARTA BusTime v3 (keyed). MARTA rides the GTFS-RT transit proxy.
// ---------------------------------------------------------------------------

/** BusTime `getvehicles` JSON → corridor vehicles, or throws on an API error. */
export function normalizeCartaVehicles(payload) {
  const body = payload?.['bustime-response'] || {};
  if (
    Array.isArray(body.error) &&
    body.error.length &&
    !Array.isArray(body.vehicle)
  ) {
    throw new Error(
      `CARTA BusTime: ${text(body.error[0]?.msg, 120) || 'error'}`,
    );
  }
  const out = [];
  for (const row of body.vehicle || []) {
    const lat = finite(row?.lat);
    const lon = finite(row?.lon);
    if (lon === null || lat === null || !isInsideCorridor(lon, lat)) continue;
    out.push({
      id: `carta:${text(String(row.vid ?? ''), 20)}`,
      agency: 'carta',
      agencyName: 'CARTA',
      routeId: text(String(row.rt ?? ''), 20),
      destination: text(row.des, 60),
      heading: finite(row.hdg),
      speedMph: finite(row.spd),
      delayed: row.dly === true,
      timestamp: text(row.tmstmp, 20),
      lat,
      lon,
    });
  }
  return out;
}
