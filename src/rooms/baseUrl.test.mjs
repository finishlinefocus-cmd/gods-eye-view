import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOMS_BASE_STORAGE_KEY,
  normalizeRoomsBaseUrl,
  readRoomsBaseUrl,
  resolveRoomsBaseUrl,
  roomSocketUrl,
  roomsApiUrl,
} from './baseUrl.js';
import { RoomClient } from './client.js';
import { RoomSession } from './session.js';

const PAGE = {
  protocol: 'https:',
  host: 'mac.tail1234.ts.net',
  origin: 'https://mac.tail1234.ts.net',
};

test('base URL normalizes to an origin and rejects junk', () => {
  assert.equal(normalizeRoomsBaseUrl(''), '');
  assert.equal(normalizeRoomsBaseUrl(undefined), '');
  assert.equal(
    normalizeRoomsBaseUrl(' https://pi.tail1234.ts.net/ '),
    'https://pi.tail1234.ts.net',
  );
  assert.equal(
    normalizeRoomsBaseUrl('http://pi.local:4173/api/rooms'),
    'http://pi.local:4173',
  );
  assert.equal(normalizeRoomsBaseUrl('pi.local:4173'), '', 'scheme required');
  assert.equal(normalizeRoomsBaseUrl('ftp://pi.local'), '');
  assert.equal(normalizeRoomsBaseUrl('not a url'), '');
});

test('runtime localStorage override beats the build env; both fall back to same origin', () => {
  assert.equal(resolveRoomsBaseUrl({}), '');
  assert.equal(
    resolveRoomsBaseUrl({ envValue: 'https://pi.tail1234.ts.net' }),
    'https://pi.tail1234.ts.net',
  );
  assert.equal(
    resolveRoomsBaseUrl({
      envValue: 'https://pi.tail1234.ts.net',
      storageValue: 'http://jetson.local:4173',
    }),
    'http://jetson.local:4173',
  );
  assert.equal(
    resolveRoomsBaseUrl({
      envValue: 'https://pi.tail1234.ts.net',
      storageValue: 'garbage',
    }),
    'https://pi.tail1234.ts.net',
  );
  const storage = {
    getItem: (k) =>
      k === ROOMS_BASE_STORAGE_KEY ? 'https://pi.tail1234.ts.net' : null,
  };
  assert.equal(
    readRoomsBaseUrl({
      env: { VITE_ROOMS_BASE_URL: 'https://other' },
      storage,
    }),
    'https://pi.tail1234.ts.net',
  );
  assert.equal(
    readRoomsBaseUrl({
      env: { VITE_ROOMS_BASE_URL: 'https://other' },
      storage: { getItem: () => null },
    }),
    'https://other',
  );
  assert.equal(
    readRoomsBaseUrl({
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

test('API and socket URLs derive from the base (https→wss, http→ws) or from the page', () => {
  assert.equal(roomsApiUrl('', '/api/rooms'), '/api/rooms');
  assert.equal(
    roomsApiUrl('https://pi.tail1234.ts.net/', '/api/rooms/ABC234'),
    'https://pi.tail1234.ts.net/api/rooms/ABC234',
  );
  assert.equal(
    roomSocketUrl(PAGE, 'ABC234', { name: 'Bob' }),
    'wss://mac.tail1234.ts.net/api/rooms/ABC234/ws?name=Bob',
  );
  assert.equal(
    roomSocketUrl(PAGE, 'ABC234', {
      name: 'Bob',
      baseUrl: 'https://pi.tail1234.ts.net',
    }),
    'wss://pi.tail1234.ts.net/api/rooms/ABC234/ws?name=Bob',
  );
  assert.equal(
    roomSocketUrl(PAGE, 'ABC234', {
      name: 'Bob',
      token: 't/1',
      baseUrl: 'http://jetson.local:4173',
    }),
    'ws://jetson.local:4173/api/rooms/ABC234/ws?name=Bob&token=t%2F1',
  );
  assert.equal(
    roomSocketUrl({ protocol: 'http:', host: 'localhost:4176' }, 'ABC234', {}),
    'ws://localhost:4176/api/rooms/ABC234/ws',
  );
});

test('RoomClient and RoomSession honour the base URL end to end', async () => {
  const client = new RoomClient({
    roomId: 'ABC234',
    name: 'Bob',
    baseUrl: 'https://pi.tail1234.ts.net',
    location: PAGE,
    WebSocketImpl: null,
  });
  assert.equal(
    client.url,
    'wss://pi.tail1234.ts.net/api/rooms/ABC234/ws?name=Bob',
  );

  const fetched = [];
  const clients = [];
  const session = new RoomSession({
    view: {
      getState: () => null,
      applyState() {},
      onManualMove: () => () => {},
    },
    baseUrl: 'https://pi.tail1234.ts.net',
    location: { ...PAGE, href: PAGE.origin + '/' },
    storage: { getItem: () => null, setItem() {} },
    fetchImpl: async (url, init = {}) => {
      fetched.push(`${init.method || 'GET'} ${url}`);
      return {
        ok: true,
        status: init.method === 'POST' ? 201 : 200,
        json: async () => ({ roomId: 'ABC234', joinToken: 'tok' }),
      };
    },
    createClient: (options) => {
      clients.push(options);
      return {
        on: () => () => {},
        connect() {},
        close() {},
        send: () => true,
        open: true,
      };
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  await session.create('Alice');
  assert.deepEqual(fetched, [
    'POST https://pi.tail1234.ts.net/api/rooms',
    'GET https://pi.tail1234.ts.net/api/rooms/ABC234',
  ]);
  assert.equal(clients[0].baseUrl, 'https://pi.tail1234.ts.net');
  // The share link still points at THIS page, not at the room server.
  assert.equal(session.joinLink, 'https://mac.tail1234.ts.net/?room=ABC234');
  assert.equal(
    session.apiUrl('/api/rooms'),
    'https://pi.tail1234.ts.net/api/rooms',
  );
});
