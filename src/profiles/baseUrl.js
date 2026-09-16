/**
 * Where the profile server lives. The lab's three app instances (Pi, Mac,
 * Jetson) share one profile store on the Pi, so the client can point its
 * `/api/profiles*` calls at another instance — the same shape as rooms:
 *
 *   VITE_PROFILES_BASE_URL          build/env (Vite reads it from `.env`)
 *   localStorage.gevProfilesBaseUrl runtime override, wins over the env value
 *
 * Empty / unset → same origin as the page. Pure helpers; no side effects.
 */

export const PROFILES_BASE_STORAGE_KEY = 'gevProfilesBaseUrl';

/** Normalize a candidate base to `scheme://host[:port]` (no path); '' when invalid or empty. */
export function normalizeProfilesBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.origin;
}

/** Pick the effective base: runtime override, then build env, else same origin (''). */
export function resolveProfilesBaseUrl({ envValue, storageValue } = {}) {
  return (
    normalizeProfilesBaseUrl(storageValue) ||
    normalizeProfilesBaseUrl(envValue) ||
    ''
  );
}

/** Read the base from Vite's env and localStorage in the browser. */
export function readProfilesBaseUrl({
  env = typeof import.meta !== 'undefined' ? import.meta.env : undefined,
  storage = globalThis.localStorage,
} = {}) {
  let storageValue = '';
  try {
    storageValue = storage?.getItem?.(PROFILES_BASE_STORAGE_KEY) || '';
  } catch {
    storageValue = '';
  }
  return resolveProfilesBaseUrl({
    envValue: env?.VITE_PROFILES_BASE_URL,
    storageValue,
  });
}

/** HTTP URL for a profiles API path (`/api/profiles/login`, `/api/profiles/me`). */
export function profilesApiUrl(baseUrl, path) {
  return `${normalizeProfilesBaseUrl(baseUrl)}${path}`;
}
