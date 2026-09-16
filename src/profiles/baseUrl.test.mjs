import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROFILES_BASE_STORAGE_KEY,
  normalizeProfilesBaseUrl,
  profilesApiUrl,
  readProfilesBaseUrl,
  resolveProfilesBaseUrl,
} from './baseUrl.js';
import { ProfileClient } from './client.js';

test('profiles base URL normalizes to an origin and rejects junk (same rules as rooms)', () => {
  assert.equal(normalizeProfilesBaseUrl(''), '');
  assert.equal(normalizeProfilesBaseUrl(undefined), '');
  assert.equal(
    normalizeProfilesBaseUrl(' https://menorah.tail6d17bb.ts.net:8443/ '),
    'https://menorah.tail6d17bb.ts.net:8443',
  );
  assert.equal(
    normalizeProfilesBaseUrl('http://pi.local:4173/api/profiles'),
    'http://pi.local:4173',
  );
  assert.equal(
    normalizeProfilesBaseUrl('pi.local:4173'),
    '',
    'scheme required',
  );
  assert.equal(normalizeProfilesBaseUrl('ftp://pi.local'), '');
  assert.equal(normalizeProfilesBaseUrl('not a url'), '');
});

test('localStorage.gevProfilesBaseUrl beats VITE_PROFILES_BASE_URL; both fall back to same origin', () => {
  assert.equal(resolveProfilesBaseUrl({}), '');
  assert.equal(
    resolveProfilesBaseUrl({ envValue: 'https://pi.tail1234.ts.net' }),
    'https://pi.tail1234.ts.net',
  );
  assert.equal(
    resolveProfilesBaseUrl({
      envValue: 'https://pi.tail1234.ts.net',
      storageValue: 'http://jetson.local:4173',
    }),
    'http://jetson.local:4173',
  );
  assert.equal(
    resolveProfilesBaseUrl({
      envValue: 'https://pi.tail1234.ts.net',
      storageValue: 'garbage',
    }),
    'https://pi.tail1234.ts.net',
  );
  const storage = {
    getItem: (k) =>
      k === PROFILES_BASE_STORAGE_KEY ? 'https://pi.tail1234.ts.net' : null,
  };
  assert.equal(
    readProfilesBaseUrl({
      env: { VITE_PROFILES_BASE_URL: 'https://other' },
      storage,
    }),
    'https://pi.tail1234.ts.net',
  );
  assert.equal(
    readProfilesBaseUrl({
      env: { VITE_PROFILES_BASE_URL: 'https://other' },
      storage: { getItem: () => null },
    }),
    'https://other',
  );
  assert.equal(
    readProfilesBaseUrl({
      env: undefined,
      storage: {
        getItem() {
          throw new Error('blocked');
        },
      },
    }),
    '',
  );
});

test('API URLs derive from the base and the client sends Bearer + JSON to them', async () => {
  assert.equal(profilesApiUrl('', '/api/profiles/me'), '/api/profiles/me');
  assert.equal(
    profilesApiUrl('https://pi.tail1234.ts.net/', '/api/profiles/login'),
    'https://pi.tail1234.ts.net/api/profiles/login',
  );
  const calls = [];
  const client = new ProfileClient({
    baseUrl: 'https://pi.tail1234.ts.net',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ name: 'S' }) };
    },
  });
  await client.login('S', '1234');
  await client.me('tok');
  await client.update('tok', { defaultStyle: 'nvg' });
  await client.logout('tok');
  await client.revokeAll('tok');
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.url]),
    [
      ['POST', 'https://pi.tail1234.ts.net/api/profiles/login'],
      ['GET', 'https://pi.tail1234.ts.net/api/profiles/me'],
      ['PUT', 'https://pi.tail1234.ts.net/api/profiles/me'],
      ['POST', 'https://pi.tail1234.ts.net/api/profiles/logout'],
      ['POST', 'https://pi.tail1234.ts.net/api/profiles/devices/revoke-all'],
    ],
  );
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.body, JSON.stringify({ name: 'S', pin: '1234' }));
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[2].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[2].init.cache, 'no-store');

  const refused = new ProfileClient({
    fetch: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Wrong PIN', code: 'WRONG_PIN' }),
    }),
  });
  await assert.rejects(
    () => refused.login('S', '0000'),
    (error) => error.status === 401 && error.code === 'WRONG_PIN',
  );
});
