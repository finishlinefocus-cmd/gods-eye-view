import { roomSocketUrl } from './baseUrl.js';

/**
 * Room socket with reconnect. Emits every server message by its `type` plus a
 * synthetic `status` event: connecting → open → (reconnecting → open)* →
 * closed | failed. Failed means the server refused the join (unknown room,
 * room full) and retrying would not help.
 */

const BACKOFF_BASE_MS = 600;
const BACKOFF_MAX_MS = 15_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const FATAL_CLOSE_CODES = new Set([1008, 4404, 4409]);
const MAX_RECONNECT_ATTEMPTS = 10;

export function backoffDelay(attempt, random = Math.random) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(exp * (0.7 + random() * 0.6));
}

export class RoomClient {
  constructor({
    roomId,
    name,
    token = null,
    baseUrl = '',
    location = globalThis.location,
    WebSocketImpl = globalThis.WebSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    random = Math.random,
    maxAttempts = MAX_RECONNECT_ATTEMPTS,
  }) {
    this._maxAttempts = maxAttempts;
    this.roomId = roomId;
    this.name = name;
    this.token = token;
    this.baseUrl = baseUrl;
    this.url = roomSocketUrl(location, roomId, { name, token, baseUrl });
    this._WebSocket = WebSocketImpl;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._random = random;
    this._listeners = new Map();
    this._socket = null;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._closedByUser = false;
    this._everOpened = false;
    this.status = 'idle';
    this.lastError = null;
  }

  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this._listeners.get(type)?.delete(handler);
  }

  _emit(type, payload) {
    for (const handler of [...(this._listeners.get(type) || [])]) {
      try {
        handler(payload);
      } catch (error) {
        console.warn('[rooms] listener failed', error);
      }
    }
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this._emit('status', { status, attempt: this._attempt, ...extra });
  }

  get open() {
    return Boolean(this._socket) && this._socket.readyState === 1;
  }

  connect() {
    if (this._closedByUser) return;
    if (!this._WebSocket) {
      this.lastError = 'WebSocket unavailable';
      this._setStatus('failed', { reason: this.lastError });
      return;
    }
    this._setStatus(this._everOpened ? 'reconnecting' : 'connecting');
    let socket;
    try {
      socket = new this._WebSocket(this.url);
    } catch (error) {
      this.lastError = error?.message || 'socket error';
      this._scheduleReconnect();
      return;
    }
    this._socket = socket;
    socket.onopen = () => {
      if (this._socket !== socket) return;
      this._attempt = 0;
      this._everOpened = true;
      this._setStatus('open');
      this._startHeartbeat();
    };
    socket.onmessage = (event) => {
      if (this._socket !== socket) return;
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'error') this.lastError = message.message;
      this._emit('message', message);
      this._emit(message.type, message);
    };
    socket.onerror = () => {
      /* the close handler decides what to do */
    };
    socket.onclose = (event) => {
      if (this._socket !== socket) return;
      this._socket = null;
      this._stopHeartbeat();
      if (this._closedByUser) {
        this._setStatus('closed');
        return;
      }
      if (FATAL_CLOSE_CODES.has(event?.code)) {
        this.lastError = event?.reason || this.lastError || 'refused';
        this._setStatus('failed', { reason: this.lastError, code: event.code });
        return;
      }
      this._scheduleReconnect(event?.code);
    };
  }

  _scheduleReconnect(code) {
    if (this._closedByUser) return;
    if (this._attempt >= this._maxAttempts) {
      this.lastError = this.lastError || 'could not reach the room';
      this._setStatus('failed', { reason: this.lastError, code });
      return;
    }
    const delay = backoffDelay(this._attempt, this._random);
    this._attempt += 1;
    this._setStatus('reconnecting', { delayMs: delay, code });
    this._clearTimer(this._reconnectTimer);
    this._reconnectTimer = this._setTimer(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = this._setTimer(() => {
      this._heartbeatTimer = null;
      if (this.send({ type: 'heartbeat' })) this._startHeartbeat();
    }, CLIENT_HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) this._clearTimer(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  /** Send when open; returns false (and drops the frame) otherwise. */
  send(message) {
    if (!this.open) return false;
    try {
      this._socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this._closedByUser = true;
    this._clearTimer(this._reconnectTimer);
    this._reconnectTimer = null;
    this._stopHeartbeat();
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        socket.close(1000, 'leave');
      } catch {
        /* no-op */
      }
    }
    this._setStatus('closed');
  }
}
