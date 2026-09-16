import { createRequire } from 'node:module';
import { isRoomCode, ROOM_LIMITS } from '../../../src/rooms/protocol.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { RoomError } from './store.js';

/**
 * HTTP routes and the WebSocket upgrade handler for rooms.
 *
 *   POST /api/rooms            → { roomId, joinToken }
 *   GET  /api/rooms/:id        → summary
 *   WS   /api/rooms/:id/ws?name=<display>[&token=<joinToken>]
 *
 * Vite's own HMR listener only claims upgrades whose `Sec-WebSocket-Protocol`
 * is `vite-hmr`/`vite-ping` on the HMR path, so a second `upgrade` listener on
 * the same `httpServer` can own `/api/rooms/:id/ws` without interfering.
 */

const WS_PATH = /^\/api\/rooms\/([A-Z0-9]{6})\/ws\/?$/;
const HEARTBEAT_MS = 25_000;
const MAX_FRAMES_PER_SECOND = 40;

/** @type {any} */
let _wsModule;
function loadWs() {
  if (_wsModule !== undefined) return _wsModule;
  try {
    _wsModule = createRequire(import.meta.url)('ws');
  } catch (error) {
    _wsModule = null;
    console.warn(
      '[rooms] `ws` is unavailable; shared rooms are off.',
      error?.message || '',
    );
  }
  return _wsModule;
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function errorStatus(error) {
  return error instanceof RoomError ? error.status : 500;
}

/** Parse the `/:id` or `/:id/...` segment the middleware sees under `/api/rooms`. */
export function parseRoomPath(pathname) {
  const match = /^\/([A-Za-z0-9]{1,16})\/?$/.exec(pathname || '');
  if (!match) return null;
  const id = match[1].toUpperCase();
  return isRoomCode(id) ? id : null;
}

/**
 * Same-origin policy for the socket. Browsers always send `Origin`; a
 * non-browser client (our verification script) sends none and is allowed.
 * Behind a reverse proxy the public host arrives in `X-Forwarded-Host`.
 */
export function originAllowed(headers, { allowedOrigins = [] } = {}) {
  const origin = headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [headers.host, headers['x-forwarded-host']]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.includes(originHost)) return true;
  return allowedOrigins.some(
    (allowed) => allowed.toLowerCase() === origin.toLowerCase(),
  );
}

function allowedOriginsFromEnv(env = process.env) {
  return String(env.GEV_ROOMS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** connect-style middleware for `/api/rooms`. */
export function createRoomsMiddleware(store, { createLimiter } = {}) {
  const allowCreate =
    createLimiter || makeRateLimiter({ windowMs: 60_000, max: 12 });
  return function roomsMiddleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (pathname === '/') {
        if (req.method === 'POST') {
          if (!allowCreate(clientKey(req))) {
            sendJson(res, 429, {
              error: 'Too many rooms created; wait a minute',
            });
            return;
          }
          sendJson(res, 201, store.createRoom());
          return;
        }
        sendJson(res, 405, { error: 'POST to create a room' });
        return;
      }
      if (WS_PATH.test(`/api/rooms${pathname}`)) {
        // A plain HTTP hit on the socket path: tell the client what it is.
        sendJson(res, 426, { error: 'WebSocket upgrade required' });
        return;
      }
      const roomId = parseRoomPath(pathname);
      if (!roomId) {
        next();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'GET only' });
        return;
      }
      sendJson(res, 200, store.summary(roomId));
    } catch (error) {
      sendJson(res, errorStatus(error), {
        error: error?.message || 'Room error',
        code: error?.code || 'ROOM_ERROR',
      });
    }
  };
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

/**
 * Attach the rooms WebSocket endpoint to an `http.Server`. Returns a detach
 * function. `ws` is resolved lazily so environments without it degrade to
 * "rooms off" instead of failing to boot the dev server.
 */
export function attachRoomsSocket(
  httpServer,
  store,
  { wsModule = loadWs(), allowedOrigins = allowedOriginsFromEnv() } = {},
) {
  if (!httpServer || !wsModule) return () => {};
  const { WebSocketServer } = wsModule;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: ROOM_LIMITS.messageBytesMax,
    perMessageDeflate: false,
  });

  const onUpgrade = (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return;
    }
    const match = WS_PATH.exec(url.pathname);
    if (!match) return; // not ours; leave it to other listeners
    const roomId = match[1];
    if (!isRoomCode(roomId) || !store.hasRoom(roomId)) {
      rejectUpgrade(socket, 404, 'Room not found');
      return;
    }
    if (!originAllowed(req.headers, { allowedOrigins })) {
      console.warn(
        `[rooms] refused socket from origin ${req.headers.origin} (host ${req.headers.host})`,
      );
      rejectUpgrade(socket, 403, 'Origin not allowed');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, {
        roomId,
        name: url.searchParams.get('name') || '',
        token: url.searchParams.get('token') || null,
      });
    });
  };

  wss.on('connection', (ws, _req, { roomId, name, token }) => {
    let member;
    const sink = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    try {
      member = store.join(roomId, { name, token, send: sink });
    } catch (error) {
      sink({
        type: 'error',
        code: error?.code || 'JOIN_FAILED',
        message: error?.message || 'Could not join',
      });
      ws.close(1008, error?.code || 'JOIN_FAILED');
      return;
    }
    let alive = true;
    let frameTimes = [];
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const t = Date.now();
      frameTimes = frameTimes.filter((time) => t - time < 1000);
      if (frameTimes.length >= MAX_FRAMES_PER_SECOND) {
        ws.close(1008, 'FLOOD');
        return;
      }
      frameTimes.push(t);
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        sink({ type: 'error', code: 'BAD_JSON', message: 'Not JSON' });
        return;
      }
      let reply;
      try {
        reply = store.handleMessage(roomId, member.id, parsed);
      } catch (error) {
        reply = {
          type: 'error',
          code: error?.code || 'ROOM_ERROR',
          message: error?.message || 'Room error',
        };
      }
      if (reply) sink(reply);
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      store.leave(roomId, member.id);
    };
    ws.once('close', cleanup);
    ws.once('error', () => {
      try {
        ws.terminate();
      } catch {
        /* no-op */
      }
    });
  });

  httpServer.on('upgrade', onUpgrade);
  return () => {
    httpServer.off('upgrade', onUpgrade);
    for (const client of wss.clients) {
      try {
        client.close(1001, 'SERVER_SHUTDOWN');
      } catch {
        /* no-op */
      }
    }
    wss.close();
  };
}
