import { fetchCorridorJson } from './upstream.js';
import { createCorridorCache } from './cache.js';
import { corridorKey, CorridorKeyRequired } from './keys.js';
import {
  isAllowedCameraSnapshotUrl,
  normalizeGa511Cameras,
  normalizeTdotCameras,
} from '../../../src/layers/corridor/normalize.js';
import { fetchCctvImageFromUpstream } from '../cctv/media.js';

/**
 * Traffic cameras along the corridor.
 *
 * The camera LIST needs a key on both sides of the state line: Georgia 511's
 * developer API (GA511_API_KEY, free) and TDOT's OpenData API (TDOT_API_KEY,
 * issued by TDOT on request). Snapshots are then relayed by `/frame`, which
 * only ever fetches a URL that came out of one of those lists — the browser
 * names a camera id, never a URL — and only from the allowlisted hosts.
 */
export const GA511_CAMERAS_URL = (key) =>
  `https://511ga.org/api/v2/get/cameras?format=json&key=${encodeURIComponent(key)}`;
export const TDOT_CAMERAS_URL =
  'https://www.tdot.tn.gov/opendata/api/public/RoadwayCameras';
export const CAMERAS_TTL_MS = 60 * 60 * 1000; // camera inventories change rarely
export const CAMERA_FRAME_TTL_MS = 30 * 1000;
const CAMERA_ID_PATTERN = /^(ga511|tdot):[A-Za-z0-9_-]{1,30}$/;

export function createCamerasProvider({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const cache = createCorridorCache({
    ttlMs: CAMERAS_TTL_MS,
    staleMaxMs: 24 * 60 * 60 * 1000,
  });

  async function readList() {
    const gaKey = corridorKey('ga511', env);
    const tdotKey = corridorKey('tdot', env);
    if (!gaKey && !tdotKey) throw new CorridorKeyRequired('ga511');
    const sources = [];
    const cameras = [];
    if (gaKey) {
      try {
        const result = await cache.read('ga511', async () =>
          normalizeGa511Cameras(
            await fetchCorridorJson(GA511_CAMERAS_URL(gaKey), { fetchImpl }),
          ),
        );
        cameras.push(...result.value);
        sources.push({
          id: 'ga511',
          ok: true,
          delayed: result.delayed,
          count: result.value.length,
        });
      } catch (error) {
        sources.push({
          id: 'ga511',
          ok: false,
          error: error?.message || String(error),
          count: 0,
        });
      }
    } else
      sources.push({
        id: 'ga511',
        ok: false,
        keyRequired: true,
        keyId: 'ga511',
        count: 0,
      });
    if (tdotKey) {
      try {
        const result = await cache.read('tdot', async () =>
          normalizeTdotCameras(
            await fetchCorridorJson(TDOT_CAMERAS_URL, {
              fetchImpl,
              headers: { apiKey: tdotKey },
            }),
          ),
        );
        cameras.push(...result.value);
        sources.push({
          id: 'tdot',
          ok: true,
          delayed: result.delayed,
          count: result.value.length,
        });
      } catch (error) {
        sources.push({
          id: 'tdot',
          ok: false,
          error: error?.message || String(error),
          count: 0,
        });
      }
    } else
      sources.push({
        id: 'tdot',
        ok: false,
        keyRequired: true,
        keyId: 'tdot',
        count: 0,
      });
    return {
      value: { cameras, sources },
      delayed: sources.some((entry) => entry.ok && entry.delayed),
      cache: 'MERGED',
    };
  }

  /** Resolve a camera id to its first allowlisted view URL, or null. */
  async function snapshotUrlFor(cameraId) {
    if (!CAMERA_ID_PATTERN.test(String(cameraId || ''))) return null;
    const { value } = await readList();
    const camera = value.cameras.find((entry) => entry.id === cameraId);
    const view = camera?.views?.[0];
    if (!view || !isAllowedCameraSnapshotUrl(view.url)) return null;
    return view.url;
  }

  /** Fetch a snapshot for a listed camera: {status, contentType, bytes}. */
  async function readFrame(cameraId) {
    const url = await snapshotUrlFor(cameraId);
    if (!url) {
      const err = new Error('Unknown camera');
      err.status = 404;
      throw err;
    }
    const image = await fetchCctvImageFromUpstream(url, { fetchImpl });
    if (!image?.ok) {
      const err = new Error('Snapshot unavailable');
      err.status = 502;
      throw err;
    }
    return { contentType: image.contentType, bytes: image.body };
  }

  return {
    id: 'cameras',
    ttlMs: CAMERAS_TTL_MS,
    read: readList,
    readFrame,
    snapshotUrlFor,
    isValidCameraId: (id) => CAMERA_ID_PATTERN.test(String(id || '')),
  };
}
