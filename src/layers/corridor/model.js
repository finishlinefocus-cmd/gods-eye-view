/**
 * @module corridor/model
 * @description Pure presentation policy for the corridor layer: colours per
 * category, chip descriptors, analyst records and the spoken summary. No
 * Cesium, no DOM — node:test covers it directly.
 */
import {
  CORRIDOR_DEFAULT_PARAMS,
  CORRIDOR_SUBLAYERS,
  CORRIDOR_SUBLAYER_IDS,
} from './constants.js';

export const CORRIDOR_PICK_PREFIX = 'corridor:';

export const SEVERITY_COLORS = Object.freeze({
  Extreme: '#ff2d55',
  Severe: '#ff6a00',
  Moderate: '#ffcc00',
  Minor: '#7fd1ff',
  Unknown: '#aaaaaa',
});

export const FLOOD_COLORS = Object.freeze({
  major: '#b000ff',
  moderate: '#ff2d55',
  minor: '#ff8c00',
  action: '#ffd400',
  no_flooding: '#3fb0ff',
  low_threshold: '#8fd3ff',
});
export const FLOOD_FALLBACK_COLOR = '#8a8f98';

export const AQI_COLORS = Object.freeze({
  Good: '#00e400',
  Moderate: '#ffff00',
  'Unhealthy for Sensitive Groups': '#ff7e00',
  Unhealthy: '#ff0000',
  'Very Unhealthy': '#8f3f97',
  Hazardous: '#7e0023',
});

export const INCIDENT_COLORS = Object.freeze({
  crash: '#ff3b30',
  closure: '#ff2d95',
  roadwork: '#ff9f0a',
  hazard: '#ffd60a',
  other: '#9aa0a6',
});

export const AGENCY_COLORS = Object.freeze({
  marta: '#ff8c00',
  carta: '#00c2ff',
});

export const CAMERA_COLOR = '#5ef2c9';
export const CORRIDOR_OUTLINE_COLOR = '#9ad0ff';
export const I75_COLOR = '#ffb454';

export const severityColor = (severity) =>
  SEVERITY_COLORS[severity] || SEVERITY_COLORS.Unknown;
export const floodColor = (category) =>
  FLOOD_COLORS[category] || FLOOD_FALLBACK_COLOR;
export const aqiColor = (category) => AQI_COLORS[category] || '#9aa0a6';
export const incidentColor = (kind) =>
  INCIDENT_COLORS[kind] || INCIDENT_COLORS.other;
export const agencyColor = (agency) => AGENCY_COLORS[agency] || '#ffffff';

/** Per-sub-layer refresh cadence (ms) inside the layer's update tick. */
export const SUBLAYER_REFRESH_MS = Object.freeze({
  cams: 60 * 60 * 1000,
  incidents: 60 * 1000,
  transit: 20 * 1000,
  alerts: 90 * 1000,
  gauges: 10 * 60 * 1000,
  air: 60 * 60 * 1000,
});

/** Normalize a params patch into a full, boolean-only sub-layer state. */
export function normalizeCorridorParams(current, patch = {}) {
  const next = { ...CORRIDOR_DEFAULT_PARAMS, ...current };
  for (const id of CORRIDOR_SUBLAYER_IDS) {
    if (patch[id] === undefined) continue;
    next[id] = patch[id] === true || patch[id] === 'true' || patch[id] === 1;
  }
  return next;
}

/** Whether a params patch names at least one known sub-layer. */
export function hasCorridorParam(patch = {}) {
  return CORRIDOR_SUBLAYER_IDS.some((id) => patch?.[id] !== undefined);
}

/**
 * Chip descriptors for the layer row: one toggle per sub-layer plus the
 * FRAME CORRIDOR action. `status[id]` carries { count, delayed, keyRequired,
 * keyId, error } as tracked by the layer.
 */
export function corridorRowChips({
  params,
  status = {},
  enabled = true,
  onFrame,
  keyGuidance = () => '',
}) {
  const chips = [
    {
      id: 'frame',
      label: 'FRAME CORRIDOR',
      title: 'Fly the camera to frame Chattanooga and Atlanta',
      disabled: !enabled,
      onClick: onFrame,
    },
  ];
  for (const sub of CORRIDOR_SUBLAYERS) {
    const state = status[sub.id] || {};
    const active = params[sub.id] === true;
    let label = sub.label;
    let title = sub.title;
    let chipState = active ? 'active' : 'idle';
    if (state.keyRequired && !state.count) {
      label = `${sub.label} · KEY`;
      title =
        keyGuidance(state.keyId) || `${sub.title} — provider key required`;
    } else if (active && state.error && !state.count) {
      label = `${sub.label} · OFFLINE`;
      chipState = 'degraded';
      title = `${sub.title} — ${state.error}`;
    } else if (active && state.delayed) {
      label = `${sub.label} · DELAYED`;
      chipState = 'stale';
      title = `${sub.title} — showing the last good data`;
    } else if (active && Number.isFinite(state.count)) {
      label = `${sub.label} · ${state.count}`;
    }
    chips.push({
      id: sub.id,
      label,
      title,
      active,
      state: chipState,
      disabled: !enabled,
      params: { [sub.id]: !active },
    });
  }
  return chips;
}

/** Legend rows for the layer panel, with live counts per colour family. */
export function corridorLegend(params, status = {}, data = {}) {
  const count = (id) => status[id]?.count || 0;
  const rows = [];
  if (params.alerts)
    rows.push({
      label: 'NWS alert (severity)',
      color: SEVERITY_COLORS.Severe,
      count: count('alerts'),
    });
  if (params.incidents)
    rows.push({
      label: 'Incident / roadwork',
      color: INCIDENT_COLORS.crash,
      count: count('incidents'),
    });
  if (params.transit) {
    const vehicles = data.transit || [];
    rows.push({
      label: 'MARTA',
      color: AGENCY_COLORS.marta,
      count: vehicles.filter((v) => v.agency === 'marta').length,
    });
    rows.push({
      label: 'CARTA',
      color: AGENCY_COLORS.carta,
      count: vehicles.filter((v) => v.agency === 'carta').length,
    });
  }
  if (params.gauges)
    rows.push({
      label: 'River gauge (flood class)',
      color: FLOOD_COLORS.no_flooding,
      count: count('gauges'),
    });
  if (params.air)
    rows.push({
      label: 'Air quality (AQI)',
      color: AQI_COLORS.Moderate,
      count: count('air'),
    });
  if (params.cams)
    rows.push({
      label: 'Traffic camera',
      color: CAMERA_COLOR,
      count: count('cams'),
    });
  rows.push({ label: 'I-75 centerline', color: I75_COLOR, count: 1 });
  return rows;
}

/** Flatten the layer's records into analyst rows: { id, kind, lat, lon, ... }. */
export function corridorAnalystRecords(data, maxCount = 2000) {
  const out = [];
  const push = (row) => {
    if (out.length < maxCount) out.push(row);
  };
  for (const a of data.alerts || [])
    push({
      id: a.id,
      kind: 'alert',
      title: a.event,
      severity: a.severity,
      expires: a.expires,
      lat: null,
      lon: null,
    });
  for (const i of data.incidents || [])
    push({
      id: i.id,
      kind: 'incident',
      title: i.subtype || i.type,
      category: i.kind,
      source: i.source,
      lat: i.lat,
      lon: i.lon,
    });
  for (const v of data.transit || [])
    push({
      id: v.id,
      kind: 'transit',
      agency: v.agencyName || v.agency,
      routeId: v.routeId,
      lat: v.lat,
      lon: v.lon,
    });
  for (const g of data.gauges || [])
    push({
      id: g.lid,
      kind: 'gauge',
      title: g.name,
      stage: g.stage,
      floodCategory: g.floodCategory,
      lat: g.lat,
      lon: g.lon,
    });
  for (const q of data.air || [])
    push({
      id: q.id,
      kind: 'air',
      title: q.name,
      aqi: q.worstAqi,
      category: q.worstCategory,
      lat: q.lat,
      lon: q.lon,
    });
  for (const c of data.cameras || [])
    push({ id: c.id, kind: 'camera', title: c.name, lat: c.lat, lon: c.lon });
  return out;
}

/** Counts the voice summary speaks. `extra` may add e.g. flights in bbox. */
export function corridorSummary(data, status = {}, extra = {}) {
  const counts = {
    alerts: (data.alerts || []).length,
    incidents: (data.incidents || []).length,
    transitVehicles: (data.transit || []).length,
    gauges: (data.gauges || []).length,
    gaugesFlooding: (data.gauges || []).filter((g) =>
      ['action', 'minor', 'moderate', 'major'].includes(g.floodCategory),
    ).length,
    airAreas: (data.air || []).length,
    cameras: (data.cameras || []).length,
    ...extra,
  };
  const worstAir = (data.air || [])[0] || null;
  const topAlert = (data.alerts || [])[0] || null;
  const parts = [
    `${counts.alerts} active weather alert${counts.alerts === 1 ? '' : 's'}` +
      (topAlert ? ` (top: ${topAlert.event})` : ''),
    `${counts.incidents} road incident${counts.incidents === 1 ? '' : 's'}`,
    `${counts.transitVehicles} transit vehicle${counts.transitVehicles === 1 ? '' : 's'} live`,
    counts.gaugesFlooding
      ? `${counts.gaugesFlooding} river gauge${counts.gaugesFlooding === 1 ? '' : 's'} at or above action stage`
      : `${counts.gauges} river gauges, none in flood`,
  ];
  if (worstAir)
    parts.push(
      `air quality ${worstAir.worstCategory} (AQI ${worstAir.worstAqi}) at ${worstAir.name}`,
    );
  if (Number.isFinite(extra.flights))
    parts.push(`${extra.flights} aircraft over the corridor`);
  const keyed = Object.entries(status)
    .filter(([, s]) => s?.keyRequired && !s.count)
    .map(([id]) => id);
  return {
    counts,
    text: `Between Chattanooga and Atlanta: ${parts.join('; ')}.`,
    keyRequired: keyed,
  };
}
