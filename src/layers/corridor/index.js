import * as Cesium from 'cesium';
import {
  CORRIDOR_LAYER_ID,
  CORRIDOR_LAYER_NAME,
  CORRIDOR_DEFAULT_PARAMS,
  CORRIDOR_POLYGON,
  CORRIDOR_SUBLAYER_IDS,
  CORRIDOR_VIEW,
  isInsideCorridor,
} from './constants.js';
import {
  CORRIDOR_PICK_PREFIX,
  CORRIDOR_OUTLINE_COLOR,
  I75_COLOR,
  CAMERA_COLOR,
  SUBLAYER_REFRESH_MS,
  agencyColor,
  aqiColor,
  corridorAnalystRecords,
  corridorLegend,
  corridorRowChips,
  corridorSummary,
  floodColor,
  hasCorridorParam,
  incidentColor,
  normalizeCorridorParams,
  severityColor,
} from './model.js';
import { createCorridorSource, createCorridorStaticSource } from './source.js';
import { createCorridorCard } from './card.js';
import { isPointerFree } from '../../data/inputOwnership.js';

export * from './constants.js';
export * from './model.js';
export { createCorridorSource, createCorridorStaticSource } from './source.js';

const CORRIDOR_CREDIT = Object.freeze({
  key: 'corridor',
  html:
    'Corridor: NWS · NOAA NWPS · AirNow/EPA · TDOT SmartWay · Hamilton County 911 · ' +
    'Georgia 511 · MARTA · CARTA · I-75 line © OpenStreetMap contributors (ODbL)',
});

/**
 * Own the "Corridor: CHA ↔ ATL" layer group: a faint corridor outline, the
 * I-75 centerline, and six switchable sub-layers each fed by a server-side
 * provider under /api/corridor. Sub-layers refresh on their own cadences
 * inside one update tick; a provider that fails keeps its last records and
 * marks its chip DELAYED/OFFLINE instead of failing the layer.
 */
export function createCorridorLayer({
  source = createCorridorSource(),
  staticSource = createCorridorStaticSource(),
  services = {},
} = {}) {
  const picking = services.picking || {};
  const keyGuidance = services.keyGuidance || (() => '');
  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    params: { ...CORRIDOR_DEFAULT_PARAMS },
    data: {
      alerts: [],
      incidents: [],
      transit: [],
      gauges: [],
      air: [],
      cameras: [],
    },
    status: {},
    lastFetch: {},
    entities: new Map(), // sublayer id → Entity[]
    staticEntities: [],
    inFlight: new Map(),
    lastUpdate: null,
    clickHandler: null,
    card: null,
    rowControlsListener: null,
    centerline: null,
  };

  const notifyRow = () => {
    try {
      state.rowControlsListener?.();
    } catch {
      /* best effort */
    }
  };

  // ---------------------------------------------------------------- render
  const pickId = (kind, id) => `${CORRIDOR_PICK_PREFIX}${kind}:${id}`;

  function replaceEntities(sub, candidates) {
    const previous = state.entities.get(sub) || [];
    for (const entity of previous) state.dataSource?.entities.remove(entity);
    // Entity ids must be unique per data source; a publisher that repeats a
    // record id must not take the whole sub-layer down with it.
    const ids = new Set();
    const entities = candidates.filter((entity) => {
      if (ids.has(entity.id)) return false;
      ids.add(entity.id);
      return true;
    });
    state.entities.set(sub, entities);
    if (state.dataSource)
      for (const entity of entities) state.dataSource.entities.add(entity);
  }

  const point = (kind, record, color, { size = 9, outline = 1.5 } = {}) =>
    new Cesium.Entity({
      id: pickId(kind, record.id ?? record.lid),
      position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
      point: {
        pixelSize: size,
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: outline,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

  function renderSub(sub) {
    const d = state.data;
    switch (sub) {
      case 'alerts':
        replaceEntities(
          'alerts',
          d.alerts.flatMap((alert) => {
            const color = Cesium.Color.fromCssColorString(
              severityColor(alert.severity),
            );
            const polygons =
              alert.geometry.type === 'Polygon'
                ? [alert.geometry.coordinates]
                : alert.geometry.coordinates;
            return polygons.map(
              (rings, index) =>
                new Cesium.Entity({
                  id: pickId('alert', `${alert.id}#${index}`),
                  polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(
                      Cesium.Cartesian3.fromDegreesArray(rings[0].flat()),
                    ),
                    material: color.withAlpha(0.18),
                    outline: true,
                    outlineColor: color.withAlpha(0.9),
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  },
                }),
            );
          }),
        );
        break;
      case 'incidents':
        replaceEntities(
          'incidents',
          d.incidents.map((i) =>
            point('incident', i, incidentColor(i.kind), {
              size: i.closure ? 11 : 8,
            }),
          ),
        );
        break;
      case 'transit':
        replaceEntities(
          'transit',
          d.transit.map((v) =>
            point('transit', v, agencyColor(v.agency), { size: 6, outline: 1 }),
          ),
        );
        break;
      case 'gauges':
        replaceEntities(
          'gauges',
          d.gauges.map((g) =>
            point('gauge', { ...g, id: g.lid }, floodColor(g.floodCategory), {
              size: ['minor', 'moderate', 'major'].includes(g.floodCategory)
                ? 12
                : 7,
            }),
          ),
        );
        break;
      case 'air':
        replaceEntities(
          'air',
          d.air.map(
            (q) =>
              new Cesium.Entity({
                id: pickId('air', q.id),
                position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat),
                point: {
                  pixelSize: 14,
                  color: Cesium.Color.fromCssColorString(
                    aqiColor(q.worstCategory),
                  ).withAlpha(0.85),
                  outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
                label: {
                  text: `AQI ${q.worstAqi}`,
                  font: '11px monospace',
                  fillColor: Cesium.Color.WHITE,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 3,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new Cesium.Cartesian2(0, -16),
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
              }),
          ),
        );
        break;
      case 'cams':
        replaceEntities(
          'cams',
          d.cameras.map((c) => point('camera', c, CAMERA_COLOR, { size: 7 })),
        );
        break;
      default:
        break;
    }
  }

  function renderStatic() {
    for (const entity of state.staticEntities)
      state.dataSource?.entities.remove(entity);
    state.staticEntities = [];
    if (!state.dataSource) return;
    const outline = new Cesium.Entity({
      id: `${CORRIDOR_PICK_PREFIX}outline`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(CORRIDOR_POLYGON.flat()),
        width: 1.5,
        material: Cesium.Color.fromCssColorString(
          CORRIDOR_OUTLINE_COLOR,
        ).withAlpha(0.35),
        clampToGround: true,
      },
    });
    state.staticEntities.push(outline);
    if (state.centerline) {
      state.staticEntities.push(
        new Cesium.Entity({
          id: `${CORRIDOR_PICK_PREFIX}i75`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              state.centerline.flat(),
            ),
            width: 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: Cesium.Color.fromCssColorString(I75_COLOR).withAlpha(0.9),
            }),
            clampToGround: true,
          },
        }),
      );
    }
    for (const entity of state.staticEntities)
      state.dataSource.entities.add(entity);
  }

  async function loadCenterline() {
    if (state.centerline) return;
    try {
      const geojson = await staticSource.getCenterline();
      const feature = geojson?.features?.[0];
      const coords = feature?.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length > 1) {
        state.centerline = coords;
        renderStatic();
      }
    } catch (error) {
      console.warn(
        '[Data:Corridor] I-75 centerline unavailable:',
        error?.message,
      );
    }
  }

  // ----------------------------------------------------------------- fetch
  const setStatus = (sub, patch) => {
    state.status[sub] = { ...(state.status[sub] || {}), ...patch };
  };

  async function fetchSub(sub, signal) {
    switch (sub) {
      case 'alerts': {
        const r = await source.getAlerts({ signal });
        state.data.alerts = r.body?.alerts || [];
        return {
          count: state.data.alerts.length,
          delayed: r.delayed,
          keyRequired: false,
        };
      }
      case 'incidents': {
        const r = await source.getIncidents({ signal });
        state.data.incidents = r.body?.incidents || [];
        const keyed = (r.body?.sources || []).find((s) => s.keyRequired);
        return {
          count: state.data.incidents.length,
          delayed: r.delayed,
          keyRequired: Boolean(keyed),
          keyId: keyed?.keyId || null,
        };
      }
      case 'transit': {
        const r = await source.getTransit({ signal });
        const vehicles = [...(r.body?.vehicles || [])];
        let delayed = r.delayed;
        for (const feed of r.body?.gtfsFeeds || []) {
          try {
            const gtfs = await staticSource.getGtfsVehicles(feed.id, {
              signal,
            });
            delayed = delayed || gtfs.delayed;
            for (const v of gtfs.body?.vehicles || []) {
              if (!isInsideCorridor(v.lon, v.lat)) continue;
              vehicles.push({
                id: `${feed.agency}:${v.id}`,
                agency: feed.agency,
                agencyName: feed.agencyName,
                routeId: v.routeId,
                label: v.label,
                heading: v.bearing,
                speedMph: Number.isFinite(v.speedMps)
                  ? v.speedMps * 2.23694
                  : null,
                lat: v.lat,
                lon: v.lon,
              });
            }
          } catch (error) {
            delayed = true;
            console.warn(
              `[Data:Corridor] ${feed.id} unavailable:`,
              error?.message,
            );
          }
        }
        state.data.transit = vehicles;
        const keyed = (r.body?.sources || []).find((s) => s.keyRequired);
        return {
          count: vehicles.length,
          delayed,
          keyRequired: Boolean(keyed),
          keyId: keyed?.keyId || null,
        };
      }
      case 'gauges': {
        const r = await source.getGauges({ signal });
        state.data.gauges = r.body?.gauges || [];
        return {
          count: state.data.gauges.length,
          delayed: r.delayed,
          keyRequired: false,
        };
      }
      case 'air': {
        const r = await source.getAir({ signal });
        state.data.air = r.body?.areas || [];
        return {
          count: state.data.air.length,
          delayed: r.delayed,
          keyRequired: false,
        };
      }
      case 'cams': {
        const r = await source.getCameras({ signal });
        if (r.keyRequired) {
          state.data.cameras = [];
          return {
            count: 0,
            delayed: false,
            keyRequired: true,
            keyId: r.keyId || 'ga511',
          };
        }
        state.data.cameras = r.body?.cameras || [];
        const keyed = (r.body?.sources || []).find((s) => s.keyRequired);
        return {
          count: state.data.cameras.length,
          delayed: r.delayed,
          keyRequired: Boolean(keyed),
          keyId: keyed?.keyId || null,
        };
      }
      default:
        return { count: 0 };
    }
  }

  function refresh(sub, { force = false } = {}) {
    if (!state.enabled || !state.params[sub]) return null;
    const due =
      force ||
      Date.now() - (state.lastFetch[sub] || 0) >= SUBLAYER_REFRESH_MS[sub];
    if (!due) return null;
    if (state.inFlight.has(sub)) return state.inFlight.get(sub);
    const controller = new AbortController();
    const run = (async () => {
      try {
        const result = await fetchSub(sub, controller.signal);
        if (controller.signal.aborted) return;
        state.lastFetch[sub] = Date.now();
        state.lastUpdate = Date.now();
        setStatus(sub, { ...result, error: null });
        if (state.params[sub]) renderSub(sub);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn(
          `[Data:Corridor] ${sub} fetch error:`,
          error?.message || error,
        );
        setStatus(sub, {
          error: error?.message || 'unavailable',
          delayed: true,
        });
        state.lastFetch[sub] = Date.now(); // back off one cadence
      } finally {
        state.inFlight.delete(sub);
        notifyRow();
      }
    })();
    run.abort = () => controller.abort();
    state.inFlight.set(sub, run);
    return run;
  }

  function abortAll() {
    for (const run of state.inFlight.values()) run.abort?.();
    state.inFlight.clear();
  }

  // ------------------------------------------------------------ interaction
  function recordFor(kind, id) {
    const d = state.data;
    switch (kind) {
      case 'alert': {
        const alertId = id.replace(/#\d+$/, '');
        return d.alerts.find((a) => a.id === alertId) || null;
      }
      case 'incident':
        return d.incidents.find((i) => i.id === id) || null;
      case 'transit':
        return d.transit.find((v) => v.id === id) || null;
      case 'gauge':
        return d.gauges.find((g) => g.lid === id) || null;
      case 'air':
        return d.air.find((q) => q.id === id) || null;
      case 'camera':
        return d.cameras.find((c) => c.id === id) || null;
      default:
        return null;
    }
  }

  function accentFor(kind, record) {
    switch (kind) {
      case 'alert':
        return severityColor(record.severity);
      case 'incident':
        return incidentColor(record.kind);
      case 'transit':
        return agencyColor(record.agency);
      case 'gauge':
        return floodColor(record.floodCategory);
      case 'air':
        return aqiColor(record.worstCategory);
      default:
        return CAMERA_COLOR;
    }
  }

  function select(pickedId) {
    const raw = String(pickedId || '');
    if (!raw.startsWith(CORRIDOR_PICK_PREFIX)) return false;
    const rest = raw.slice(CORRIDOR_PICK_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return false;
    const kind = rest.slice(0, colon);
    const id = rest.slice(colon + 1);
    const record = recordFor(kind, id);
    if (!record) return false;
    if (!state.card) state.card = createCorridorCard();
    const extras = { accent: accentFor(kind, record) };
    if (kind === 'camera')
      extras.frameUrl = (bust) => source.getCameraFrameUrl(record.id, { bust });
    if (kind === 'gauge')
      extras.series = source.getGaugeSeries(record.lid).then((r) => r.body);
    state.card.show(kind, record, extras);
    return true;
  }

  function installInteraction() {
    if (!state.viewer || state.clickHandler) return;
    picking.registerPickOwner?.(CORRIDOR_LAYER_ID, (id) =>
      String(id).startsWith(CORRIDOR_PICK_PREFIX),
    );
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      state.viewer.scene.canvas,
    );
    state.clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !state.enabled) return;
      const scene = state.viewer.scene;
      const candidates = [
        scene.pick(click.position),
        ...(scene.drillPick?.(click.position, 8) || []),
      ];
      for (const picked of candidates) {
        const id = picking.resolvePickId
          ? picking.resolvePickId(picked)
          : picked?.id?.id;
        if (id && select(id)) return;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeInteraction() {
    picking.unregisterPickOwner?.(CORRIDOR_LAYER_ID);
    state.clickHandler?.destroy();
    state.clickHandler = null;
    state.card?.hide();
  }

  // ------------------------------------------------------------------ view
  function frameCorridor({ duration = 2.5 } = {}) {
    const viewer = state.viewer;
    if (!viewer) return Promise.resolve(false);
    const r = CORRIDOR_VIEW.rectangle;
    return new Promise((resolve) => {
      // A hidden tab pauses the render loop and with it the flight's
      // completion callback; settle after the flight's own duration plus a
      // grace period so a voice tool never waits on a paused animation.
      const timer = setTimeout(() => resolve(true), duration * 1000 + 3000);
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          r.west,
          r.south,
          r.east,
          r.north,
        ),
        duration,
        complete: () => settle(true),
        cancel: () => settle(false),
      });
    });
  }

  // ----------------------------------------------------------------- layer
  const layer = {
    id: CORRIDOR_LAYER_ID,
    name: CORRIDOR_LAYER_NAME,
    icon: '🛣️',
    source: 'NWS · NOAA · TDOT · GDOT · MARTA',
    updateInterval: SUBLAYER_REFRESH_MS.transit,
    showInTogglePanel: true,

    init(viewer) {
      if (state.viewer)
        throw new Error('Corridor layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('corridor');
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      renderStatic();
      void loadCenterline();
      try {
        services.credits?.registerDynamicCredit?.(viewer, CORRIDOR_CREDIT);
      } catch {
        /* credit is best effort */
      }
      console.log('[Data:Corridor] Initialized');
    },

    enable() {
      state.enabled = true;
      if (state.dataSource) state.dataSource.show = true;
      installInteraction();
    },

    disable() {
      state.enabled = false;
      abortAll();
      removeInteraction();
      if (state.dataSource) state.dataSource.show = false;
    },

    async update() {
      if (!state.enabled) return false;
      // A tick with nothing due is a successful no-op, not a rejected refresh.
      const runs = CORRIDOR_SUBLAYER_IDS.map((sub) => refresh(sub)).filter(
        Boolean,
      );
      await Promise.all(runs);
      return true;
    },

    destroy(viewer = state.viewer) {
      this.disable();
      state.card?.destroy();
      state.card = null;
      for (const entities of state.entities.values())
        for (const entity of entities)
          state.dataSource?.entities.remove(entity);
      state.entities.clear();
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.viewer = null;
      state.data = {
        alerts: [],
        incidents: [],
        transit: [],
        gauges: [],
        air: [],
        cameras: [],
      };
      state.status = {};
      state.lastFetch = {};
      state.lastUpdate = null;
    },

    setParams(params = {}) {
      if (!hasCorridorParam(params)) return false;
      const previous = state.params;
      state.params = normalizeCorridorParams(previous, params);
      for (const sub of CORRIDOR_SUBLAYER_IDS) {
        if (previous[sub] === state.params[sub]) continue;
        if (state.params[sub]) {
          if (state.lastFetch[sub]) renderSub(sub);
          refresh(sub, { force: true });
        } else {
          state.inFlight.get(sub)?.abort?.();
          state.inFlight.delete(sub);
          replaceEntities(sub, []);
        }
      }
      notifyRow();
      return true;
    },

    getParams() {
      return { ...state.params };
    },

    setRowControlsListener(listener) {
      state.rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      return {
        chips: corridorRowChips({
          params: state.params,
          status: state.status,
          enabled: state.enabled,
          onFrame: () => void frameCorridor(),
          keyGuidance,
        }),
        legend: corridorLegend(state.params, state.status, state.data),
      };
    },

    frameCorridor,
    select,
    isInsideCorridor,

    /** Counts + spoken sentence for the voice/analyst path. */
    getSummary(extra = {}) {
      return corridorSummary(state.data, state.status, extra);
    },

    getAnalystRecords(maxCount = 2000) {
      if (!state.enabled) return [];
      return corridorAnalystRecords(state.data, maxCount);
    },

    getStats() {
      const total = CORRIDOR_SUBLAYER_IDS.reduce(
        (sum, sub) =>
          sum + (state.params[sub] ? state.status[sub]?.count || 0 : 0),
        0,
      );
      const active = CORRIDOR_SUBLAYER_IDS.filter((sub) => state.params[sub]);
      const failed = active.filter(
        (sub) => state.status[sub]?.error && !state.status[sub]?.count,
      );
      const delayed = active.some((sub) => state.status[sub]?.delayed);
      return {
        count: total,
        countLabel: state.enabled ? `${total} in corridor` : '',
        lastUpdate: state.lastUpdate,
        stale: delayed,
        error:
          failed.length && failed.length === active.length
            ? 'Corridor providers unavailable'
            : null,
        loading: state.inFlight.size > 0,
        loadingLabel: state.inFlight.size
          ? 'refreshing corridor feeds'
          : delayed
            ? 'Some feeds delayed'
            : '',
      };
    },
  };
  return layer;
}
