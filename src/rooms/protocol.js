/**
 * Rooms wire protocol: constants and pure validators shared by the browser
 * client and the dev-server room provider. No DOM, no Node APIs.
 *
 * Client → server messages: `state`, `lead`, `chat`, `ping`, `event`,
 * `heartbeat`. Server → client messages: `hello`, `presence`, `state`, `lead`,
 * `chat`, `ping`, `event`, `error`, `heartbeat`.
 */

/** Room codes: 6 characters from an alphabet without I/O/0/1 look-alikes. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export const ROOM_LIMITS = Object.freeze({
  maxRooms: 100,
  maxMembers: 25,
  expiryMs: 30 * 60 * 1000,
  chatKeep: 100,
  momentsKeep: 20,
  chatWindowMs: 5000,
  chatPerWindow: 5,
  stateMinIntervalMs: 250, // ≤ 4 state messages per second from the leader
  pingTtlMs: 20_000,
  nameMax: 32,
  chatMax: 500,
  noteMax: 280,
  labelMax: 80,
  layersMax: 64,
  layerIdMax: 48,
  targetIdMax: 96,
  styleKeysMax: 48,
  stylePrimitiveMax: 96,
  messageBytesMax: 16 * 1024,
});

/** Member colors, chosen for contrast against the dark chrome and the globe. */
export const MEMBER_COLORS = Object.freeze([
  '#ffb347',
  '#5ad1ff',
  '#7cf29c',
  '#ff7ab6',
  '#c69cff',
  '#ffe066',
  '#66f0e0',
  '#ff8a66',
  '#9fd3ff',
  '#d4ff7a',
  '#ffb0e6',
  '#a3ffb0',
]);

/** Upper-case and strip separators; returns null unless it is a valid code. */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  let code = input.trim().toUpperCase();
  // Accept a pasted link: `<origin>/?room=CODE`.
  const fromUrl = /[?&#]ROOM=([A-Z0-9]+)/i.exec(code);
  if (fromUrl) code = fromUrl[1].toUpperCase();
  code = code.replace(/[\s-]+/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

/** Strict check used server-side for path segments: no forgiveness. */
export function isRoomCode(value) {
  if (typeof value !== 'string' || value.length !== ROOM_CODE_LENGTH)
    return false;
  for (const char of value) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Sanitize free text: drop control characters and bidi overrides, collapse
 * whitespace runs, trim, and cap the length. Never returns null.
 */
export function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  let text = value
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
      '',
    )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (text.length > max) text = text.slice(0, max);
  return text;
}

/** Display names are one line, non-empty, and short. */
export function sanitizeName(value) {
  const name = sanitizeText(value, ROOM_LIMITS.nameMax).replace(/\n/g, ' ');
  return name || 'Guest';
}

function finiteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}

/** Validate a camera pose; null when any required component is missing. */
export function sanitizeCamera(camera) {
  if (!camera || typeof camera !== 'object') return null;
  const lon = finiteInRange(camera.lon, -180, 180);
  const lat = finiteInRange(camera.lat, -90, 90);
  const height = finiteInRange(camera.height, -1000, 1e9);
  if (lon === null || lat === null || height === null) return null;
  return {
    lon,
    lat,
    height,
    heading: finiteInRange(camera.heading, -360, 360) ?? 0,
    pitch: finiteInRange(camera.pitch, -90, 90) ?? -90,
    roll: finiteInRange(camera.roll, -360, 360) ?? 0,
  };
}

const LAYER_ID = /^[A-Za-z0-9_.:-]+$/;

function sanitizeLayerIds(layers) {
  if (!Array.isArray(layers)) return [];
  const out = [];
  for (const id of layers) {
    if (
      typeof id === 'string' &&
      id.length <= ROOM_LIMITS.layerIdMax &&
      LAYER_ID.test(id) &&
      !out.includes(id)
    ) {
      out.push(id);
      if (out.length >= ROOM_LIMITS.layersMax) break;
    }
  }
  return out;
}

function sanitizeStyle(style) {
  if (typeof style === 'string')
    return sanitizeText(style, ROOM_LIMITS.stylePrimitiveMax) || null;
  if (!style || typeof style !== 'object' || Array.isArray(style)) return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(style)) {
    if (!LAYER_ID.test(key) || key.length > ROOM_LIMITS.layerIdMax) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string')
      out[key] = sanitizeText(value, ROOM_LIMITS.stylePrimitiveMax);
    else continue;
    count += 1;
    if (count >= ROOM_LIMITS.styleKeysMax) break;
  }
  return count ? out : null;
}

function sanitizeTracked(tracked) {
  if (!tracked || typeof tracked !== 'object') return null;
  const layerId = sanitizeText(tracked.layerId, ROOM_LIMITS.layerIdMax);
  const id = sanitizeText(String(tracked.id ?? ''), ROOM_LIMITS.targetIdMax);
  if (!layerId || !id || !LAYER_ID.test(layerId)) return null;
  const out = { layerId, id };
  if (typeof tracked.label === 'string') {
    const label = sanitizeText(tracked.label, ROOM_LIMITS.labelMax);
    if (label) out.label = label;
  }
  return out;
}

function sanitizeScene(scene) {
  if (!scene || typeof scene !== 'object') return null;
  const id = sanitizeText(scene.id, ROOM_LIMITS.layerIdMax);
  if (!id || !LAYER_ID.test(id)) return null;
  return { id, playing: scene.playing !== false };
}

/**
 * Validate a full view state. Returns null when the camera is unusable; every
 * other field degrades to an empty/neutral value rather than failing.
 */
export function sanitizeViewState(state) {
  if (!state || typeof state !== 'object') return null;
  const camera = sanitizeCamera(state.camera);
  if (!camera) return null;
  return {
    camera,
    style: sanitizeStyle(state.style),
    layers: sanitizeLayerIds(state.layers),
    tracked: sanitizeTracked(state.tracked),
    scene: sanitizeScene(state.scene),
  };
}

/** Validate a ping marker. */
export function sanitizePing(ping) {
  if (!ping || typeof ping !== 'object') return null;
  const lon = finiteInRange(ping.lon, -180, 180);
  const lat = finiteInRange(ping.lat, -90, 90);
  if (lon === null || lat === null) return null;
  return {
    lon,
    lat,
    label: sanitizeText(ping.label, ROOM_LIMITS.labelMax).replace(/\n/g, ' '),
  };
}

/** Build the socket URL for a room from a page location. */
export function roomSocketUrl(location, roomId, { name, token } = {}) {
  const secure = location.protocol === 'https:';
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (token) params.set('token', token);
  const query = params.toString();
  return `${secure ? 'wss' : 'ws'}://${location.host}/api/rooms/${roomId}/ws${query ? `?${query}` : ''}`;
}

/** Build the shareable join link. */
export function roomJoinLink(origin, roomId) {
  return `${origin}/?room=${roomId}`;
}
