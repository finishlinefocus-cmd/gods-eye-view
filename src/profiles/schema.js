/**
 * Profile schema shared by the server (validation on PUT) and the browser
 * (validation before push, sanitising the local copy). Pure functions, no I/O.
 *
 * A profile is the small set of preferences that follow a person between the
 * lab's devices: default visual style, favourite layers, voice mode, the name
 * used in rooms, a home view and saved places. Never keys or secrets.
 */

export const PROFILE_LIMITS = Object.freeze({
  nameMax: 32,
  pinMin: 4,
  pinMax: 8,
  bodyBytesMax: 64 * 1024,
  savedPlacesMax: 200,
  placeNameMax: 80,
  placeNoteMax: 280,
  favoriteLayersMax: 64,
  layerIdMax: 64,
  styleIdMax: 40,
  atcFavoritesMax: 64,
  atcFavoriteMax: 80,
  themeMax: 32,
  tokenDays: 180,
});

export const VOICE_MODES = Object.freeze(['local', 'openai', 'off']);

/** Fields a PUT may carry and a merge tracks individually. */
export const PROFILE_FIELDS = Object.freeze([
  'savedPlaces',
  'favoriteLayers',
  'defaultStyle',
  'voice',
  'displayName',
  'roomName',
  'homeView',
  'atcFavorites',
  'theme',
]);

export class ProfileValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ProfileValidationError';
    this.code = 'INVALID_PROFILE';
    this.status = 400;
    this.field = field;
  }
}

/* ── strings ──────────────────────────────────────────────────────────── */

/** Strip control characters and collapse whitespace; cap the length. */
export function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Display form of a profile name: trimmed, ≤32 chars. '' when unusable. */
export function normalizeProfileName(value) {
  return cleanText(value, PROFILE_LIMITS.nameMax);
}

/** Case-insensitive identity of a profile name (unique key). */
export function profileNameKey(value) {
  return normalizeProfileName(value).toLocaleLowerCase('en-US');
}

export function isValidPin(value) {
  const pin = String(value ?? '');
  return (
    pin.length >= PROFILE_LIMITS.pinMin &&
    pin.length <= PROFILE_LIMITS.pinMax &&
    /^[0-9]+$/.test(pin)
  );
}

/* ── numbers ──────────────────────────────────────────────────────────── */

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Camera pose: lon/lat required; height/heading/pitch/roll optional. */
export function sanitizeCamera(input, field = 'camera') {
  if (!input || typeof input !== 'object') {
    throw new ProfileValidationError(`${field} must be an object`, field);
  }
  const lat = finite(input.lat);
  const lon = finite(input.lon);
  if (
    lat === null ||
    lon === null ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new ProfileValidationError(`${field} needs lat/lon in range`, field);
  }
  const camera = { lat: round(lat, 6), lon: round(lon, 6) };
  const height = finite(input.height);
  if (height !== null)
    camera.height = round(clamp(height, -500, 50_000_000), 2);
  const heading = finite(input.heading);
  if (heading !== null)
    camera.heading = round(((heading % 360) + 360) % 360, 3);
  const pitch = finite(input.pitch);
  if (pitch !== null) camera.pitch = round(clamp(pitch, -90, 90), 3);
  const roll = finite(input.roll);
  if (roll !== null) camera.roll = round(clamp(roll, -180, 180), 3);
  return camera;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/* ── ids ──────────────────────────────────────────────────────────────── */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function isPlaceId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

let placeIdCounter = 0;

/** Random-enough id for a saved place without depending on crypto; unique within a session. */
export function newPlaceId(random = Math.random, now = Date.now) {
  const t = now().toString(36);
  const r = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  placeIdCounter = (placeIdCounter + 1) % 1296;
  return `p${t}${r}${placeIdCounter.toString(36).padStart(2, '0')}`;
}

/* ── per-field sanitisers ─────────────────────────────────────────────── */

export function sanitizeSavedPlace(input, index = 0) {
  const field = `savedPlaces[${index}]`;
  if (!input || typeof input !== 'object') {
    throw new ProfileValidationError(`${field} must be an object`, field);
  }
  if (!isPlaceId(input.id)) {
    throw new ProfileValidationError(`${field}.id is invalid`, `${field}.id`);
  }
  const name = cleanText(input.name, PROFILE_LIMITS.placeNameMax);
  if (!name) {
    throw new ProfileValidationError(
      `${field}.name is required`,
      `${field}.name`,
    );
  }
  const camera = sanitizeCamera(input, field);
  const place = { id: input.id, name, ...camera };
  const note = cleanText(input.note, PROFILE_LIMITS.placeNoteMax);
  if (note) place.note = note;
  const createdAt = finite(input.createdAt);
  if (createdAt !== null && createdAt > 0)
    place.createdAt = Math.round(createdAt);
  return place;
}

export function sanitizeSavedPlaces(input) {
  if (!Array.isArray(input)) {
    throw new ProfileValidationError(
      'savedPlaces must be an array',
      'savedPlaces',
    );
  }
  if (input.length > PROFILE_LIMITS.savedPlacesMax) {
    throw new ProfileValidationError(
      `savedPlaces is capped at ${PROFILE_LIMITS.savedPlacesMax}`,
      'savedPlaces',
    );
  }
  const seen = new Set();
  const places = [];
  input.forEach((entry, index) => {
    const place = sanitizeSavedPlace(entry, index);
    if (seen.has(place.id)) return; // keep the first of duplicate ids
    seen.add(place.id);
    places.push(place);
  });
  return places;
}

function sanitizeStringList(input, field, { max, itemMax }) {
  if (!Array.isArray(input)) {
    throw new ProfileValidationError(`${field} must be an array`, field);
  }
  if (input.length > max) {
    throw new ProfileValidationError(`${field} is capped at ${max}`, field);
  }
  const out = [];
  for (const item of input) {
    if (typeof item !== 'string') {
      throw new ProfileValidationError(
        `${field} entries must be strings`,
        field,
      );
    }
    const clean = cleanText(item, itemMax);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

export function sanitizeFavoriteLayers(input) {
  return sanitizeStringList(input, 'favoriteLayers', {
    max: PROFILE_LIMITS.favoriteLayersMax,
    itemMax: PROFILE_LIMITS.layerIdMax,
  });
}

export function sanitizeAtcFavorites(input) {
  return sanitizeStringList(input, 'atcFavorites', {
    max: PROFILE_LIMITS.atcFavoritesMax,
    itemMax: PROFILE_LIMITS.atcFavoriteMax,
  });
}

export function sanitizeVoice(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object') {
    throw new ProfileValidationError('voice must be an object', 'voice');
  }
  const mode = String(input.mode || '');
  if (!VOICE_MODES.includes(mode)) {
    throw new ProfileValidationError(
      `voice.mode must be one of ${VOICE_MODES.join(', ')}`,
      'voice.mode',
    );
  }
  return { mode };
}

export function sanitizeHomeView(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object') {
    throw new ProfileValidationError('homeView must be an object', 'homeView');
  }
  return { camera: sanitizeCamera(input.camera, 'homeView.camera') };
}

function sanitizeOptionalString(input, field, max) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new ProfileValidationError(`${field} must be a string`, field);
  }
  return cleanText(input, max) || null;
}

const FIELD_SANITIZERS = Object.freeze({
  savedPlaces: sanitizeSavedPlaces,
  favoriteLayers: sanitizeFavoriteLayers,
  defaultStyle: (v) =>
    sanitizeOptionalString(v, 'defaultStyle', PROFILE_LIMITS.styleIdMax),
  voice: sanitizeVoice,
  displayName: (v) =>
    sanitizeOptionalString(v, 'displayName', PROFILE_LIMITS.nameMax),
  roomName: (v) =>
    sanitizeOptionalString(v, 'roomName', PROFILE_LIMITS.nameMax),
  homeView: sanitizeHomeView,
  atcFavorites: sanitizeAtcFavorites,
  theme: (v) => sanitizeOptionalString(v, 'theme', PROFILE_LIMITS.themeMax),
});

/**
 * Validate a partial profile update. Unknown keys are rejected so a typo does
 * not silently vanish; `updatedAt` / `fieldUpdatedAt` are the merge metadata.
 * Returns `{ fields, fieldUpdatedAt }` with only the fields present.
 */
export function sanitizeProfileUpdate(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileValidationError('profile update must be a JSON object');
  }
  const fields = {};
  const fieldUpdatedAt = {};
  const stamps =
    input.fieldUpdatedAt && typeof input.fieldUpdatedAt === 'object'
      ? input.fieldUpdatedAt
      : {};
  for (const key of Object.keys(input)) {
    if (key === 'updatedAt' || key === 'fieldUpdatedAt') continue;
    if (key === 'name' || key === 'id' || key === 'devices') continue; // read-only
    const sanitize = FIELD_SANITIZERS[key];
    if (!sanitize) {
      throw new ProfileValidationError(`unknown profile field: ${key}`, key);
    }
    fields[key] = sanitize(input[key]);
    const stamp = finite(stamps[key]);
    fieldUpdatedAt[key] =
      stamp !== null && stamp > 0 ? Math.min(Math.round(stamp), now) : now;
  }
  return { fields, fieldUpdatedAt };
}

/** The empty profile body every new profile starts from. */
export function emptyProfileFields() {
  return {
    savedPlaces: [],
    favoriteLayers: [],
    defaultStyle: null,
    voice: null,
    displayName: null,
    roomName: null,
    homeView: null,
    atcFavorites: [],
    theme: null,
  };
}

/**
 * Last-write-wins merge by field. `current` is the stored profile
 * (`fields` + `fieldUpdatedAt`), `update` the sanitised PUT. A field is taken
 * from the update when its stamp is at least as new as the stored one.
 */
export function mergeProfileFields(current, update) {
  const fields = { ...emptyProfileFields(), ...(current.fields || {}) };
  const fieldUpdatedAt = { ...(current.fieldUpdatedAt || {}) };
  const applied = [];
  for (const [key, value] of Object.entries(update.fields || {})) {
    const incoming = update.fieldUpdatedAt?.[key] ?? 0;
    const existing = fieldUpdatedAt[key] ?? 0;
    if (incoming >= existing) {
      fields[key] = value;
      fieldUpdatedAt[key] = incoming;
      applied.push(key);
    }
  }
  return { fields, fieldUpdatedAt, applied };
}

/** Sanitize a whole stored/cached profile body; drops anything malformed. */
export function sanitizeProfileFields(input) {
  const out = emptyProfileFields();
  if (!input || typeof input !== 'object') return out;
  for (const key of PROFILE_FIELDS) {
    if (!(key in input)) continue;
    try {
      out[key] = FIELD_SANITIZERS[key](input[key]);
    } catch {
      /* keep the default */
    }
  }
  return out;
}

/* ── saved place matching (voice) ─────────────────────────────────────── */

function foldName(value) {
  return cleanText(value, 200)
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '')
    .replace(/^(the|my|our)\s+/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the saved place a spoken/typed query names. Exact (folded) match wins,
 * then a query that contains the whole place name or vice versa, longest name
 * first so "office roof" beats "office". Null when nothing plausible matches.
 */
export function findSavedPlace(places, query) {
  const wanted = foldName(query);
  if (!wanted || !Array.isArray(places) || !places.length) return null;
  const candidates = places
    .map((place) => ({ place, name: foldName(place?.name) }))
    .filter((entry) => entry.name);
  const exact = candidates.find((entry) => entry.name === wanted);
  if (exact) return exact.place;
  const partial = candidates
    .filter(
      (entry) =>
        entry.name.length >= 3 &&
        (wanted.includes(entry.name) ||
          (entry.name.includes(wanted) && wanted.length >= 3)),
    )
    .sort((a, b) => b.name.length - a.name.length);
  return partial[0]?.place || null;
}
