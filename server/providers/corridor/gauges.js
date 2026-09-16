import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import { CORRIDOR_BBOX } from '../../../src/layers/corridor/constants.js';
import {
  normalizeNwpsGauges,
  normalizeNwpsSeries,
} from '../../../src/layers/corridor/normalize.js';

/**
 * River gauges for the corridor from NOAA's National Water Prediction Service
 * (api.water.noaa.gov, no key). One bbox listing gives every gauge with its
 * current stage/flow and flood category; a per-gauge stageflow request backs
 * the 24 h sparkline when a marker is clicked. NWPS carries the USGS site id
 * per gauge and covers the TVA-operated Tennessee River gauges that USGS'
 * own instantaneous-values service no longer publishes.
 */
export const NWPS_GAUGES_URL =
  `https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=${CORRIDOR_BBOX.west}` +
  `&bbox.ymin=${CORRIDOR_BBOX.south}&bbox.xmax=${CORRIDOR_BBOX.east}` +
  `&bbox.ymax=${CORRIDOR_BBOX.north}&srid=EPSG_4326`;
export const NWPS_GAUGES_TTL_MS = 10 * 60 * 1000;
export const NWPS_SERIES_TTL_MS = 15 * 60 * 1000;
const LID_PATTERN = /^[A-Z0-9]{3,8}$/;

export function nwpsSeriesUrl(lid) {
  return `https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow`;
}

export function isValidGaugeLid(lid) {
  return LID_PATTERN.test(String(lid || ''));
}

export function createGaugesProvider({ fetchImpl = fetch } = {}) {
  const listCache = createCorridorCache({ ttlMs: NWPS_GAUGES_TTL_MS });
  const seriesCache = createCorridorCache({ ttlMs: NWPS_SERIES_TTL_MS });

  async function produceList() {
    const payload = await fetchCorridorJson(NWPS_GAUGES_URL, { fetchImpl });
    return { gauges: normalizeNwpsGauges(payload) };
  }

  async function readSeries(lid) {
    const id = String(lid || '').toUpperCase();
    if (!isValidGaugeLid(id)) {
      const err = new Error('Invalid gauge id');
      err.status = 400;
      throw err;
    }
    // Only gauges the listing placed inside the corridor may be queried, so
    // this route cannot become a generic NWPS relay.
    const list = await listCache.read('gauges', produceList);
    const gauge = list.value.gauges.find((entry) => entry.lid === id);
    if (!gauge) {
      const err = new Error('Gauge not in corridor');
      err.status = 404;
      throw err;
    }
    return seriesCache.read(`series:${id}`, async () => {
      const payload = await fetchCorridorJson(nwpsSeriesUrl(id), { fetchImpl });
      return { gauge, series: normalizeNwpsSeries(payload) };
    });
  }

  return {
    id: 'gauges',
    ttlMs: NWPS_GAUGES_TTL_MS,
    read: () => listCache.read('gauges', produceList),
    readSeries,
  };
}
