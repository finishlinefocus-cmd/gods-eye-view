import { profilesApiUrl } from './baseUrl.js';

/**
 * Thin HTTP client for `/api/profiles*`. Knows nothing about the app; the
 * session decides what to do with the answers. Every method resolves to
 * `{ ok, status, body }` and only rejects on a network failure (so the caller
 * can tell "offline" from "refused").
 */

export class ProfileHttpError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.name = 'ProfileHttpError';
    this.status = status;
    this.code = body?.code || null;
    this.body = body || null;
  }
}

export class ProfileClient {
  constructor({
    baseUrl = '',
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    this.baseUrl = baseUrl;
    this._fetch = fetchImpl;
  }

  get available() {
    return typeof this._fetch === 'function';
  }

  url(path) {
    return profilesApiUrl(this.baseUrl, path);
  }

  async _request(method, path, { token = null, body = undefined } = {}) {
    if (!this._fetch) throw new Error('fetch unavailable');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this._fetch(this.url(path), {
      method,
      headers,
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) throw new ProfileHttpError(response.status, parsed);
    return parsed;
  }

  login(name, pin) {
    return this._request('POST', '/api/profiles/login', {
      body: { name, pin },
    });
  }

  me(token) {
    return this._request('GET', '/api/profiles/me', { token });
  }

  update(token, fields) {
    return this._request('PUT', '/api/profiles/me', { token, body: fields });
  }

  logout(token) {
    return this._request('POST', '/api/profiles/logout', { token });
  }

  revokeAll(token) {
    return this._request('POST', '/api/profiles/devices/revoke-all', { token });
  }
}
