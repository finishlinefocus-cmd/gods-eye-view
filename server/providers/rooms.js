import { ROOM_LIMITS } from '../../src/rooms/protocol.js';
import { createRoomStore } from './rooms/store.js';
import {
  allowedOriginsFromEnv,
  attachRoomsSocket,
  corsHeaders,
  createRoomsMiddleware,
  originAllowed,
  parseRoomPath,
} from './rooms/transport.js';

export { createRoomStore, RoomError } from './rooms/store.js';
export {
  allowedOriginsFromEnv,
  attachRoomsSocket,
  corsHeaders,
  createRoomsMiddleware,
  originAllowed,
  parseRoomPath,
};

/** Room lifetime after the last member leaves; `GEV_ROOMS_EXPIRY_MS` overrides for tests. */
export function roomsExpiryMs(env = process.env) {
  const value = Number(env.GEV_ROOMS_EXPIRY_MS);
  return Number.isFinite(value) && value > 0 ? value : ROOM_LIMITS.expiryMs;
}

/**
 * Vite plugin: shared live sessions ("Rooms") — in-memory, no accounts.
 * Registers `/api/rooms` routes and attaches the WebSocket endpoint to the dev
 * or preview server's own `httpServer`.
 */
export function roomsProvider(options = {}) {
  let store = null;
  let detach = () => {};
  const install = (server) => {
    detach();
    store?.clear();
    store = createRoomStore({ expiryMs: roomsExpiryMs(), ...options });
    server.middlewares.use('/api/rooms', createRoomsMiddleware(store, options));
    detach = attachRoomsSocket(server.httpServer, store, options);
    if (!server.httpServer) {
      console.warn(
        '[rooms] no httpServer (middleware mode); room sockets are unavailable.',
      );
    }
    server.httpServer?.once?.('close', () => {
      detach();
      store?.clear();
    });
  };
  return {
    name: 'rooms-provider',
    configureServer: install,
    configurePreviewServer: install,
  };
}
