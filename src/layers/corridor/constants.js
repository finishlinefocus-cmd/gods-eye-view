/**
 * @module corridor/constants
 * @description The ONE place the Chattanooga ↔ Atlanta corridor is defined.
 *
 * Every corridor provider clips its upstream payload to CORRIDOR_POLYGON, the
 * browser draws the same outline, and the view preset frames CORRIDOR_BBOX —
 * so widening the corridor is a one-file change. Pure data + pure helpers:
 * imported by the browser layer, the Vite providers, and node:test.
 */

export const CORRIDOR_LAYER_ID = 'corridor';
export const CORRIDOR_LAYER_NAME = 'Corridor: CHA ↔ ATL';

/** Anchor airfields (WGS-84). */
export const CORRIDOR_ANCHORS = Object.freeze({
  KCHA: Object.freeze({
    icao: 'KCHA',
    name: 'Chattanooga',
    lat: 35.0353,
    lon: -85.2038,
  }),
  KATL: Object.freeze({
    icao: 'KATL',
    name: 'Atlanta',
    lat: 33.6407,
    lon: -84.4277,
  }),
});

/** Waypoint towns along I-75, north → south; used for labels and summaries. */
export const CORRIDOR_WAYPOINTS = Object.freeze([
  Object.freeze({ name: 'Chattanooga', lat: 35.0456, lon: -85.3097 }),
  Object.freeze({ name: 'Dalton', lat: 34.7698, lon: -84.9702 }),
  Object.freeze({ name: 'Calhoun', lat: 34.5026, lon: -84.9511 }),
  Object.freeze({ name: 'Cartersville', lat: 34.1651, lon: -84.8 }),
  Object.freeze({ name: 'Marietta', lat: 33.9526, lon: -84.5499 }),
  Object.freeze({ name: 'Atlanta', lat: 33.749, lon: -84.388 }),
]);

/**
 * Loose bounding box (west, south, east, north) in degrees. Upstream bbox
 * queries use this; the polygon below then trims the corners.
 */
export const CORRIDOR_BBOX = Object.freeze({
  west: -85.6,
  south: 33.4,
  east: -84.1,
  north: 35.3,
});

/**
 * Corridor footprint as a closed ring of [lon, lat] — a ~35 km band around
 * I-75 that swells over both metro areas. Counter-clockwise, first == last.
 */
export const CORRIDOR_POLYGON = Object.freeze([
  [-85.6, 34.85], // west of Chattanooga / Nickajack
  [-85.4, 34.55], // Lafayette GA
  [-85.15, 34.25], // Rome-side edge
  [-84.95, 33.85], // Dallas GA
  [-84.9, 33.4], // SW metro Atlanta
  [-84.1, 33.4], // SE metro Atlanta
  [-84.1, 33.95], // Lawrenceville
  [-84.35, 34.3], // Canton
  [-84.5, 34.65], // Ellijay-side edge
  [-84.65, 35.05], // Cleveland TN
  [-84.9, 35.3], // north of Chattanooga
  [-85.5, 35.3], // Signal Mountain / Jasper
  [-85.6, 34.85],
]);

/** Camera framing for the "Corridor" view preset. */
export const CORRIDOR_VIEW = Object.freeze({
  center: Object.freeze({ lat: 34.35, lon: -84.87 }),
  rectangle: Object.freeze({
    west: -85.5,
    south: 33.55,
    east: -84.2,
    north: 35.2,
  }),
  heading: 0,
  pitch: -75,
  heightM: 300000,
});

/** Sub-layer switches the corridor group exposes, in panel order. */
export const CORRIDOR_SUBLAYERS = Object.freeze([
  Object.freeze({
    id: 'cams',
    label: 'TRAFFIC CAMS',
    title: 'TDOT SmartWay / GDOT 511 traffic cameras',
  }),
  Object.freeze({
    id: 'incidents',
    label: 'INCIDENTS',
    title: 'Road incidents and closures',
  }),
  Object.freeze({
    id: 'transit',
    label: 'TRANSIT',
    title: 'CARTA and MARTA live vehicles',
  }),
  Object.freeze({
    id: 'alerts',
    label: 'WX ALERTS',
    title: 'NWS active alerts',
  }),
  Object.freeze({
    id: 'gauges',
    label: 'RIVER GAUGES',
    title: 'NOAA / USGS river gauges',
  }),
  Object.freeze({
    id: 'air',
    label: 'AIR QUALITY',
    title: 'AirNow reporting areas',
  }),
]);

export const CORRIDOR_SUBLAYER_IDS = Object.freeze(
  CORRIDOR_SUBLAYERS.map((entry) => entry.id),
);

/** Default sub-layer state: everything keyless on, keyed sources off. */
export const CORRIDOR_DEFAULT_PARAMS = Object.freeze({
  cams: true,
  incidents: true,
  transit: true,
  alerts: true,
  gauges: true,
  air: true,
});

/** Whether a lon/lat pair falls inside the loose bbox. */
export function corridorBboxContains(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= CORRIDOR_BBOX.west &&
    lon <= CORRIDOR_BBOX.east &&
    lat >= CORRIDOR_BBOX.south &&
    lat <= CORRIDOR_BBOX.north
  );
}

/**
 * Ray-casting point-in-polygon against the corridor footprint.
 * @param {number} lon
 * @param {number} lat
 * @param {ReadonlyArray<ReadonlyArray<number>>} [ring=CORRIDOR_POLYGON]
 * @returns {boolean}
 */
export function isInsideCorridor(lon, lat, ring = CORRIDOR_POLYGON) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Whether ANY vertex of a GeoJSON geometry lies inside the corridor, or the
 * corridor contains the geometry's bbox centre — enough to keep a polygon
 * (a weather zone) that overlaps the band without a full clip.
 * @param {object|null} geometry GeoJSON geometry.
 * @returns {boolean}
 */
export function geometryTouchesCorridor(geometry) {
  const points = flattenCoordinates(geometry);
  if (!points.length) return false;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (isInsideCorridor(lon, lat)) return true;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  // The geometry may surround the corridor entirely (a statewide polygon):
  // test the corridor's own vertices against the geometry's rough bounds.
  if (
    west <= CORRIDOR_BBOX.west &&
    east >= CORRIDOR_BBOX.east &&
    south <= CORRIDOR_BBOX.south &&
    north >= CORRIDOR_BBOX.north
  )
    return true;
  return CORRIDOR_POLYGON.some(
    ([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north,
  );
}

/** Flatten any GeoJSON geometry to an array of [lon, lat] positions. */
export function flattenCoordinates(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'GeometryCollection')
    return (geometry.geometries || []).flatMap(flattenCoordinates);
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 2 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'number'
    ) {
      out.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry.coordinates);
  return out;
}

/** GeoJSON Feature of the corridor outline, for drawing and for tests. */
export function corridorOutlineFeature() {
  return {
    type: 'Feature',
    properties: { name: CORRIDOR_LAYER_NAME },
    geometry: {
      type: 'Polygon',
      coordinates: [CORRIDOR_POLYGON.map((p) => [...p])],
    },
  };
}
