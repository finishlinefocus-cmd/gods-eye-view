/**
 * Where the room server lives. The lab runs three app instances (Pi, Mac,
 * Jetson) that must share one set of rooms, so the client can point its
 * `/api/rooms*` calls and the socket at another instance:
 *
 *   VITE_ROOMS_BASE_URL          build/env (Vite reads it from `.env`)
 *   localStorage.gevRoomsBaseUrl runtime override, wins over the env value
 *
 * Empty / unset → same origin as the page. Pure helpers; no side effects.
 */

export const ROOMS_BASE_STORAGE_KEY = 'gevRoomsBaseUrl';

/** Normalize a candidate base to `scheme://host[:port]` (no path); '' when invalid or empty. */
export function normalizeRoomsBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  // A path prefix is not supported; the routes are fixed at /api/rooms.
  return url.origin;
}

/** Pick the effective base: runtime override, then build env, else same origin (''). */
export function resolveRoomsBaseUrl({ envValue, storageValue } = {}) {
  return (
    normalizeRoomsBaseUrl(storageValue) || normalizeRoomsBaseUrl(envValue) || ''
  );
}

/** Read the base from Vite's env and localStorage in the browser. */
export function readRoomsBaseUrl({
  env = typeof import.meta !== 'undefined' ? import.meta.env : undefined,
  storage = globalThis.localStorage,
} = {}) {
  let storageValue = '';
  try {
    storageValue = storage?.getItem?.(ROOMS_BASE_STORAGE_KEY) || '';
  } catch {
    storageValue = '';
  }
  return resolveRoomsBaseUrl({
    envValue: env?.VITE_ROOMS_BASE_URL,
    storageValue,
  });
}

/** HTTP URL for a rooms API path (`/api/rooms`, `/api/rooms/ABC234`). */
export function roomsApiUrl(baseUrl, path) {
  return `${normalizeRoomsBaseUrl(baseUrl)}${path}`;
}

/**
 * WebSocket URL for a room. With a base, https→wss / http→ws follows the
 * base; without one it follows the page (`location`).
 */
export function roomSocketUrl(location, roomId, { name, token, baseUrl } = {}) {
  const base = normalizeRoomsBaseUrl(baseUrl);
  let secure;
  let host;
  if (base) {
    const url = new URL(base);
    secure = url.protocol === 'https:';
    host = url.host;
  } else {
    secure = location.protocol === 'https:';
    host = location.host;
  }
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (token) params.set('token', token);
  const query = params.toString();
  return `${secure ? 'wss' : 'ws'}://${host}/api/rooms/${roomId}/ws${query ? `?${query}` : ''}`;
}
