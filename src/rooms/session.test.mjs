import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomSession, roomCodeFromUrl, NAME_STORAGE_KEY } from './session.js';
import { RoomClient, backoffDelay } from './client.js';

const CAMERA = {
  lon: -122.4,
  lat: 37.8,
  height: 1200,
  heading: 0,
  pitch: -45,
  roll: 0,
};
const LOCATION = {
  origin: 'https://gev.example',
  protocol: 'https:',
  host: 'gev.example',
  href: 'https://gev.example/',
};

/** Scripted client: records sends, lets tests emit server frames. */
class FakeClient {
  constructor(options) {
    this.options = options;
    this.roomId = options.roomId;
    this.sent = [];
    this.listeners = new Map();
    this.open = false;
    this.closed = false;
    FakeClient.instances.push(this);
  }
  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type).delete(handler);
  }
  emit(type, payload) {
    for (const handler of [...(this.listeners.get(type) || [])])
      handler(payload);
  }
  connect() {
    this.open = true;
    this.emit('status', { status: 'open', attempt: 0 });
  }
  send(message) {
    if (!this.open) return false;
    this.sent.push(message);
    return true;
  }
  close() {
    this.open = false;
    this.closed = true;
    this.emit('status', { status: 'closed' });
  }
  sentOf(type) {
    return this.sent.filter((m) => m.type === type);
  }
}
FakeClient.instances = [];

function fakeView(overrides = {}) {
  const view = {
    camera: { ...CAMERA },
    applied: [],
    released: 0,
    manualMove: null,
    pings: [],
    cleared: 0,
    getState() {
      return {
        camera: view.camera,
        style: 'noir',
        layers: ['flights'],
        tracked: null,
        scene: null,
      };
    },
    applyState(state, options) {
      view.applied.push({ state, ...options });
      view.camera = { ...state.camera };
    },
    releaseCamera() {
      view.released += 1;
      return true;
    },
    onManualMove(cb) {
      view.manualMove = cb;
      return () => {
        view.manualMove = null;
      };
    },
    pingTarget() {
      return { lon: 1, lat: 2, label: '' };
    },
    showPing(ping) {
      view.pings.push(ping);
    },
    clearPings() {
      view.cleared += 1;
    },
    ...overrides,
  };
  return view;
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}

function fakeFetch(routes) {
  return async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    const hit = routes[key] || routes[`${init.method || 'GET'} *`];
    if (!hit)
      return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
    return {
      ok: hit.status < 400,
      status: hit.status,
      json: async () => hit.body,
    };
  };
}

function makeSession({
  view = fakeView(),
  fetchRoutes = {},
  storage = fakeStorage(),
} = {}) {
  FakeClient.instances = [];
  const timers = [];
  const session = new RoomSession({
    view,
    location: LOCATION,
    storage,
    fetchImpl: fakeFetch({
      'POST /api/rooms': {
        status: 201,
        body: { roomId: 'ABC234', joinToken: 'tok' },
      },
      'GET /api/rooms/ABC234': { status: 200, body: { roomId: 'ABC234' } },
      'GET /api/rooms/ZZZZZZ': {
        status: 404,
        body: { error: 'Room not found' },
      },
      ...fetchRoutes,
    }),
    createClient: (options) => new FakeClient(options),
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    setInterval: (fn) => ({ fn }),
    clearInterval: () => {},
    now: () => 1000,
  });
  const client = () => FakeClient.instances.at(-1);
  const hello = (overrides = {}) =>
    client().emit('hello', {
      type: 'hello',
      roomId: 'ABC234',
      memberId: 'me',
      name: 'Alice',
      color: '#fff',
      members: [{ id: 'me', name: 'Alice', color: '#fff' }],
      leaderId: 'me',
      state: null,
      chat: [],
      moments: [],
      ...overrides,
    });
  return { session, view, storage, client, hello, timers };
}

test('roomCodeFromUrl reads ?room= and ignores junk', () => {
  assert.equal(roomCodeFromUrl('https://x.test/?room=abc234#lat=1'), 'ABC234');
  assert.equal(roomCodeFromUrl('https://x.test/?room=nope'), null);
  assert.equal(roomCodeFromUrl('https://x.test/'), null);
  assert.equal(roomCodeFromUrl('::'), null);
});

test('create → join: probes the room, remembers the name, becomes leader, broadcasts state on change', async () => {
  const { session, view, storage, client, hello } = makeSession();
  const roomId = await session.create('  Alice  ');
  assert.equal(roomId, 'ABC234');
  assert.equal(storage.getItem(NAME_STORAGE_KEY), 'Alice');
  assert.equal(client().options.token, 'tok');
  assert.equal(client().options.name, 'Alice');
  assert.equal(session.state.phase, 'connecting');
  assert.equal(session.joinLink, 'https://gev.example/?room=ABC234');

  hello();
  assert.equal(session.state.phase, 'joined');
  assert.ok(session.isLeader);
  assert.equal(
    client().sentOf('state').length,
    1,
    'leader pushes state immediately',
  );
  assert.equal(client().sentOf('state')[0].state.camera.lon, CAMERA.lon);
  // Same view → no re-send inside the keepalive window.
  session._leaderTick();
  assert.equal(client().sentOf('state').length, 1);
  view.camera = { ...CAMERA, lon: -121 };
  session._leaderTick();
  assert.equal(client().sentOf('state').length, 2);
  // Leaders never apply their own or anyone's state.
  client().emit('state', {
    type: 'state',
    from: 'x',
    state: { camera: CAMERA },
  });
  assert.equal(view.applied.length, 0);
});

test('joiner follows: hello state, live state, manual move pauses, rejoin snaps back, unfollow/follow', async () => {
  const { session, view, client, hello } = makeSession();
  await session.join('abc-234', 'Bob');
  hello({
    memberId: 'bob',
    name: 'Bob',
    members: [
      { id: 'alice', name: 'Alice', color: '#f00' },
      { id: 'bob', name: 'Bob', color: '#0f0' },
    ],
    leaderId: 'alice',
    state: {
      camera: { ...CAMERA, lon: 10 },
      style: 'noir',
      layers: [],
      tracked: null,
      scene: null,
    },
  });
  assert.ok(!session.isLeader);
  assert.equal(view.applied.length, 1, 'hello state is applied on join');
  assert.equal(view.applied[0].mode, 'follow');
  assert.equal(view.applied[0].state.camera.lon, 10);
  assert.equal(session.leader.name, 'Alice');

  client().emit('state', {
    type: 'state',
    from: 'alice',
    state: { camera: { ...CAMERA, lon: 11 } },
  });
  assert.equal(view.applied.length, 2);
  assert.equal(session.state.leaderState.camera.lon, 11);

  // User grabs the globe → following pauses, later frames are ignored.
  view.manualMove();
  assert.ok(session.state.overridden);
  assert.ok(session.state.following);
  client().emit('state', {
    type: 'state',
    from: 'alice',
    state: { camera: { ...CAMERA, lon: 12 } },
  });
  assert.equal(view.applied.length, 2);
  assert.equal(
    session.state.leaderState.camera.lon,
    12,
    'latest leader state is still remembered',
  );

  // Rejoin releases the camera and jumps to the latest leader state.
  session.rejoinLeader();
  assert.equal(view.released, 1);
  assert.equal(view.applied.length, 3);
  assert.equal(view.applied[2].mode, 'jump');
  assert.equal(view.applied[2].state.camera.lon, 12);
  assert.ok(!session.state.overridden);

  // Unfollow: nothing applies; follow again snaps back.
  session.setFollowing(false);
  client().emit('state', {
    type: 'state',
    from: 'alice',
    state: { camera: { ...CAMERA, lon: 13 } },
  });
  assert.equal(view.applied.length, 3);
  session.setFollowing(true);
  assert.equal(view.applied.length, 4);
  assert.equal(view.applied[3].state.camera.lon, 13);

  // Manual moves made while WE apply are not manual.
  session._follow.whileApplying(() => view.manualMove());
  assert.ok(!session.state.overridden);
});

test('lead transfer flips roles: follower→leader starts broadcasting, leader→follower stops and follows', async () => {
  const { session, view, client, hello } = makeSession();
  await session.join('ABC234', 'Bob');
  hello({
    memberId: 'bob',
    members: [
      { id: 'alice', name: 'Alice', color: '#f00' },
      { id: 'bob', name: 'Bob', color: '#0f0' },
    ],
    leaderId: 'alice',
  });
  assert.equal(client().sentOf('state').length, 0);
  assert.ok(session.takeLead());
  assert.deepEqual(client().sentOf('lead'), [{ type: 'lead', action: 'take' }]);
  client().emit('lead', {
    type: 'lead',
    leaderId: 'bob',
    by: 'bob',
    reason: 'take',
  });
  assert.ok(session.isLeader);
  assert.equal(
    client().sentOf('state').length,
    1,
    'new leader pushes state at once',
  );
  assert.match(session.state.notice, /You are leading/);
  assert.ok(session.handOff('alice'));
  client().emit('lead', {
    type: 'lead',
    leaderId: 'alice',
    by: 'bob',
    reason: 'handoff',
  });
  assert.ok(!session.isLeader);
  client().emit('state', {
    type: 'state',
    from: 'alice',
    state: { camera: { ...CAMERA, lon: 5 } },
  });
  assert.equal(
    view.applied.at(-1).state.camera.lon,
    5,
    'back to following after handing off',
  );
  assert.equal(session.handOff('alice'), false, 'only the leader hands off');
});

test('chat, pings and moments flow through; moment jump pauses following', async () => {
  const { session, view, client, hello, timers } = makeSession();
  await session.join('ABC234', 'Bob');
  hello({
    memberId: 'bob',
    leaderId: 'alice',
    members: [
      { id: 'alice', name: 'Alice', color: '#f00' },
      { id: 'bob', name: 'Bob', color: '#0f0' },
    ],
  });
  assert.ok(session.sendChat('  hello  '));
  assert.deepEqual(client().sentOf('chat'), [{ type: 'chat', text: 'hello' }]);
  assert.equal(session.sendChat('   '), false);
  client().emit('chat', {
    type: 'chat',
    id: 'c1',
    from: { id: 'alice', name: 'Alice' },
    text: 'hi',
    t: 1,
  });
  assert.equal(session.state.chat.length, 1);

  assert.ok(session.pingHere('look'));
  assert.deepEqual(client().sentOf('ping'), [
    { type: 'ping', lon: 1, lat: 2, label: 'look' },
  ]);
  client().emit('ping', {
    type: 'ping',
    id: 'p1',
    from: { id: 'alice', name: 'Alice', color: '#f00' },
    lon: 1,
    lat: 2,
    label: 'look',
    t: 1,
    ttlMs: 20000,
  });
  assert.equal(view.pings.length, 1);
  assert.equal(session.state.pings.length, 1);
  timers.at(-1)();
  assert.equal(
    session.state.pings.length,
    0,
    'ping expires from state after its TTL',
  );

  assert.ok(session.shareMoment('nice view'));
  const event = client().sentOf('event')[0];
  assert.equal(event.note, 'nice view');
  assert.equal(event.state.style, 'noir');
  const moment = {
    id: 'e1',
    from: { id: 'alice', name: 'Alice' },
    note: 'x',
    state: { camera: { ...CAMERA, lon: 99 }, layers: ['vessels'] },
    t: 1,
  };
  client().emit('event', { type: 'event', moment });
  assert.equal(session.state.moments.length, 1);
  const before = view.applied.length;
  assert.ok(session.jumpToMoment('e1'));
  assert.equal(view.applied.length, before + 1);
  assert.equal(view.applied.at(-1).mode, 'jump');
  assert.equal(view.applied.at(-1).state.camera.lon, 99);
  assert.ok(session.state.overridden, 'jumping to a moment pauses following');
  assert.equal(session.jumpToMoment('nope'), false);

  client().emit('error', {
    type: 'error',
    code: 'RATE_LIMITED',
    message: 'slow',
  });
  assert.match(session.state.notice, /Slow down/);
});

test('join errors: bad code, unknown room; leave cleans up; reconnect status surfaces', async () => {
  const { session, view, client, hello } = makeSession();
  await assert.rejects(session.join('12', 'Bob'), /not a room code/);
  await assert.rejects(session.join('ZZZZZZ', 'Bob'), /not found/);
  await session.join('ABC234', 'Bob');
  hello({
    memberId: 'bob',
    leaderId: 'alice',
    members: [
      { id: 'alice', name: 'Alice', color: '#f00' },
      { id: 'bob', name: 'Bob', color: '#0f0' },
    ],
  });
  assert.equal(typeof view.manualMove, 'function');
  client().emit('status', { status: 'reconnecting', attempt: 1 });
  assert.equal(session.state.phase, 'reconnecting');
  assert.equal(session.state.connection, 'reconnecting');
  client().emit('status', { status: 'open', attempt: 0 });
  assert.equal(session.state.connection, 'open');
  client().emit('status', { status: 'failed', reason: 'Room is full' });
  assert.equal(session.state.phase, 'failed');
  assert.equal(session.state.error, 'Room is full');
  assert.ok(!session.inRoom);
  const c = client();
  session.leave();
  assert.ok(c.closed);
  assert.equal(view.manualMove, null, 'manual-move listener removed');
  assert.equal(view.cleared, 1);
  assert.equal(session.state.roomId, null);
  assert.equal(session.state.phase, 'idle');
});

test('RoomClient: url shape, exponential backoff, reconnect after drop, fatal close codes, user close', () => {
  const delays = [0, 1, 2, 3].map((attempt) =>
    backoffDelay(attempt, () => 0.5),
  );
  assert.deepEqual(delays, [600, 1200, 2400, 4800]);
  assert.equal(
    backoffDelay(30, () => 0.5),
    15_000,
  );

  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  const timers = [];
  const statuses = [];
  const client = new RoomClient({
    roomId: 'ABC234',
    name: 'Bob',
    location: LOCATION,
    WebSocketImpl: FakeSocket,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    random: () => 0.5,
  });
  client.on('status', (s) => statuses.push(s.status));
  const hellos = [];
  client.on('hello', (m) => hellos.push(m));
  client.connect();
  assert.equal(
    sockets[0].url,
    'wss://gev.example/api/rooms/ABC234/ws?name=Bob',
  );
  assert.equal(client.send({ type: 'chat' }), false, 'not open yet');
  sockets[0].open();
  assert.ok(client.open);
  sockets[0].onmessage({
    data: JSON.stringify({ type: 'hello', memberId: 'x' }),
  });
  sockets[0].onmessage({ data: 'not json' });
  assert.equal(hellos.length, 1);
  assert.ok(client.send({ type: 'chat', text: 'hi' }));
  assert.equal(JSON.parse(sockets[0].sent[0]).text, 'hi');

  sockets[0].drop();
  assert.equal(client.status, 'reconnecting');
  timers.at(-1)(); // reconnect fires
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(client.status, 'open');

  sockets[1].drop(1008); // server refused → fatal
  assert.equal(client.status, 'failed');
  assert.deepEqual(statuses, [
    'connecting',
    'open',
    'reconnecting',
    'reconnecting',
    'open',
    'failed',
  ]);

  const timersBefore = timers.length;
  const client2 = new RoomClient({
    roomId: 'ABC234',
    name: 'Bob',
    location: { ...LOCATION, protocol: 'http:', host: 'localhost:4176' },
    WebSocketImpl: FakeSocket,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
  });
  client2.connect();
  assert.equal(
    sockets.at(-1).url,
    'ws://localhost:4176/api/rooms/ABC234/ws?name=Bob',
  );
  sockets.at(-1).open();
  client2.close();
  assert.equal(client2.status, 'closed');
  const count = sockets.length;
  timers.slice(timersBefore).forEach((fn) => fn());
  assert.equal(sockets.length, count, 'no reconnect after a user close');
});
