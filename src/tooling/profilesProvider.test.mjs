import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  allowedOriginsFromEnv,
  bearerToken,
  corsHeaders,
  createProfileStore,
  createProfilesMiddleware,
  profileFileKey,
  profilesDirFromEnv,
  profilesProvider,
} from '../../server/providers/profiles.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import { PROFILE_LIMITS } from '../profiles/schema.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gev-profiles-'));
}

function makeStore(overrides = {}) {
  const dir = tempDir();
  const lines = [];
  let t = Date.now();
  const store = createProfileStore({
    dir,
    now: () => t,
    log: (line) => lines.push(line),
    ...overrides,
  });
  return {
    dir,
    store,
    lines,
    advance: (ms) => {
      t += ms;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run the middleware behind a real http.Server so bodies stream for real. */
async function serve(store, options = {}) {
  const middleware = createProfilesMiddleware(store, options);
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/profiles')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.url = req.url.slice('/api/profiles'.length) || '/';
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/profiles`;
  const call = async (
    method,
    route,
    { body, token, headers = {}, raw, chunked } = {},
  ) => {
    let payload =
      raw !== undefined
        ? raw
        : body !== undefined
          ? JSON.stringify(body)
          : undefined;
    if (chunked && payload !== undefined) {
      // A streamed body has no Content-Length, so the byte cap must trip mid-read.
      const bytes = Buffer.from(payload);
      payload = new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 8192)
            controller.enqueue(bytes.subarray(i, i + 8192));
          controller.close();
        },
      });
    }
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(payload !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: payload,
      ...(chunked ? { duplex: 'half' } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('login creates a profile on first use, rejects a wrong PIN, and normalizes names case-insensitively', async () => {
  const { store, lines, cleanup, dir } = makeStore();
  try {
    const created = await store.login({ name: '  Sterling  ', pin: '1234' });
    assert.equal(created.created, true);
    assert.equal(created.profile.name, 'Sterling');
    assert.equal(created.profile.devices, 1);
    assert.match(created.token, /^[a-f0-9]{32}\.[a-f0-9]{64}$/);
    assert.deepEqual(created.profile.savedPlaces, []);
    assert.equal('pin' in created.profile, false);

    await assert.rejects(
      () => store.login({ name: 'sterling', pin: '9999' }),
      (error) => error.status === 401 && error.code === 'WRONG_PIN',
    );
    const again = await store.login({ name: 'STERLING', pin: '1234' });
    assert.equal(again.created, false);
    assert.equal(again.profile.id, created.profile.id);
    assert.equal(again.profile.devices, 2);

    await assert.rejects(() => store.login({ name: '', pin: '1234' }), /name/);
    await assert.rejects(() => store.login({ name: 'x', pin: '12' }), /PIN/);
    await assert.rejects(() => store.login({ name: 'x', pin: '12ab' }), /PIN/);
    await assert.rejects(
      () => store.login({ name: 'x', pin: '123456789' }),
      /PIN/,
    );

    // One file per profile, PIN kept as scrypt hash + salt, tokens hashed.
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, [`${profileFileKey('Sterling')}.json`]);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, files[0]), 'utf8'),
    );
    assert.equal(onDisk.pin.algo, 'scrypt');
    assert.ok(onDisk.pin.salt && onDisk.pin.hash && onDisk.pin.hash !== '1234');
    assert.equal(onDisk.devices.length, 2);
    assert.ok(onDisk.devices.every((d) => /^[a-f0-9]{64}$/.test(d.tokenHash)));
    assert.ok(!JSON.stringify(onDisk).includes(created.token.split('.')[1]));
    assert.equal(lines.filter((l) => l.startsWith('created')).length, 1);
    assert.equal(lines.filter((l) => l.startsWith('login')).length, 2);
  } finally {
    cleanup();
  }
});

test('tokens authenticate, expire after 180 days, and can be revoked singly or everywhere', async () => {
  const { store, advance, cleanup } = makeStore();
  try {
    const a = await store.login({ name: 'Ada', pin: '4321' });
    const b = await store.login({ name: 'Ada', pin: '4321' });
    assert.equal((await store.me(a.token)).devices, 2);
    await assert.rejects(() => store.me('nonsense'), /Sign in/);
    await assert.rejects(
      () => store.me(`${a.token.split('.')[0]}.${'0'.repeat(64)}`),
      /expired/,
    );

    const out = await store.logout(b.token);
    assert.deepEqual(out, { revoked: 1, devices: 1 });
    await assert.rejects(() => store.me(b.token), /expired/);
    assert.equal((await store.me(a.token)).devices, 1);

    const c = await store.login({ name: 'Ada', pin: '4321' });
    const all = await store.revokeAll(a.token);
    assert.equal(all.revoked, 2);
    await assert.rejects(() => store.me(a.token));
    await assert.rejects(() => store.me(c.token));

    const d = await store.login({ name: 'Ada', pin: '4321' });
    advance(PROFILE_LIMITS.tokenDays * 24 * 3600 * 1000 + 1);
    await assert.rejects(() => store.me(d.token), /expired/);
  } finally {
    cleanup();
  }
});

test('PUT merges last-write-wins per field, validates the schema, and survives a process restart', async () => {
  const { store, dir, advance, cleanup } = makeStore();
  try {
    const { token } = await store.login({ name: 'Grace', pin: '0000' });
    const other = (await store.login({ name: 'Grace', pin: '0000' })).token;

    const first = await store.update(token, {
      savedPlaces: [
        {
          id: 'p1',
          name: ' Office  roof ',
          lat: 35.04,
          lon: -85.3,
          height: 420.123456,
        },
      ],
      defaultStyle: 'nvg',
      voice: { mode: 'local' },
      displayName: 'Grace H',
      homeView: {
        camera: { lat: 1, lon: 2, height: 3, heading: 370, pitch: -120 },
      },
    });
    assert.deepEqual(first.applied, [
      'savedPlaces',
      'defaultStyle',
      'voice',
      'displayName',
      'homeView',
    ]);
    assert.deepEqual(first.profile.savedPlaces, [
      { id: 'p1', name: 'Office roof', lat: 35.04, lon: -85.3, height: 420.12 },
    ]);
    assert.deepEqual(first.profile.homeView.camera, {
      lat: 1,
      lon: 2,
      height: 3,
      heading: 10,
      pitch: -90,
    });

    // A stale write from another device loses; a newer one wins.
    advance(1000);
    const stale = await store.update(other, {
      defaultStyle: 'thermal',
      fieldUpdatedAt: { defaultStyle: 1 },
    });
    assert.deepEqual(stale.applied, []);
    assert.equal(stale.profile.defaultStyle, 'nvg');
    const fresh = await store.update(other, { defaultStyle: 'thermal' });
    assert.deepEqual(fresh.applied, ['defaultStyle']);
    assert.equal(fresh.profile.defaultStyle, 'thermal');
    assert.equal(
      fresh.profile.savedPlaces.length,
      1,
      'untouched fields survive',
    );
    assert.ok(
      fresh.profile.fieldUpdatedAt.defaultStyle >
        fresh.profile.fieldUpdatedAt.savedPlaces,
    );

    // Schema rejections: unknown field, bad voice mode, bad place, wrong types.
    for (const bad of [
      { apiKey: 'sk-nope' },
      { voice: { mode: 'siri' } },
      { savedPlaces: [{ id: 'p2', name: 'No coords' }] },
      { savedPlaces: [{ id: 'bad id!', name: 'x', lat: 0, lon: 0 }] },
      { savedPlaces: [{ id: 'p3', name: '', lat: 0, lon: 0 }] },
      { favoriteLayers: 'flights' },
      { favoriteLayers: [1, 2] },
      { homeView: { camera: { lat: 91, lon: 0 } } },
      { defaultStyle: 42 },
      [],
    ]) {
      await assert.rejects(
        () => store.update(token, bad),
        (error) => error.status === 400 && error.code === 'INVALID_PROFILE',
        `should reject ${JSON.stringify(bad)}`,
      );
    }
    const tooMany = Array.from(
      { length: PROFILE_LIMITS.savedPlacesMax + 1 },
      (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        lat: 0,
        lon: 0,
      }),
    );
    await assert.rejects(
      () => store.update(token, { savedPlaces: tooMany }),
      /capped/,
    );

    // Restart: a fresh store over the same directory sees the same profile.
    const reopened = createProfileStore({ dir, log: () => {} });
    const me = await reopened.me(token);
    assert.equal(me.name, 'Grace');
    assert.equal(me.defaultStyle, 'thermal');
    assert.equal(me.savedPlaces[0].name, 'Office roof');
    assert.equal(me.devices, 2);
    await assert.rejects(
      () => reopened.login({ name: 'grace', pin: '1111' }),
      /Wrong PIN/,
    );
  } finally {
    cleanup();
  }
});

test('profile files are written atomically (no .tmp left behind) and the PIN never appears in clear', async () => {
  const { store, dir, cleanup } = makeStore();
  try {
    await store.login({ name: 'Linus', pin: '2468' });
    await store.update(
      (await store.login({ name: 'Linus', pin: '2468' })).token,
      {
        atcFavorites: ['KSFO', 'KJFK'],
        theme: 'amber',
      },
    );
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(!/"2468"/.test(text));
    assert.match(text, /"atcFavorites"/);
  } finally {
    cleanup();
  }
});

test('HTTP: login/create, wrong PIN 401, rate limit 429, bearer auth, PUT merge, 64 KB cap, logout and revoke-all', async () => {
  const { store, cleanup } = makeStore();
  let allowed = 4;
  const { call, close } = await serve(store, {
    loginLimiter: () => allowed-- > 0,
    allowedOrigins: ['https://jetson.lab'],
  });
  try {
    const created = await call('POST', '/login', {
      body: { name: 'Sterling', pin: '1234' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const token = created.body.token;

    const wrong = await call('POST', '/login', {
      body: { name: 'sterling', pin: '0000' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'WRONG_PIN');

    const second = await call('POST', '/login', {
      body: { name: 'sterling', pin: '1234' },
    });
    assert.equal(second.status, 200);
    const token2 = second.body.token;

    assert.equal((await call('GET', '/login')).status, 405);
    assert.equal(
      (await call('POST', '/login', { raw: '{not json' })).status,
      400,
    );
    const limited = await call('POST', '/login', {
      body: { name: 'sterling', pin: '1234' },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');

    assert.equal((await call('GET', '/me')).status, 401);
    assert.equal((await call('GET', '/me', { token: 'garbage' })).status, 401);
    const me = await call('GET', '/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Sterling');
    assert.equal(me.body.devices, 2);

    const put = await call('PUT', '/me', {
      token,
      body: {
        savedPlaces: [
          {
            id: 'home1',
            name: 'Home',
            lat: 35.0,
            lon: -85.0,
            height: 900,
            heading: 12,
            pitch: -40,
          },
        ],
        favoriteLayers: ['flights', 'satellites', 'flights'],
        voice: { mode: 'local' },
      },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.applied, [
      'savedPlaces',
      'favoriteLayers',
      'voice',
    ]);
    assert.deepEqual(put.body.favoriteLayers, ['flights', 'satellites']);

    // The second "device" sees it.
    const other = await call('GET', '/me', { token: token2 });
    assert.equal(other.body.savedPlaces.length, 1);
    assert.equal(other.body.savedPlaces[0].name, 'Home');
    assert.equal(other.body.voice.mode, 'local');

    const bad = await call('PUT', '/me', { token, body: { nope: true } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'nope');
    const huge = await call('PUT', '/me', {
      token,
      body: { theme: 'x'.repeat(PROFILE_LIMITS.bodyBytesMax) },
    });
    assert.equal(huge.status, 413);
    const hugeNoLength = await call('PUT', '/me', {
      token,
      raw: JSON.stringify({ theme: 'y'.repeat(PROFILE_LIMITS.bodyBytesMax) }),
      chunked: true,
    });
    assert.equal(hugeNoLength.status, 413);
    assert.equal((await call('DELETE', '/me', { token })).status, 405);
    assert.equal((await call('GET', '/nothing-here', { token })).status, 404);

    const out = await call('POST', '/logout', { token: token2 });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { revoked: 1, devices: 1 });
    assert.equal((await call('GET', '/me', { token: token2 })).status, 401);
    const all = await call('POST', '/devices/revoke-all', { token });
    assert.equal(all.status, 200);
    assert.equal(all.body.revoked, 1);
    assert.equal((await call('GET', '/me', { token })).status, 401);
  } finally {
    await close();
    cleanup();
  }
});

test('CORS mirrors rooms: same host and allowlisted origins are echoed (with Authorization), others are refused', async () => {
  const { store, cleanup } = makeStore();
  const { call, close } = await serve(store, {
    allowedOrigins: ['https://jetson.lab'],
  });
  try {
    const preflight = await call('OPTIONS', '/me', {
      headers: {
        origin: 'https://jetson.lab',
        'access-control-request-method': 'PUT',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      'https://jetson.lab',
    );
    assert.match(
      preflight.headers.get('access-control-allow-headers'),
      /Authorization/,
    );
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
    assert.equal(preflight.headers.get('vary'), 'Origin');

    const refused = await call('OPTIONS', '/me', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    const refusedGet = await call('POST', '/login', {
      headers: { origin: 'https://evil.example' },
      body: { name: 'Eve', pin: '1234' },
    });
    assert.equal(refusedGet.status, 403);
    assert.equal(refusedGet.body.code, 'ORIGIN_REFUSED');

    const login = await call('POST', '/login', {
      headers: { origin: 'https://jetson.lab' },
      body: { name: 'Sam', pin: '1234' },
    });
    assert.equal(login.status, 201);
    assert.equal(
      login.headers.get('access-control-allow-origin'),
      'https://jetson.lab',
    );
    const sameOrigin = await call('GET', '/me', {
      token: login.body.token,
      headers: {
        origin: `http://${new URL(login.headers.get('location') || 'http://x').host}`,
      },
    });
    assert.ok([200, 403].includes(sameOrigin.status));
  } finally {
    await close();
    cleanup();
  }
  // Pure helpers.
  assert.deepEqual(
    corsHeaders({ origin: 'http://pi.lab:4173', host: 'pi.lab:4173' }),
    {
      'Access-Control-Allow-Origin': 'http://pi.lab:4173',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  );
  assert.equal(corsHeaders({ origin: 'http://other', host: 'pi.lab' }), null);
  assert.equal(corsHeaders({ host: 'pi.lab' }), null);
  assert.deepEqual(
    allowedOriginsFromEnv({
      GEV_PROFILES_ALLOWED_ORIGINS: 'https://a, https://b',
    }),
    ['https://a', 'https://b'],
  );
  assert.deepEqual(
    allowedOriginsFromEnv({ GEV_ROOMS_ALLOWED_ORIGINS: 'https://rooms-only' }),
    ['https://rooms-only'],
    'falls back to the rooms allowlist',
  );
  assert.deepEqual(
    allowedOriginsFromEnv({
      GEV_PROFILES_ALLOWED_ORIGINS: 'https://p',
      GEV_ROOMS_ALLOWED_ORIGINS: 'https://r',
    }),
    ['https://p'],
  );
  assert.deepEqual(allowedOriginsFromEnv({}), []);
  assert.equal(bearerToken({ authorization: 'Bearer abc.def' }), 'abc.def');
  assert.equal(bearerToken({ authorization: 'Basic abc' }), '');
  assert.equal(bearerToken({}), '');
});

test('profiles provider is part of the local plugin set and resolves its directory from the env', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('profiles-provider'));
  assert.ok(
    names.indexOf('profiles-provider') > names.indexOf('rooms-provider'),
  );
  const plugin = profilesProvider();
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(
    profilesDirFromEnv({ GEV_PROFILES_DIR: '/var/lib/gev/profiles' }),
    path.resolve('/var/lib/gev/profiles'),
  );
  assert.equal(
    profilesDirFromEnv({}, '/repo'),
    path.join('/repo', '.data', 'profiles'),
  );
  assert.match(
    fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8'),
    /^\.data\/$/m,
  );
});

test('profiles provider installs on a Vite-like server and answers 503 when the directory is unwritable', async () => {
  const dir = tempDir();
  try {
    const uses = [];
    const server = {
      middlewares: { use: (route, handler) => uses.push([route, handler]) },
      httpServer: { once() {} },
    };
    profilesProvider({ dir }).configureServer(server);
    assert.deepEqual(
      uses.map(([route]) => route),
      ['/api/profiles'],
    );
    assert.equal(typeof uses[0][1], 'function');

    const blocked = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocked, 'x');
    const uses2 = [];
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      profilesProvider({ dir: path.join(blocked, 'sub') }).configureServer({
        middlewares: { use: (route, handler) => uses2.push([route, handler]) },
        httpServer: null,
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(uses2.length, 1);
    assert.match(warnings.join('\n'), /not writable/);
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    uses2[0][1]({ method: 'GET', url: '/me', headers: {} }, res, () => {});
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'STORE_UNAVAILABLE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
