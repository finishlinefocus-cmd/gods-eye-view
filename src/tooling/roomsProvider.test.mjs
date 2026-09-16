import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
import {
  allowedOriginsFromEnv,
  attachRoomsSocket,
  corsHeaders,
  createRoomStore,
  createRoomsMiddleware,
  originAllowed,
  parseRoomPath,
  roomsExpiryMs,
  roomsProvider,
} from '../../server/providers/rooms.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  isRoomCode,
  normalizeRoomCode,
  sanitizeText,
  sanitizeViewState,
} from '../rooms/protocol.js';

const CAMERA = {
  lon: -122.4,
  lat: 37.8,
  height: 1200,
  heading: 10,
  pitch: -40,
  roll: 0,
};

/** Deterministic clock + timer set for lifecycle tests. */
function fakeTime() {
  let t = 1_000_000;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    advance(ms) {
      t += ms;
      for (const timer of [...timers]) {
        if (timer.at <= t) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
  };
}

function makeStore(overrides = {}) {
  const time = fakeTime();
  const lines = [];
  const store = createRoomStore({
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { store, time, lines };
}

function member(store, roomId, name, token = null) {
  const inbox = [];
  const info = store.join(roomId, {
    name,
    token,
    send: (message) => inbox.push(message),
  });
  return {
    ...info,
    inbox,
    last: (type) => inbox.filter((m) => m.type === type).at(-1),
  };
}

test('room codes use the unambiguous alphabet and normalize pasted links', () => {
  const { store } = makeStore();
  const { roomId, joinToken } = store.createRoom();
  assert.equal(roomId.length, 6);
  assert.ok(isRoomCode(roomId));
  assert.ok(!/[IO01]/.test(roomId));
  assert.ok(joinToken.length >= 20);
  assert.equal(normalizeRoomCode(` ${roomId.toLowerCase()} `), roomId);
  assert.equal(
    normalizeRoomCode(`https://gev.example/?room=${roomId}`),
    roomId,
  );
  assert.equal(normalizeRoomCode('ABC-123'), null);
  assert.equal(normalizeRoomCode('ABCDE0'), null);
  assert.equal(parseRoomPath(`/${roomId}`), roomId);
  assert.equal(parseRoomPath(`/${roomId.toLowerCase()}/`), roomId);
  assert.equal(parseRoomPath('/nope'), null);
});

test('first joiner leads; take and hand off move the crown; leader leaving promotes the oldest', () => {
  const { store } = makeStore();
  const { roomId } = store.createRoom();
  const a = member(store, roomId, 'Alice');
  const b = member(store, roomId, 'Bob');
  const c = member(store, roomId, 'Cara');
  assert.equal(a.inbox[0].type, 'hello');
  assert.equal(a.inbox[0].leaderId, a.id);
  assert.equal(b.inbox[0].leaderId, a.id);
  assert.deepEqual(
    a.last('presence').members.map((m) => m.name),
    ['Alice', 'Bob', 'Cara'],
  );
  assert.notEqual(a.color, b.color);

  // Anyone can take the lead.
  assert.equal(
    store.handleMessage(roomId, b.id, { type: 'lead', action: 'take' }),
    null,
  );
  assert.equal(store.leaderOf(roomId), b.id);
  assert.equal(a.last('lead').reason, 'take');

  // Only the leader can hand off, and only to a present member.
  assert.equal(
    store.handleMessage(roomId, a.id, {
      type: 'lead',
      action: 'handoff',
      to: c.id,
    }).code,
    'NOT_LEADER',
  );
  assert.equal(
    store.handleMessage(roomId, b.id, {
      type: 'lead',
      action: 'handoff',
      to: 'ghost',
    }).code,
    'NO_SUCH_MEMBER',
  );
  assert.equal(
    store.handleMessage(roomId, b.id, {
      type: 'lead',
      action: 'handoff',
      to: c.id,
    }),
    null,
  );
  assert.equal(store.leaderOf(roomId), c.id);

  // Leader leaves → oldest remaining member (Alice) inherits.
  store.leave(roomId, c.id);
  assert.equal(store.leaderOf(roomId), a.id);
  assert.equal(b.last('lead').reason, 'leader-left');
});

test('creator token reclaims the lead on (re)join', () => {
  const { store } = makeStore();
  const { roomId, joinToken } = store.createRoom();
  const b = member(store, roomId, 'Bob');
  assert.equal(store.leaderOf(roomId), b.id);
  const a = member(store, roomId, 'Alice', joinToken);
  assert.equal(store.leaderOf(roomId), a.id);
  assert.equal(a.inbox[0].leaderId, a.id);
  const c = member(store, roomId, 'Cara', 'wrong-token');
  assert.equal(store.leaderOf(roomId), a.id);
  assert.equal(c.inbox[0].leaderId, a.id);
});

test('only the leader broadcasts state, throttled to 4/s, and late joiners get the last state', () => {
  const { store, time } = makeStore();
  const { roomId } = store.createRoom();
  const a = member(store, roomId, 'Alice');
  const b = member(store, roomId, 'Bob');
  assert.equal(
    store.handleMessage(roomId, b.id, {
      type: 'state',
      state: { camera: CAMERA },
    }).code,
    'NOT_LEADER',
  );
  assert.equal(
    store.handleMessage(roomId, a.id, {
      type: 'state',
      state: { layers: ['x'] },
    }).code,
    'BAD_STATE',
  );
  const full = {
    camera: { ...CAMERA, lat: 95 },
    style: { preset: 'noir', bloom: 0.4, bad: { nested: true } },
    layers: ['flights', 'flights', 'bad id!', 'vessels'],
    tracked: { layerId: 'flights', id: 'abc123', label: 'UAL1\u202E' },
    scene: { id: 'orbital-watch' },
  };
  assert.equal(
    store.handleMessage(roomId, a.id, { type: 'state', state: full }),
    null,
  );
  const got = b.last('state');
  assert.equal(got.from, a.id);
  assert.equal(got.state.camera.lat, 90);
  assert.deepEqual(got.state.layers, ['flights', 'vessels']);
  assert.deepEqual(got.state.style, { preset: 'noir', bloom: 0.4 });
  assert.deepEqual(got.state.tracked, {
    layerId: 'flights',
    id: 'abc123',
    label: 'UAL1',
  });
  assert.deepEqual(got.state.scene, { id: 'orbital-watch', playing: true });
  assert.equal(
    a.inbox.filter((m) => m.type === 'state').length,
    0,
    'leader does not echo',
  );

  // Second frame within 250 ms is dropped; after 250 ms it flows.
  time.advance(100);
  store.handleMessage(roomId, a.id, {
    type: 'state',
    state: { camera: { ...CAMERA, lon: 1 } },
  });
  assert.equal(b.last('state').state.camera.lon, CAMERA.lon);
  time.advance(200);
  store.handleMessage(roomId, a.id, {
    type: 'state',
    state: { camera: { ...CAMERA, lon: 2 } },
  });
  assert.equal(b.last('state').state.camera.lon, 2);

  const c = member(store, roomId, 'Cara');
  assert.equal(c.inbox[0].state.camera.lon, 2);
});

test('chat is sanitized, rate limited to 5 per 5 s, and keeps the last 100', () => {
  const { store, time } = makeStore();
  const { roomId } = store.createRoom();
  const a = member(store, roomId, 'Alice');
  const b = member(store, roomId, 'Bob');
  assert.equal(
    store.handleMessage(roomId, a.id, { type: 'chat', text: '   ' }).code,
    'EMPTY_CHAT',
  );
  assert.equal(
    store.handleMessage(roomId, a.id, {
      type: 'chat',
      text: ' hi\u0000 <b>x</b>\u200B  there\n\n\n ok ',
    }),
    null,
  );
  assert.equal(b.last('chat').text, 'hi <b>x</b> there\nok');
  assert.equal(b.last('chat').from.name, 'Alice');
  assert.equal(typeof b.last('chat').t, 'number');
  const long = 'x'.repeat(600);
  store.handleMessage(roomId, a.id, { type: 'chat', text: long });
  assert.equal(b.last('chat').text.length, 500);
  store.handleMessage(roomId, a.id, { type: 'chat', text: '3' });
  store.handleMessage(roomId, a.id, { type: 'chat', text: '4' });
  store.handleMessage(roomId, a.id, { type: 'chat', text: '5' });
  const limited = store.handleMessage(roomId, a.id, {
    type: 'chat',
    text: '6',
  });
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.ok(limited.retryInMs > 0);
  time.advance(5001);
  assert.equal(
    store.handleMessage(roomId, a.id, { type: 'chat', text: '6' }),
    null,
  );
  assert.equal(b.last('chat').text, '6');

  for (let i = 0; i < 120; i += 1) {
    time.advance(1001);
    store.handleMessage(roomId, b.id, { type: 'chat', text: `m${i}` });
  }
  const c = member(store, roomId, 'Cara');
  assert.equal(c.inbox[0].chat.length, 100);
  assert.equal(c.inbox[0].chat.at(-1).text, 'm119');
});

test('pings and moments broadcast to everyone; moments keep the last 20', () => {
  const { store } = makeStore();
  const { roomId } = store.createRoom();
  const a = member(store, roomId, 'Alice');
  const b = member(store, roomId, 'Bob');
  assert.equal(
    store.handleMessage(roomId, b.id, { type: 'ping', lon: 'x' }).code,
    'BAD_PING',
  );
  assert.equal(
    store.handleMessage(roomId, b.id, {
      type: 'ping',
      lon: 10,
      lat: 20,
      label: 'look\nhere',
    }),
    null,
  );
  const ping = a.last('ping');
  assert.equal(ping.lon, 10);
  assert.equal(ping.label, 'look here');
  assert.equal(ping.ttlMs, 20_000);
  assert.equal(b.last('ping').id, ping.id, 'sender sees its own ping too');

  assert.equal(
    store.handleMessage(roomId, b.id, { type: 'event', note: 'x' }).code,
    'BAD_STATE',
  );
  for (let i = 0; i < 25; i += 1) {
    store.handleMessage(roomId, b.id, {
      type: 'event',
      note: `moment ${i}`,
      state: { camera: { ...CAMERA, lon: i } },
    });
  }
  assert.equal(a.last('event').moment.note, 'moment 24');
  assert.equal(a.last('event').moment.from.id, b.id);
  const c = member(store, roomId, 'Cara');
  assert.equal(c.inbox[0].moments.length, 20);
  assert.equal(c.inbox[0].moments[0].note, 'moment 5');
  assert.equal(store.summary(roomId).momentCount, 20);
});

test('rooms expire after the last member leaves, cap members and rooms, and log lifecycle', () => {
  const { store, time, lines } = makeStore({
    maxRooms: 2,
    maxMembers: 2,
    expiryMs: 1000,
  });
  const { roomId } = store.createRoom();
  assert.match(lines[0], /created/);
  member(store, roomId, 'Alice');
  const b = member(store, roomId, 'Bob');
  assert.throws(() => member(store, roomId, 'Cara'), /full/);
  store.createRoom();
  assert.throws(() => store.createRoom(), /Too many rooms/);

  // Members present → the room does not expire.
  time.advance(5000);
  assert.ok(store.hasRoom(roomId));
  store.leave(roomId, store.memberIds(roomId)[0]);
  store.leave(roomId, b.id);
  time.advance(999);
  assert.ok(store.hasRoom(roomId));
  // A rejoin before expiry disarms the timer.
  member(store, roomId, 'Dan');
  time.advance(5000);
  assert.ok(store.hasRoom(roomId));
  store.leave(roomId, store.memberIds(roomId)[0]);
  time.advance(1000);
  assert.ok(!store.hasRoom(roomId));
  assert.match(lines.at(-1), /expired/);
  assert.throws(() => store.summary(roomId), /not found/);
  // An untouched room expires too.
  time.advance(1000);
  assert.equal(store.roomCount(), 0);
});

test('unknown message types and non-members are rejected', () => {
  const { store } = makeStore();
  const { roomId } = store.createRoom();
  const a = member(store, roomId, 'Alice');
  assert.equal(
    store.handleMessage(roomId, a.id, { type: 'nope' }).code,
    'UNKNOWN_TYPE',
  );
  assert.equal(
    store.handleMessage(roomId, a.id, 'garbage').code,
    'BAD_MESSAGE',
  );
  assert.equal(
    store.handleMessage(roomId, a.id, { type: 'heartbeat' }).type,
    'heartbeat',
  );
  assert.throws(
    () => store.handleMessage(roomId, 'ghost', { type: 'chat', text: 'x' }),
    /Not a member/,
  );
  assert.throws(
    () => store.handleMessage('ZZZZZZ', a.id, { type: 'chat', text: 'x' }),
    /not found/,
  );
});

test('view-state sanitizer degrades fields but never accepts a missing camera', () => {
  assert.equal(sanitizeViewState(null), null);
  assert.equal(sanitizeViewState({ camera: { lon: 1 } }), null);
  const state = sanitizeViewState({ camera: { lon: 1, lat: 2, height: 3 } });
  assert.deepEqual(state, {
    camera: { lon: 1, lat: 2, height: 3, heading: 0, pitch: -90, roll: 0 },
    style: null,
    layers: [],
    tracked: null,
    scene: null,
  });
  assert.equal(sanitizeText('a\u0007b', 10), 'ab');
});

test('socket origin policy: same host, forwarded host, env allowlist', () => {
  assert.ok(originAllowed({ host: 'localhost:4176' }));
  assert.ok(
    originAllowed({ host: 'localhost:4176', origin: 'http://localhost:4176' }),
  );
  assert.ok(
    !originAllowed({ host: 'localhost:4176', origin: 'http://evil.example' }),
  );
  assert.ok(
    originAllowed({
      host: 'localhost:4176',
      'x-forwarded-host': 'mac.tail1234.ts.net',
      origin: 'https://mac.tail1234.ts.net',
    }),
  );
  assert.ok(
    originAllowed(
      { host: 'localhost:4176', origin: 'https://mac.tail1234.ts.net' },
      { allowedOrigins: ['https://mac.tail1234.ts.net'] },
    ),
  );
  assert.ok(!originAllowed({ host: 'x', origin: 'not a url' }));
  assert.equal(roomsExpiryMs({}), 30 * 60 * 1000);
  assert.equal(roomsExpiryMs({ GEV_ROOMS_EXPIRY_MS: '250' }), 250);
  assert.equal(roomsExpiryMs({ GEV_ROOMS_EXPIRY_MS: 'nope' }), 30 * 60 * 1000);
});

test('rooms provider is part of the local plugin set', () => {
  const plugin = roomsProvider();
  assert.equal(plugin.name, 'rooms-provider');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  const names = localProviderPlugins().map((p) => p.name);
  assert.ok(names.includes('rooms-provider'));
});

test('HTTP routes: create, summary, 404, 405, 426 on the socket path, create rate limit', async () => {
  const { store } = makeStore();
  let allowed = 3;
  const middleware = createRoomsMiddleware(store, {
    createLimiter: () => allowed-- > 0,
  });
  const run = (method, url) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(body) {
          resolve({
            status: this.status,
            body: body ? JSON.parse(body) : null,
          });
        },
      };
      middleware(
        { method, url, socket: { remoteAddress: '127.0.0.1' } },
        res,
        () => resolve({ status: 'next' }),
      );
    });
  const created = await run('POST', '/');
  assert.equal(created.status, 201);
  assert.ok(isRoomCode(created.body.roomId));
  const summary = await run('GET', `/${created.body.roomId}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.memberCount, 0);
  assert.equal((await run('GET', '/ZZZZZZ')).status, 404);
  assert.equal((await run('GET', '/')).status, 405);
  assert.equal((await run('DELETE', `/${created.body.roomId}`)).status, 405);
  assert.equal((await run('GET', `/${created.body.roomId}/ws`)).status, 426);
  assert.equal((await run('GET', '/not-a-room-id-at-all')).status, 'next');
  await run('POST', '/');
  await run('POST', '/');
  assert.equal((await run('POST', '/')).status, 429);
});

test('WebSocket transport: hello/presence/state/chat/lead round trip and expiry after both leave', async () => {
  const ws = createRequire(import.meta.url)('ws');
  const store = createRoomStore({ expiryMs: 200, log: () => {} });
  const middleware = createRoomsMiddleware(store);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/rooms')) {
      req.url = req.url.slice('/api/rooms'.length) || '/';
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
      return;
    }
    res.end('ok');
  });
  const detach = attachRoomsSocket(server, store, { wsModule: ws });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await (
      await fetch(`${base}/api/rooms`, { method: 'POST' })
    ).json();
    const open = (query) =>
      new Promise((resolve, reject) => {
        const socket = new ws.WebSocket(
          `ws://127.0.0.1:${port}/api/rooms/${created.roomId}/ws?${query}`,
        );
        const inbox = [];
        const waiters = [];
        socket.on('message', (data) => {
          const message = JSON.parse(String(data));
          inbox.push(message);
          for (const waiter of [...waiters]) {
            if (waiter.type === message.type) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            }
          }
        });
        const next = (type) =>
          new Promise((res) => {
            const existing = inbox.find((m) => m.type === type && !m._seen);
            if (existing) {
              existing._seen = true;
              res(existing);
              return;
            }
            waiters.push({ type, resolve: (m) => ((m._seen = true), res(m)) });
          });
        socket.once('open', () => resolve({ socket, inbox, next }));
        socket.once('error', reject);
      });

    const a = await open(
      'name=Alice&token=' + encodeURIComponent(created.joinToken),
    );
    const helloA = await a.next('hello');
    assert.equal(helloA.leaderId, helloA.memberId);
    const b = await open('name=Bob');
    const helloB = await b.next('hello');
    assert.equal(helloB.leaderId, helloA.memberId);
    const presence = await a.next('presence');
    assert.ok(presence.members.length >= 1);

    a.socket.send(
      JSON.stringify({
        type: 'state',
        state: { camera: CAMERA, layers: ['flights'] },
      }),
    );
    const state = await b.next('state');
    assert.equal(state.state.camera.lon, CAMERA.lon);
    assert.deepEqual(state.state.layers, ['flights']);

    b.socket.send(JSON.stringify({ type: 'chat', text: 'hello from bob' }));
    const chat = await a.next('chat');
    assert.equal(chat.text, 'hello from bob');
    assert.equal(chat.from.name, 'Bob');

    b.socket.send(JSON.stringify({ type: 'lead', action: 'take' }));
    let lead = await a.next('lead');
    while (lead.reason !== 'take') lead = await a.next('lead');
    assert.equal(lead.leaderId, helloB.memberId);
    // A is now a follower: its state is refused, B's flows.
    a.socket.send(JSON.stringify({ type: 'state', state: { camera: CAMERA } }));
    assert.equal((await a.next('error')).code, 'NOT_LEADER');
    b.socket.send(
      JSON.stringify({
        type: 'state',
        state: { camera: { ...CAMERA, lon: 5 } },
      }),
    );
    assert.equal((await a.next('state')).state.camera.lon, 5);

    b.socket.send('not json');
    assert.equal((await b.next('error')).code, 'BAD_JSON');

    // Unknown room and a foreign origin are refused at the upgrade.
    await assert.rejects(
      new Promise((_, reject) => {
        const s = new ws.WebSocket(
          `ws://127.0.0.1:${port}/api/rooms/ZZZZZZ/ws`,
        );
        s.once('error', reject);
        s.once('unexpected-response', (_req, res) =>
          reject(new Error(`status ${res.statusCode}`)),
        );
      }),
      /404/,
    );
    await assert.rejects(
      new Promise((_, reject) => {
        const s = new ws.WebSocket(
          `ws://127.0.0.1:${port}/api/rooms/${created.roomId}/ws`,
          {
            headers: { origin: 'http://evil.example' },
          },
        );
        s.once('error', reject);
        s.once('unexpected-response', (_req, res) =>
          reject(new Error(`status ${res.statusCode}`)),
        );
      }),
      /403/,
    );

    const summary = await (
      await fetch(`${base}/api/rooms/${created.roomId}`)
    ).json();
    assert.equal(summary.memberCount, 2);
    assert.equal(summary.leaderName, 'Bob');

    a.socket.close();
    b.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(store.roomCount(), 0);
    assert.equal(
      (await fetch(`${base}/api/rooms/${created.roomId}`)).status,
      404,
    );
  } finally {
    detach();
    store.clear();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CORS: allowed cross-origin instances get echoed origins and a 204 preflight; others get nothing', async () => {
  const { store } = makeStore();
  const allowedOrigins = [
    'https://mac.tail1234.ts.net',
    'http://jetson.local:4173',
  ];
  assert.deepEqual(
    allowedOriginsFromEnv({
      GEV_ROOMS_ALLOWED_ORIGINS:
        ' https://mac.tail1234.ts.net, http://jetson.local:4173 ,',
    }),
    allowedOrigins,
  );
  assert.equal(
    corsHeaders({ host: 'pi.local:4173' }),
    null,
    'no Origin → no CORS headers',
  );
  assert.equal(
    corsHeaders(
      { host: 'pi.local:4173', origin: 'https://evil.example' },
      { allowedOrigins },
    ),
    null,
  );
  assert.equal(
    corsHeaders(
      { host: 'pi.local:4173', origin: 'https://mac.tail1234.ts.net' },
      { allowedOrigins },
    )['Access-Control-Allow-Origin'],
    'https://mac.tail1234.ts.net',
  );
  assert.equal(
    corsHeaders({ host: 'pi.local:4173', origin: 'http://pi.local:4173' })[
      'Access-Control-Allow-Origin'
    ],
    'http://pi.local:4173',
    'same host always allowed',
  );

  const middleware = createRoomsMiddleware(store, {
    createLimiter: () => true,
    allowedOrigins,
  });
  const run = (method, url, headers = {}) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, h) {
          this.status = status;
          this.headers = h;
          this.headersSent = true;
        },
        end(body) {
          resolve({
            status: this.status,
            headers: this.headers,
            body: body ? JSON.parse(body) : null,
          });
        },
      };
      middleware(
        {
          method,
          url,
          headers: { host: 'pi.local:4173', ...headers },
          socket: { remoteAddress: '10.0.0.2' },
        },
        res,
        () => resolve({ status: 'next' }),
      );
    });

  const preflight = await run('OPTIONS', '/', {
    origin: 'https://mac.tail1234.ts.net',
    'access-control-request-method': 'POST',
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers['Access-Control-Allow-Origin'],
    'https://mac.tail1234.ts.net',
  );
  assert.match(preflight.headers['Access-Control-Allow-Methods'], /POST/);
  assert.equal(preflight.headers.Vary, 'Origin');
  assert.equal(
    (await run('OPTIONS', '/', { origin: 'https://evil.example' })).status,
    403,
  );

  const created = await run('POST', '/', {
    origin: 'http://jetson.local:4173',
  });
  assert.equal(created.status, 201);
  assert.equal(
    created.headers['Access-Control-Allow-Origin'],
    'http://jetson.local:4173',
  );
  const summary = await run('GET', `/${created.body.roomId}`, {
    origin: 'https://mac.tail1234.ts.net',
  });
  assert.equal(summary.status, 200);
  assert.equal(
    summary.headers['Access-Control-Allow-Origin'],
    'https://mac.tail1234.ts.net',
  );
  const refused = await run('GET', `/${created.body.roomId}`, {
    origin: 'https://evil.example',
  });
  assert.equal(
    refused.status,
    200,
    'the route still answers; the browser enforces the missing header',
  );
  assert.equal(refused.headers['Access-Control-Allow-Origin'], undefined);
  const plain = await run('GET', `/${created.body.roomId}`);
  assert.equal(plain.headers['Access-Control-Allow-Origin'], undefined);
});
