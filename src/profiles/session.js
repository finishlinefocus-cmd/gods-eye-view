import { ProfileClient, ProfileHttpError } from './client.js';
import {
  PROFILE_FIELDS,
  cleanText,
  emptyProfileFields,
  findSavedPlace,
  isValidPin,
  newPlaceId,
  normalizeProfileName,
  sanitizeCamera,
  sanitizeProfileFields,
  PROFILE_LIMITS,
} from './schema.js';

/**
 * ProfileSession: the browser-side owner of "who is signed in and what do
 * they prefer". Pure state + an injected `bindings` object that is the only
 * thing touching the running app (style, layers, voice, rooms, camera), so
 * the whole apply/push cycle is testable with fakes.
 *
 *   sign in  → pull → apply (style, favourite layers, voice mode, room name),
 *              offer the home view
 *   tracked local change → mark field dirty → debounced (2 s) PUT of the dirty
 *              fields with per-field stamps → adopt the merged reply
 *   server unreachable → keep working from the local copy, badge "offline",
 *              retry with exponential backoff
 *
 * Only the bearer token and a copy of the profile live in this device's
 * storage. The PIN is never stored.
 */

export const TOKEN_STORAGE_KEY = 'gevProfileToken';
export const CACHE_STORAGE_KEY = 'gevProfileCache';
export const PUSH_DEBOUNCE_MS = 2000;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60_000;

/** Bindings a session needs; every member is optional and defensively called. */
export const NULL_BINDINGS = Object.freeze({
  getStyle: () => null,
  setStyle: () => {},
  getEnabledLayers: () => [],
  enableLayers: () => {},
  getVoiceMode: () => null,
  setVoiceMode: () => {},
  getRoomName: () => '',
  setRoomName: () => {},
  getCamera: () => null,
  flyTo: () => false,
  onChange: () => () => {},
  toast: () => {},
  shareMoment: () => false,
});

function emptyState() {
  return {
    phase: 'signed-out', // signed-out | signing-in | signed-in
    name: '',
    profile: null,
    online: true,
    syncing: false,
    dirty: [],
    lastSyncAt: null,
    lastError: null,
    notice: null,
    homeAvailable: false,
    devices: 0,
    remember: true,
  };
}

export function retryDelay(attempt, random = Math.random) {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.round(exp * (0.8 + random() * 0.4));
}

/** Layer ids to enable on apply: favourites not already on. */
export function layersToEnable(favorites, enabled) {
  const on = new Set(enabled || []);
  return (favorites || []).filter((id) => !on.has(id));
}

function isOfflineError(error) {
  return !(error instanceof ProfileHttpError);
}

export class ProfileSession {
  constructor({
    baseUrl = '',
    bindings = {},
    client = null,
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    storage = globalThis.localStorage,
    sessionStorage: sessionStore = globalThis.sessionStorage,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    now = Date.now,
    random = Math.random,
  } = {}) {
    this._bindings = { ...NULL_BINDINGS, ...bindings };
    this._client = client || new ProfileClient({ baseUrl, fetch: fetchImpl });
    this._storage = storage;
    this._session = sessionStore;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._now = now;
    this._random = random;
    this._listeners = new Set();
    this._token = null;
    this._dirty = new Map(); // field → stamp
    this._pushTimer = null;
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._applying = false;
    this._changeDispose = null;
    this._destroyed = false;
    this.state = emptyState();
  }

  /* ── observation ─────────────────────────────────────────────────────── */

  subscribe(listener) {
    this._listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      /* no-op */
    }
    return () => this._listeners.delete(listener);
  }

  _update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this._listeners]) {
      try {
        listener(this.state);
      } catch (error) {
        console.warn('[profiles] subscriber failed', error);
      }
    }
  }

  get signedIn() {
    return this.state.phase === 'signed-in' && Boolean(this._token);
  }

  get profile() {
    return this.state.profile;
  }

  get savedPlaces() {
    return this.state.profile?.savedPlaces || [];
  }

  get baseUrl() {
    return this._client.baseUrl;
  }

  /* ── storage ─────────────────────────────────────────────────────────── */

  _read(store, key) {
    try {
      return store?.getItem?.(key) || null;
    } catch {
      return null;
    }
  }

  _write(store, key, value) {
    try {
      if (value === null || value === undefined) store?.removeItem?.(key);
      else store?.setItem?.(key, value);
    } catch {
      /* private mode / quota */
    }
  }

  _storedToken() {
    return (
      this._read(this._storage, TOKEN_STORAGE_KEY) ||
      this._read(this._session, TOKEN_STORAGE_KEY)
    );
  }

  _storeToken(token, remember) {
    this._write(this._storage, TOKEN_STORAGE_KEY, remember ? token : null);
    this._write(this._session, TOKEN_STORAGE_KEY, remember ? null : token);
  }

  _readCache() {
    const raw = this._read(this._storage, CACHE_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return this._normalizeProfile(parsed);
    } catch {
      return null;
    }
  }

  _writeCache(profile) {
    this._write(
      this._storage,
      CACHE_STORAGE_KEY,
      profile ? JSON.stringify(profile) : null,
    );
  }

  _normalizeProfile(raw) {
    return {
      id: String(raw.id || ''),
      name: normalizeProfileName(raw.name),
      updatedAt: Number(raw.updatedAt) || 0,
      devices: Number(raw.devices) || 0,
      fieldUpdatedAt:
        raw.fieldUpdatedAt && typeof raw.fieldUpdatedAt === 'object'
          ? { ...raw.fieldUpdatedAt }
          : {},
      ...sanitizeProfileFields(raw),
    };
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */

  /**
   * Resume a remembered sign-in: apply the cached profile immediately (so the
   * app looks right even offline), then refresh from the server.
   */
  async start() {
    const token = this._storedToken();
    if (!token) return false;
    this._token = token;
    const remember = Boolean(this._read(this._storage, TOKEN_STORAGE_KEY));
    const cached = this._readCache();
    this._update({
      phase: 'signed-in',
      name: cached?.name || '',
      profile: cached,
      devices: cached?.devices || 0,
      remember,
      homeAvailable: Boolean(cached?.homeView?.camera),
    });
    if (cached) this._apply(cached, { announce: false });
    this._startTracking();
    await this._pull({ announce: true });
    return this.signedIn;
  }

  async login(name, pin, { remember = true } = {}) {
    const display = normalizeProfileName(name);
    if (!display) throw new Error('Enter a name');
    if (!isValidPin(pin)) {
      throw new Error(
        `PIN must be ${PROFILE_LIMITS.pinMin}-${PROFILE_LIMITS.pinMax} digits`,
      );
    }
    if (!this._client.available) throw new Error('fetch unavailable');
    this._update({ phase: 'signing-in', lastError: null });
    let result;
    try {
      result = await this._client.login(display, String(pin));
    } catch (error) {
      this._update({ phase: 'signed-out' });
      if (error instanceof ProfileHttpError) {
        if (error.status === 401) throw new Error('Wrong PIN for that name');
        if (error.status === 429)
          throw new Error('Too many attempts — wait a minute');
        throw new Error(error.message || 'Sign-in failed');
      }
      throw new Error('Profile server unreachable');
    }
    this._token = result.token;
    this._storeToken(result.token, remember);
    const profile = this._normalizeProfile(result.profile || {});
    this._writeCache(profile);
    this._dirty.clear();
    this._update({
      phase: 'signed-in',
      name: profile.name,
      profile,
      devices: profile.devices,
      online: true,
      remember,
      lastSyncAt: this._now(),
      lastError: null,
      homeAvailable: Boolean(profile.homeView?.camera),
      notice: result.created
        ? `Profile "${profile.name}" created`
        : `Signed in as ${profile.name}`,
    });
    this._apply(profile, { announce: true });
    this._startTracking();
    // A brand-new profile adopts this device's current preferences.
    if (result.created) this._seedFromDevice();
    return profile;
  }

  /** Copy the device's current state into an empty profile (first sign-in). */
  _seedFromDevice() {
    const b = this._bindings;
    const style = b.getStyle();
    if (style) this._markDirty('defaultStyle', style);
    const layers = b.getEnabledLayers() || [];
    if (layers.length) this._markDirty('favoriteLayers', [...layers]);
    const voice = b.getVoiceMode();
    if (voice) this._markDirty('voice', { mode: voice });
    const roomName = cleanText(b.getRoomName(), PROFILE_LIMITS.nameMax);
    if (roomName) {
      this._markDirty('displayName', roomName);
    } else {
      // No room name yet: the profile name doubles as it.
      this._markDirty('displayName', this.state.name);
      b.setRoomName(this.state.name);
    }
  }

  async logout({ everywhere = false, reason = null } = {}) {
    const token = this._token;
    this._stopTracking();
    this._clearTimer(this._pushTimer);
    this._clearTimer(this._retryTimer);
    this._pushTimer = this._retryTimer = null;
    this._dirty.clear();
    this._token = null;
    this._storeToken(null, true);
    this._writeCache(null);
    const name = this.state.name;
    this._update({
      ...emptyState(),
      notice:
        reason ||
        (everywhere
          ? `Signed out of ${name} everywhere`
          : `Signed out of ${name}`),
    });
    if (!token) return;
    try {
      if (everywhere) await this._client.revokeAll(token);
      else await this._client.logout(token);
    } catch {
      /* Token is gone locally either way; it expires server-side in 180 days. */
    }
  }

  destroy() {
    this._destroyed = true;
    this._stopTracking();
    this._clearTimer(this._pushTimer);
    this._clearTimer(this._retryTimer);
    this._listeners.clear();
  }

  /* ── pull / apply ────────────────────────────────────────────────────── */

  async _pull({ announce = false } = {}) {
    if (!this._token) return null;
    let raw;
    try {
      raw = await this._client.me(this._token);
    } catch (error) {
      if (error instanceof ProfileHttpError && error.status === 401) {
        await this.logout({
          reason: 'Profile session expired — sign in again',
        });
        return null;
      }
      this._goOffline(error);
      return null;
    }
    const profile = this._normalizeProfile(raw || {});
    this._adopt(profile);
    this._apply(profile, { announce });
    return profile;
  }

  syncNow() {
    this._clearTimer(this._pushTimer);
    this._pushTimer = null;
    if (this._dirty.size) return this._push();
    return this._pull();
  }

  _adopt(profile) {
    this._writeCache(profile);
    this._retryAttempt = 0;
    this._update({
      profile,
      name: profile.name || this.state.name,
      devices: profile.devices,
      online: true,
      lastSyncAt: this._now(),
      lastError: null,
      homeAvailable: Boolean(profile.homeView?.camera),
    });
  }

  /** Push the profile's preferences into the app without echoing them back. */
  _apply(profile, { announce = false } = {}) {
    if (!profile) return;
    const b = this._bindings;
    this._applying = true;
    try {
      if (profile.defaultStyle && b.getStyle() !== profile.defaultStyle) {
        b.setStyle(profile.defaultStyle);
      }
      const missing = layersToEnable(
        profile.favoriteLayers,
        b.getEnabledLayers(),
      );
      if (missing.length) b.enableLayers(missing);
      if (profile.voice?.mode && b.getVoiceMode() !== profile.voice.mode) {
        b.setVoiceMode(profile.voice.mode);
      }
      const roomName = profile.displayName || profile.roomName;
      if (roomName && b.getRoomName() !== roomName) b.setRoomName(roomName);
    } catch (error) {
      console.warn('[profiles] apply failed', error);
    } finally {
      // Layer/style side effects can land a tick later; keep ignoring them briefly.
      this._setTimer(() => {
        this._applying = false;
      }, 50);
    }
    if (announce && profile.homeView?.camera) {
      b.toast(`Welcome back, ${profile.name} — home view is in PROFILE`);
    }
  }

  /* ── tracking local changes → push ───────────────────────────────────── */

  _startTracking() {
    if (this._changeDispose) return;
    this._changeDispose = this._bindings.onChange((field, value) =>
      this._onLocalChange(field, value),
    );
  }

  _stopTracking() {
    this._changeDispose?.();
    this._changeDispose = null;
  }

  _onLocalChange(field, value) {
    if (!this.signedIn || this._applying) return;
    switch (field) {
      case 'style':
        if (value) this._markDirty('defaultStyle', String(value));
        break;
      case 'layers':
        this._markDirty('favoriteLayers', [...(value || [])]);
        break;
      case 'voice':
        if (value) this._markDirty('voice', { mode: String(value) });
        break;
      case 'roomName': {
        const name = cleanText(value, PROFILE_LIMITS.nameMax);
        if (name) this._markDirty('displayName', name);
        break;
      }
      default:
        if (PROFILE_FIELDS.includes(field)) this._markDirty(field, value);
    }
  }

  _markDirty(field, value) {
    if (!this.signedIn) return;
    const stamp = this._now();
    const profile = { ...(this.state.profile || emptyProfileFields()) };
    profile[field] = value;
    profile.fieldUpdatedAt = {
      ...(profile.fieldUpdatedAt || {}),
      [field]: stamp,
    };
    this._dirty.set(field, stamp);
    this._writeCache(profile);
    this._update({
      profile,
      dirty: [...this._dirty.keys()],
      homeAvailable: Boolean(profile.homeView?.camera),
    });
    this._schedulePush();
  }

  _schedulePush(delay = PUSH_DEBOUNCE_MS) {
    this._clearTimer(this._pushTimer);
    this._pushTimer = this._setTimer(() => {
      this._pushTimer = null;
      void this._push();
    }, delay);
  }

  async _push() {
    if (!this._token || !this._dirty.size || this._destroyed) return null;
    if (this.state.syncing) {
      this._schedulePush(300);
      return null;
    }
    const profile = this.state.profile || {};
    const body = { fieldUpdatedAt: {} };
    const sent = new Map();
    for (const [field, stamp] of this._dirty) {
      body[field] = profile[field];
      body.fieldUpdatedAt[field] = stamp;
      sent.set(field, stamp);
    }
    this._update({ syncing: true });
    try {
      const raw = await this._client.update(this._token, body);
      // Drop only the dirty marks we actually sent; later edits stay queued.
      for (const [field, stamp] of sent) {
        if (this._dirty.get(field) === stamp) this._dirty.delete(field);
      }
      const merged = this._normalizeProfile(raw || {});
      // Keep still-dirty local values on top of the merged reply.
      for (const field of this._dirty.keys()) {
        merged[field] = this.state.profile?.[field];
        merged.fieldUpdatedAt[field] = this._dirty.get(field);
      }
      this._adopt(merged);
      this._update({ syncing: false, dirty: [...this._dirty.keys()] });
      if (this._dirty.size) this._schedulePush(300);
      return merged;
    } catch (error) {
      this._update({ syncing: false });
      if (error instanceof ProfileHttpError) {
        if (error.status === 401) {
          await this.logout({
            reason: 'Profile session expired — sign in again',
          });
          return null;
        }
        // 400/413: our payload is bad; drop it rather than retry forever.
        this._dirty.clear();
        this._update({
          dirty: [],
          lastError: error.message,
          notice: `Profile sync refused: ${error.message}`,
        });
        return null;
      }
      this._goOffline(error);
      return null;
    }
  }

  _goOffline(error) {
    this._update({
      online: false,
      lastError: error?.message || 'Profile server unreachable',
    });
    const delay = retryDelay(this._retryAttempt, this._random);
    this._retryAttempt += 1;
    this._clearTimer(this._retryTimer);
    this._retryTimer = this._setTimer(() => {
      this._retryTimer = null;
      void this.syncNow();
    }, delay);
  }

  /* ── saved places & home ─────────────────────────────────────────────── */

  _currentCamera() {
    const camera = this._bindings.getCamera();
    if (!camera) return null;
    try {
      return sanitizeCamera(camera, 'camera');
    } catch {
      return null;
    }
  }

  /** Store the current view as a named place; returns the place or null. */
  savePlace(name, { note = '' } = {}) {
    if (!this.signedIn) return null;
    const clean = cleanText(name, PROFILE_LIMITS.placeNameMax);
    if (!clean) return null;
    const camera = this._currentCamera();
    if (!camera) return null;
    const existing = this.savedPlaces.find(
      (place) => place.name.toLocaleLowerCase() === clean.toLocaleLowerCase(),
    );
    const place = {
      id: existing?.id || newPlaceId(this._random, this._now),
      name: existing?.name || clean,
      ...camera,
      ...(cleanText(note, PROFILE_LIMITS.placeNoteMax)
        ? { note: cleanText(note, PROFILE_LIMITS.placeNoteMax) }
        : {}),
      createdAt: existing?.createdAt || this._now(),
    };
    const places = existing
      ? this.savedPlaces.map((p) => (p.id === existing.id ? place : p))
      : [...this.savedPlaces, place].slice(-PROFILE_LIMITS.savedPlacesMax);
    this._markDirty('savedPlaces', places);
    this._update({
      notice: existing ? `Updated "${clean}"` : `Saved "${clean}"`,
    });
    return place;
  }

  deletePlace(id) {
    if (!this.signedIn) return false;
    const before = this.savedPlaces;
    const after = before.filter((place) => place.id !== id);
    if (after.length === before.length) return false;
    this._markDirty('savedPlaces', after);
    return true;
  }

  findPlace(query) {
    if (
      typeof query === 'string' &&
      this.savedPlaces.some((p) => p.id === query)
    ) {
      return this.savedPlaces.find((p) => p.id === query);
    }
    return findSavedPlace(this.savedPlaces, query);
  }

  flyToPlace(idOrName) {
    const place =
      typeof idOrName === 'object' ? idOrName : this.findPlace(idOrName);
    if (!place) return null;
    const flown = this._bindings.flyTo(place);
    return flown === false ? null : place;
  }

  setHome() {
    if (!this.signedIn) return false;
    const camera = this._currentCamera();
    if (!camera) return false;
    this._markDirty('homeView', { camera });
    this._update({ notice: 'Home view set' });
    return true;
  }

  goHome() {
    const camera = this.state.profile?.homeView?.camera;
    if (!camera) return false;
    return this._bindings.flyTo({ ...camera, name: 'Home' }) !== false;
  }

  /** Share a saved place with the current room as a moment (rooms integration). */
  sharePlace(id) {
    const place = this.findPlace(id);
    if (!place) return false;
    return this._bindings.shareMoment(place) !== false;
  }

  clearNotice() {
    if (this.state.notice) this._update({ notice: null });
  }
}
