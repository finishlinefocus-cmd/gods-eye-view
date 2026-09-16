import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CACHE_STORAGE_KEY,
  ProfileSession,
  PUSH_DEBOUNCE_MS,
  TOKEN_STORAGE_KEY,
  layersToEnable,
  retryDelay,
} from './session.js';

/** Deterministic clock + timers. */
function fakeTime(start = 1_700_000_000_000) {
  let t = start;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers]
          .filter((x) => x.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        timers.delete(due);
        due.fn();
        await flush();
      }
      t = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

/** A fake app: tracks what the session set and lets the test fire changes. */
function fakeApp(initial = {}) {
  const app = {
    style: initial.style ?? 'normal',
    layers: initial.layers ?? ['flights'],
    voice: initial.voice ?? 'openai',
    roomName: initial.roomName ?? '',
    camera: initial.camera ?? {
      lat: 35.04,
      lon: -85.3,
      height: 800,
      heading: 10,
      pitch: -40,
      roll: 0,
    },
    flights: [],
    toasts: [],
    shared: [],
    listeners: new Set(),
    calls: [],
  };
  app.bindings = {
    getStyle: () => app.style,
    setStyle: (style) => {
      app.calls.push(['setStyle', style]);
      app.style = style;
    },
    getEnabledLayers: () => [...app.layers],
    enableLayers: (ids) => {
      app.calls.push(['enableLayers', ids]);
      app.layers = [...new Set([...app.layers, ...ids])];
    },
    getVoiceMode: () => app.voice,
    setVoiceMode: (mode) => {
      app.calls.push(['setVoiceMode', mode]);
      app.voice = mode;
    },
    getRoomName: () => app.roomName,
    setRoomName: (name) => {
      app.calls.push(['setRoomName', name]);
      app.roomName = name;
    },
    getCamera: () => app.camera,
    flyTo: (place) => {
      app.flights.push(place);
      return true;
    },
    shareMoment: (place) => {
      app.shared.push(place);
      return true;
    },
    onChange: (cb) => {
      app.listeners.add(cb);
      return () => app.listeners.delete(cb);
    },
    toast: (message) => app.toasts.push(message),
  };
  app.change = (field, value) => {
    for (const cb of app.listeners) cb(field, value);
  };
  return app;
}

/** In-memory profile server speaking the client's contract. */
function fakeServer(seed = {}) {
  const server = {
    online: true,
    requests: [],
    profile: {
      id: 'abc',
      name: 'Sterling',
      updatedAt: 1,
      devices: 1,
      fieldUpdatedAt: {},
      savedPlaces: [],
      favoriteLayers: [],
      defaultStyle: null,
      voice: null,
      displayName: null,
      roomName: null,
      homeView: null,
      atcFavorites: [],
      theme: null,
      ...seed,
    },
    tokens: new Set(['t0.secret']),
    pinFails: false,
  };
  server.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const auth = init.headers?.Authorization?.replace('Bearer ', '') || null;
    server.requests.push({
      method,
      path,
      auth,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (!server.online) throw new TypeError('fetch failed');
    const json = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    if (path === '/api/profiles/login') {
      if (server.pinFails)
        return json(401, { error: 'Wrong PIN', code: 'WRONG_PIN' });
      const token = `t${server.tokens.size}.secret`;
      server.tokens.add(token);
      server.profile.devices = server.tokens.size;
      return json(server.created ? 201 : 200, {
        token,
        created: Boolean(server.created),
        profile: server.profile,
      });
    }
    if (!auth || !server.tokens.has(auth))
      return json(401, { error: 'Sign in required', code: 'UNAUTHORIZED' });
    if (path === '/api/profiles/me' && method === 'GET')
      return json(200, server.profile);
    if (path === '/api/profiles/me' && method === 'PUT') {
      const body = JSON.parse(init.body);
      const applied = [];
      for (const [key, value] of Object.entries(body)) {
        if (key === 'fieldUpdatedAt') continue;
        if (key === 'forbidden')
          return json(400, {
            error: 'unknown profile field: forbidden',
            code: 'INVALID_PROFILE',
          });
        const stamp = body.fieldUpdatedAt?.[key] ?? Date.now();
        if (stamp >= (server.profile.fieldUpdatedAt[key] || 0)) {
          server.profile[key] = value;
          server.profile.fieldUpdatedAt[key] = stamp;
          applied.push(key);
        }
      }
      return json(200, { ...server.profile, applied });
    }
    if (path === '/api/profiles/logout') {
      server.tokens.delete(auth);
      return json(200, { revoked: 1, devices: server.tokens.size });
    }
    if (path === '/api/profiles/devices/revoke-all') {
      const n = server.tokens.size;
      server.tokens.clear();
      return json(200, { revoked: n, devices: 0 });
    }
    return json(404, { error: 'nf' });
  };
  return server;
}

function makeSession({
  app = fakeApp(),
  server = fakeServer(),
  time = fakeTime(),
  storage = memoryStorage(),
  sessionStorage = memoryStorage(),
} = {}) {
  const session = new ProfileSession({
    baseUrl: 'https://pi.lab',
    bindings: app.bindings,
    fetch: server.fetch,
    storage,
    sessionStorage,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    now: time.now,
    random: () => 0.5,
  });
  return { session, app, server, time, storage, sessionStorage };
}

test('helpers: retry backoff grows and caps; layersToEnable only adds what is missing', () => {
  assert.equal(
    retryDelay(0, () => 0.5),
    3000,
  );
  assert.equal(
    retryDelay(1, () => 0.5),
    6000,
  );
  assert.equal(
    retryDelay(10, () => 0.5),
    60000,
  );
  assert.deepEqual(layersToEnable(['a', 'b', 'c'], ['b']), ['a', 'c']);
  assert.deepEqual(layersToEnable([], ['b']), []);
});

test('sign in pulls the profile and applies style, favourite layers, voice mode and room name; token goes to localStorage when remembered', async () => {
  const server = fakeServer({
    defaultStyle: 'nvg',
    favoriteLayers: ['flights', 'satellites'],
    voice: { mode: 'local' },
    displayName: 'Sterling R',
    homeView: { camera: { lat: 1, lon: 2, height: 3 } },
  });
  const { session, app, storage, sessionStorage, time } = makeSession({
    server,
  });
  const states = [];
  session.subscribe((state) => states.push(state.phase));

  const profile = await session.login('  sterling ', '1234', {
    remember: true,
  });
  assert.equal(profile.name, 'Sterling');
  assert.equal(session.signedIn, true);
  assert.deepEqual(states, ['signed-out', 'signing-in', 'signed-in']);
  assert.deepEqual(app.calls, [
    ['setStyle', 'nvg'],
    ['enableLayers', ['satellites']],
    ['setVoiceMode', 'local'],
    ['setRoomName', 'Sterling R'],
  ]);
  assert.equal(session.state.homeAvailable, true);
  assert.match(app.toasts[0], /home view/);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), 't1.secret');
  assert.equal(sessionStorage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(
    JSON.parse(storage.getItem(CACHE_STORAGE_KEY)).defaultStyle,
    'nvg',
  );
  assert.ok(!storage.map.has('pin'));
  assert.ok(
    ![...storage.map.values()].some((v) => v.includes('1234')),
    'PIN never stored',
  );

  // Applying the profile must not echo back as a push.
  await time.advance(PUSH_DEBOUNCE_MS * 2);
  assert.equal(server.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('"remember" off keeps the token in sessionStorage only; wrong PIN and offline are distinguishable', async () => {
  const server = fakeServer();
  const { session, storage, sessionStorage } = makeSession({ server });
  await session.login('S', '1234', { remember: false });
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(sessionStorage.getItem(TOKEN_STORAGE_KEY), 't1.secret');

  const bad = makeSession({
    server: Object.assign(fakeServer(), { pinFails: true }),
  });
  await assert.rejects(() => bad.session.login('S', '9999'), /Wrong PIN/);
  assert.equal(bad.session.state.phase, 'signed-out');
  const down = makeSession({
    server: Object.assign(fakeServer(), { online: false }),
  });
  await assert.rejects(() => down.session.login('S', '1234'), /unreachable/);
  await assert.rejects(() => down.session.login('S', '12'), /PIN must be/);
  await assert.rejects(() => down.session.login('', '1234'), /name/);
});

test('local changes are pushed once, debounced 2 s, with per-field stamps; the merged reply is adopted', async () => {
  const server = fakeServer();
  const { session, app, time } = makeSession({ server });
  await session.login('S', '1234');
  await time.advance(100);
  server.requests.length = 0;

  app.change('style', 'thermal');
  await time.advance(500);
  app.change('style', 'nvg');
  app.change('layers', ['flights', 'ships']);
  app.change('voice', 'local');
  app.change('roomName', 'Sterling R');
  assert.deepEqual(session.state.dirty, [
    'defaultStyle',
    'favoriteLayers',
    'voice',
    'displayName',
  ]);
  await time.advance(1000);
  assert.equal(server.requests.length, 0, 'still inside the debounce window');
  await time.advance(PUSH_DEBOUNCE_MS);
  const puts = server.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 1, 'one PUT for the burst');
  assert.equal(puts[0].auth, 't1.secret');
  assert.equal(puts[0].body.defaultStyle, 'nvg');
  assert.deepEqual(puts[0].body.favoriteLayers, ['flights', 'ships']);
  assert.deepEqual(puts[0].body.voice, { mode: 'local' });
  assert.equal(puts[0].body.displayName, 'Sterling R');
  assert.deepEqual(Object.keys(puts[0].body.fieldUpdatedAt).sort(), [
    'defaultStyle',
    'displayName',
    'favoriteLayers',
    'voice',
  ]);
  assert.ok(puts[0].body.fieldUpdatedAt.defaultStyle > 0);
  assert.deepEqual(session.state.dirty, []);
  assert.equal(session.state.profile.defaultStyle, 'nvg');
  assert.equal(server.profile.defaultStyle, 'nvg');
});

test('saved places: save (dedupe by name), fly, voice match, delete, share as room moment; home view set/go', async () => {
  const server = fakeServer();
  const { session, app, time } = makeSession({ server });
  await session.login('S', '1234');

  assert.equal(session.savePlace('   '), null);
  const office = session.savePlace('Office roof');
  assert.equal(office.name, 'Office roof');
  assert.equal(office.lat, 35.04);
  assert.equal(office.height, 800);
  app.camera = {
    lat: 40.7,
    lon: -74,
    height: 300,
    heading: 0,
    pitch: -30,
    roll: 0,
  };
  const lab = session.savePlace('The Lab', { note: 'bench 2' });
  assert.equal(session.savedPlaces.length, 2);
  assert.equal(session.savedPlaces[1].note, 'bench 2');
  const again = session.savePlace('office ROOF');
  assert.equal(again.id, office.id, 'same name updates in place');
  assert.equal(again.lat, 40.7);
  assert.equal(session.savedPlaces.length, 2);

  // Voice-style matching before geocoding.
  assert.equal(session.findPlace('take me to the office roof')?.id, office.id);
  assert.equal(session.findPlace('lab')?.id, lab.id);
  assert.equal(session.findPlace('Paris'), null);
  assert.equal(session.flyToPlace('the lab')?.id, lab.id);
  assert.equal(app.flights.at(-1).id, lab.id);
  assert.equal(session.flyToPlace(office.id)?.id, office.id);
  assert.equal(session.flyToPlace('nowhere'), null);

  assert.equal(session.sharePlace(office.id), true);
  assert.equal(app.shared[0].id, office.id);

  assert.equal(session.goHome(), false, 'no home yet');
  assert.equal(session.setHome(), true);
  assert.equal(session.state.homeAvailable, true);
  assert.equal(session.goHome(), true);
  assert.equal(app.flights.at(-1).name, 'Home');
  assert.equal(app.flights.at(-1).lat, 40.7);

  assert.equal(session.deletePlace(lab.id), true);
  assert.equal(session.deletePlace(lab.id), false);
  assert.equal(session.savedPlaces.length, 1);

  await time.advance(PUSH_DEBOUNCE_MS + 10);
  const put = server.requests.filter((r) => r.method === 'PUT').at(-1);
  assert.equal(put.body.savedPlaces.length, 1);
  assert.equal(put.body.savedPlaces[0].name, 'Office roof');
  assert.deepEqual(Object.keys(put.body.homeView.camera).sort(), [
    'heading',
    'height',
    'lat',
    'lon',
    'pitch',
    'roll',
  ]);
  assert.equal(server.profile.savedPlaces.length, 1);

  // A second device sees them on its next pull.
  const other = makeSession({ server, app: fakeApp() });
  await other.session.login('S', '1234');
  assert.equal(other.session.savedPlaces[0].name, 'Office roof');
  assert.equal(other.session.findPlace('office roof')?.id, office.id);
  assert.equal(other.session.state.devices, 3); // seed token + two sign-ins
});

test('start() resumes a remembered token: cached copy is applied immediately, then refreshed from the server', async () => {
  const server = fakeServer({
    defaultStyle: 'thermal',
    favoriteLayers: ['ships'],
  });
  const storage = memoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 't0.secret');
  storage.setItem(
    CACHE_STORAGE_KEY,
    JSON.stringify({
      id: 'abc',
      name: 'Sterling',
      defaultStyle: 'nvg',
      favoriteLayers: ['satellites'],
    }),
  );
  const app = fakeApp();
  const { session } = makeSession({ server, storage, app });
  const ok = await session.start();
  assert.equal(ok, true);
  assert.equal(session.state.name, 'Sterling');
  // Cached first (nvg + satellites), then the server's truth (thermal + ships).
  assert.deepEqual(app.calls, [
    ['setStyle', 'nvg'],
    ['enableLayers', ['satellites']],
    ['setStyle', 'thermal'],
    ['enableLayers', ['ships']],
  ]);
  assert.equal(session.state.online, true);

  const fresh = makeSession({ server });
  assert.equal(await fresh.session.start(), false, 'nothing remembered');
});

test('offline: keeps working from the local copy, marks offline, retries with backoff, and flushes when back', async () => {
  const server = fakeServer({
    savedPlaces: [{ id: 'p1', name: 'Office', lat: 1, lon: 2 }],
  });
  const storage = memoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 't0.secret');
  storage.setItem(
    CACHE_STORAGE_KEY,
    JSON.stringify({
      id: 'abc',
      name: 'Sterling',
      savedPlaces: server.profile.savedPlaces,
    }),
  );
  server.online = false;
  const { session, app, time } = makeSession({ server, storage });
  await session.start();
  assert.equal(session.signedIn, true, 'still signed in from the cache');
  assert.equal(session.state.online, false);
  assert.equal(
    session.findPlace('office')?.id,
    'p1',
    'saved places work offline',
  );

  await time.advance(100); // past the apply settle window
  app.change('style', 'nvg');
  await time.advance(PUSH_DEBOUNCE_MS + 10);
  assert.equal(session.state.online, false);
  assert.deepEqual(
    session.state.dirty,
    ['defaultStyle'],
    'change stays queued',
  );
  const attemptsWhileDown = server.requests.length;

  await time.advance(6100); // second backoff step (the failed pull was the first)
  assert.ok(
    server.requests.length > attemptsWhileDown,
    'retried after backoff',
  );
  server.online = true;
  await time.advance(60_000);
  assert.equal(session.state.online, true);
  assert.deepEqual(session.state.dirty, []);
  assert.equal(server.profile.defaultStyle, 'nvg', 'queued change flushed');
  assert.equal(session.savedPlaces.length, 1);
});

test('a 401 on pull or push signs out; a 400 drops the bad payload without retrying forever', async () => {
  const server = fakeServer();
  const { session, app, time, storage } = makeSession({ server });
  await session.login('S', '1234');
  server.tokens.clear(); // revoked elsewhere
  await session.syncNow();
  assert.equal(session.signedIn, false);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.match(session.state.notice, /expired/);

  const server2 = fakeServer();
  const s2 = makeSession({ server: server2, app });
  await s2.session.login('S', '1234');
  s2.session._markDirty('forbidden', 1);
  await s2.time.advance(PUSH_DEBOUNCE_MS + 10);
  assert.deepEqual(s2.session.state.dirty, []);
  assert.match(s2.session.state.notice, /refused/);
  assert.equal(s2.session.signedIn, true);
  void time;
});

test('sign out revokes this device only; sign out everywhere revokes all; both clear local state', async () => {
  const server = fakeServer();
  const first = makeSession({ server });
  await first.session.login('S', '1234');
  const second = makeSession({ server });
  await second.session.login('S', '1234');
  assert.equal(server.tokens.size, 3);

  await first.session.logout();
  assert.equal(first.session.signedIn, false);
  assert.equal(first.storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(first.storage.getItem(CACHE_STORAGE_KEY), null);
  assert.equal(server.tokens.size, 2);
  assert.equal(server.requests.at(-1).path, '/api/profiles/logout');

  await second.session.logout({ everywhere: true });
  assert.equal(server.tokens.size, 0);
  assert.equal(server.requests.at(-1).path, '/api/profiles/devices/revoke-all');
  assert.match(second.session.state.notice, /everywhere/);
});

test('a brand-new profile is seeded from this device and the profile name becomes the room name', async () => {
  const server = Object.assign(fakeServer(), { created: true });
  const app = fakeApp({
    style: 'surveillance',
    layers: ['flights', 'cctv'],
    voice: 'local',
    roomName: '',
  });
  const { session, time } = makeSession({ server, app });
  await session.login('Sterling', '1234');
  assert.equal(app.roomName, 'Sterling');
  await time.advance(PUSH_DEBOUNCE_MS + 10);
  const put = server.requests.filter((r) => r.method === 'PUT')[0];
  assert.equal(put.body.defaultStyle, 'surveillance');
  assert.deepEqual(put.body.favoriteLayers, ['flights', 'cctv']);
  assert.deepEqual(put.body.voice, { mode: 'local' });
  assert.equal(put.body.displayName, 'Sterling');
});
