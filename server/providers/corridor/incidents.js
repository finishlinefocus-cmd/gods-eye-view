import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import { corridorKey } from './keys.js';
import { CORRIDOR_BBOX } from '../../../src/layers/corridor/constants.js';
import {
  normalizeGa511Events,
  normalizeHc911Calls,
  normalizeTdotEvents,
} from '../../../src/layers/corridor/normalize.js';

/**
 * Road incidents along the corridor from three publishers, merged into one
 * list. Each publisher is fetched and cached independently so one being down
 * degrades only its own slice (the reply carries per-source status):
 *   - TDOT Smartway_Events ArcGIS FeatureServer (keyless, statewide live events)
 *   - Hamilton County 911 active calls ArcGIS layer (keyless; the layer is
 *     named "HC911temp" by its publisher, so it is treated as best-effort)
 *   - Georgia 511 events API (free key, GA511_API_KEY; 10 calls/min limit)
 */
const envelope = `${CORRIDOR_BBOX.west},${CORRIDOR_BBOX.south},${CORRIDOR_BBOX.east},${CORRIDOR_BBOX.north}`;
export const TDOT_EVENTS_URL =
  'https://spatial.tdot.tn.gov/ArcGIS/rest/services/Smartway/Smartway_Events/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    outFields:
      'ID,START_DATE,END_DATE,REVISED_DATE,EVENT_TYPE,EVENT_SUBTYPE,DESCRIPTION,VEHICLE_IMPACT,HAS_CLOSURE,CD_DIRECTION,COUNTY_NAME,CD_ROAD_NAMES',
    resultRecordCount: '500',
    f: 'json',
  }).toString();
export const HC911_URL =
  'https://services2.arcgis.com/OIAIimblRxPs0xxc/ArcGIS/rest/services/HC911temp/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields:
      'Master_Incident_Number,Response_Date,Problem,Address,Latitude,Longitude,OBJECTID',
    orderByFields: 'Response_Date DESC',
    resultRecordCount: '200',
    outSR: '4326',
    f: 'json',
  }).toString();
export const GA511_EVENTS_URL = (key) =>
  `https://511ga.org/api/v2/get/event?format=json&key=${encodeURIComponent(key)}`;
export const INCIDENTS_TTL_MS = 60 * 1000;
export const GA511_TTL_MS = 2 * 60 * 1000; // 10 calls/min budget shared with cameras

export function createIncidentsProvider({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const cache = createCorridorCache({ ttlMs: INCIDENTS_TTL_MS });
  const gaCache = createCorridorCache({ ttlMs: GA511_TTL_MS });

  const slice = async (id, read) => {
    try {
      const result = await read();
      return { id, ok: true, delayed: result.delayed, items: result.value };
    } catch (error) {
      return {
        id,
        ok: false,
        delayed: true,
        items: [],
        error: error?.message || String(error),
      };
    }
  };

  async function read() {
    const gaKey = corridorKey('ga511', env);
    const slices = await Promise.all([
      slice('tdot', () =>
        cache.read('tdot', async () =>
          normalizeTdotEvents(
            await fetchCorridorJson(TDOT_EVENTS_URL, {
              fetchImpl,
              timeoutMs: 40000,
            }),
          ),
        ),
      ),
      slice('hc911', () =>
        cache.read('hc911', async () =>
          normalizeHc911Calls(
            await fetchCorridorJson(HC911_URL, { fetchImpl }),
          ),
        ),
      ),
      gaKey
        ? slice('ga511', () =>
            gaCache.read('ga511', async () =>
              normalizeGa511Events(
                await fetchCorridorJson(GA511_EVENTS_URL(gaKey), { fetchImpl }),
              ),
            ),
          )
        : Promise.resolve({
            id: 'ga511',
            ok: false,
            keyRequired: true,
            keyId: 'ga511',
            items: [],
          }),
    ]);
    const incidents = slices.flatMap((entry) => entry.items);
    const delayed = slices.some((entry) => entry.ok && entry.delayed);
    return {
      value: {
        incidents,
        sources: slices.map(({ items, ...rest }) => ({
          ...rest,
          count: items.length,
        })),
      },
      delayed,
      cache: 'MERGED',
    };
  }

  return { id: 'incidents', ttlMs: INCIDENTS_TTL_MS, read };
}
