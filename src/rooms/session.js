import { RoomClient } from './client.js';
import { FollowController, stateKey } from './follow.js';
import {
  ROOM_LIMITS,
  normalizeRoomCode,
  roomJoinLink,
  sanitizeName,
} from './protocol.js';

/**
 * One browser's membership in a room: connection, presence, leader/follower
 * roles, chat, pings and moments. Everything that touches the globe goes
 * through the injected `view` adapter so this module stays testable.
 *
 * view = {
 *   getState()                       → {camera, style, layers, tracked, scene}
 *   applyState(state, {mode})        → void   mode: 'follow' | 'jump'
 *   releaseCamera()                  → boolean (false when the app refuses, e.g. Cockpit)
 *   onManualMove(cb)                 → dispose
 *   pingTarget()                     → {lon, lat, label?} | null
 *   showPing(ping)                   → void
 *   clearPings()                     → void
 * }
 */

export const NAME_STORAGE_KEY = 'gev.rooms.displayName';
const LEADER_TICK_MS = ROOM_LIMITS.stateMinIntervalMs;
const LEADER_KEEPALIVE_MS = 4000;

function emptyState() {
  return {
    phase: 'idle', // idle | connecting | joined | reconnecting | failed
    connection: 'idle',
    roomId: null,
    joinToken: null,
    memberId: null,
    me: null,
    members: [],
    leaderId: null,
    following: true,
    overridden: false,
    chat: [],
    moments: [],
    pings: [],
    leaderState: null,
    error: null,
    notice: null,
  };
}

export class RoomSession {
  constructor({
    view,
    location = globalThis.location,
    storage = globalThis.localStorage,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    createClient = (options) => new RoomClient(options),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    setInterval: setRepeat = (fn, ms) => setInterval(fn, ms),
    clearInterval: clearRepeat = (timer) => clearInterval(timer),
    now = () => Date.now(),
  } = {}) {
    this._view = view;
    this._location = location;
    this._storage = storage;
    this._fetch = fetchImpl;
    this._createClient = createClient;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._setRepeat = setRepeat;
    this._clearRepeat = clearRepeat;
    this._now = now;
    this._listeners = new Set();
    this._client = null;
    this._clientDisposers = [];
    this._leaderTimer = null;
    this._lastSentKey = '';
    this._lastSentAt = 0;
    this._pingTimers = new Map();
    this._follow = new FollowController({ following: true });
    this._manualMoveDispose = null;
    this._lastAppliedLayersKey = null;
    this.state = emptyState();
  }

  /* ── observation ─────────────────────────────────────────────────────── */

  subscribe(listener) {
    this._listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      /* no-op */
    }
    return () => this._listeners.delete(listener);
  }

  _update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this._listeners]) {
      try {
        listener(this.state);
      } catch (error) {
        console.warn('[rooms] subscriber failed', error);
      }
    }
  }

  get inRoom() {
    return Boolean(this.state.roomId) && this.state.phase !== 'failed';
  }

  get isLeader() {
    return (
      Boolean(this.state.memberId) &&
      this.state.leaderId === this.state.memberId
    );
  }

  get joinLink() {
    return this.state.roomId
      ? roomJoinLink(this._location.origin, this.state.roomId)
      : null;
  }

  get leader() {
    return this.state.members.find((m) => m.id === this.state.leaderId) || null;
  }

  /* ── display name ────────────────────────────────────────────────────── */

  get rememberedName() {
    try {
      return this._storage?.getItem(NAME_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  rememberName(name) {
    try {
      this._storage?.setItem(NAME_STORAGE_KEY, sanitizeName(name));
    } catch {
      /* private mode */
    }
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */

  async create(name) {
    if (!this._fetch) throw new Error('fetch unavailable');
    const response = await this._fetch('/api/rooms', { method: 'POST' });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* fallthrough */
    }
    if (!response.ok || !body?.roomId) {
      throw new Error(
        body?.error || `Could not create a room (${response.status})`,
      );
    }
    await this.join(body.roomId, name, { token: body.joinToken });
    return body.roomId;
  }

  async join(codeOrLink, name, { token = null } = {}) {
    const roomId = normalizeRoomCode(codeOrLink);
    if (!roomId) throw new Error('That is not a room code');
    const displayName = sanitizeName(name || this.rememberedName);
    this.rememberName(displayName);
    if (this.state.roomId) this.leave({ silent: true });
    if (this._fetch) {
      const probe = await this._fetch(`/api/rooms/${roomId}`);
      if (probe.status === 404) throw new Error('Room not found or expired');
      if (!probe.ok) throw new Error(`Room unavailable (${probe.status})`);
    }
    this._follow = new FollowController({ following: true });
    this._lastSentKey = '';
    this._lastAppliedLayersKey = null;
    this._update({
      ...emptyState(),
      phase: 'connecting',
      connection: 'connecting',
      roomId,
      joinToken: token,
      following: true,
      overridden: false,
    });
    const client = this._createClient({
      roomId,
      name: displayName,
      token,
      location: this._location,
    });
    this._client = client;
    this._bindClient(client);
    client.connect();
    return roomId;
  }

  leave({ silent = false } = {}) {
    this._stopLeaderLoop();
    this._manualMoveDispose?.();
    this._manualMoveDispose = null;
    for (const disposer of this._clientDisposers) disposer();
    this._clientDisposers = [];
    if (this._client) {
      const client = this._client;
      this._client = null;
      client.close();
    }
    for (const timer of this._pingTimers.values()) this._clearTimer(timer);
    this._pingTimers.clear();
    this._view?.clearPings?.();
    if (!silent) this._update(emptyState());
  }

  destroy() {
    this.leave({ silent: true });
    this._listeners.clear();
  }

  /* ── client wiring ───────────────────────────────────────────────────── */

  _bindClient(client) {
    const on = (type, handler) =>
      this._clientDisposers.push(client.on(type, handler));
    on('status', ({ status, reason, attempt }) => {
      if (client !== this._client) return;
      if (status === 'open') {
        this._update({ connection: 'open', error: null });
      } else if (status === 'reconnecting') {
        this._update({
          connection: 'reconnecting',
          phase: this.state.memberId ? 'reconnecting' : 'connecting',
          notice: attempt ? `Reconnecting (attempt ${attempt})…` : null,
        });
        this._stopLeaderLoop();
      } else if (status === 'failed') {
        this._stopLeaderLoop();
        this._update({
          connection: 'failed',
          phase: 'failed',
          error: reason || 'Connection failed',
        });
      } else if (status === 'closed' && this.state.roomId) {
        this._update({ connection: 'closed' });
      }
    });
    on('hello', (hello) => this._onHello(hello));
    on('presence', (presence) => {
      const wasLeader = this.isLeader;
      this._update({ members: presence.members, leaderId: presence.leaderId });
      this._syncRole(wasLeader);
    });
    on('lead', (lead) => {
      const wasLeader = this.isLeader;
      const by = this.state.members.find((m) => m.id === lead.by);
      const leader = this.state.members.find((m) => m.id === lead.leaderId);
      const notice =
        lead.leaderId === this.state.memberId
          ? lead.reason === 'handoff'
            ? `${by?.name || 'The leader'} handed you the lead`
            : 'You are leading'
          : lead.reason === 'take'
            ? `${leader?.name || 'Someone'} took the lead`
            : lead.reason === 'leader-left'
              ? `${leader?.name || 'Someone'} now leads`
              : lead.reason === 'handoff'
                ? `${leader?.name || 'Someone'} was handed the lead`
                : null;
      this._update({ leaderId: lead.leaderId, notice });
      this._syncRole(wasLeader);
    });
    on('state', ({ state }) => this._onLeaderState(state));
    on('chat', (entry) => this._pushChat(entry));
    on('ping', (ping) => this._onPing(ping));
    on('event', ({ moment }) => this._pushMoment(moment));
    on('error', (error) => {
      if (error.code === 'RATE_LIMITED') {
        this._update({
          notice: 'Slow down — chat is limited to 5 messages per 5 s',
        });
      } else if (error.code !== 'NOT_LEADER') {
        this._update({ notice: error.message || error.code });
      }
    });
  }

  _onHello(hello) {
    const wasLeader = this.isLeader;
    const me = { id: hello.memberId, name: hello.name, color: hello.color };
    this._update({
      phase: 'joined',
      connection: 'open',
      memberId: hello.memberId,
      me,
      members: hello.members,
      leaderId: hello.leaderId,
      chat: hello.chat || [],
      moments: hello.moments || [],
      leaderState: hello.state || null,
      error: null,
      notice: null,
    });
    if (!this._manualMoveDispose && this._view?.onManualMove) {
      this._manualMoveDispose = this._view.onManualMove(() =>
        this._onManualMove(),
      );
    }
    this._syncRole(wasLeader);
    if (!this.isLeader && hello.state && this._follow.active) {
      this._applyLeaderState(hello.state, 'follow');
    }
  }

  _syncRole(wasLeader) {
    const leader = this.isLeader;
    if (leader && !wasLeader) {
      this._follow.overridden = false;
      this._update({ overridden: false });
      this._startLeaderLoop();
    } else if (!leader && wasLeader) {
      this._stopLeaderLoop();
    } else if (
      leader &&
      !this._leaderTimer &&
      this.state.connection === 'open'
    ) {
      this._startLeaderLoop();
    }
  }

  /* ── leader broadcast ────────────────────────────────────────────────── */

  _startLeaderLoop() {
    this._stopLeaderLoop();
    this._lastSentKey = '';
    this._leaderTimer = this._setRepeat(
      () => this._leaderTick(),
      LEADER_TICK_MS,
    );
    this._leaderTick();
  }

  _stopLeaderLoop() {
    if (this._leaderTimer) this._clearRepeat(this._leaderTimer);
    this._leaderTimer = null;
  }

  _leaderTick() {
    if (!this.isLeader || !this._client?.open) return;
    let state;
    try {
      state = this._view?.getState?.();
    } catch (error) {
      console.warn('[rooms] getState failed', error);
      return;
    }
    if (!state?.camera) return;
    const key = stateKey(state);
    const t = this._now();
    if (key === this._lastSentKey && t - this._lastSentAt < LEADER_KEEPALIVE_MS)
      return;
    if (this._client.send({ type: 'state', state })) {
      this._lastSentKey = key;
      this._lastSentAt = t;
    }
  }

  /** Broadcast immediately (used by voice/UI after an explicit change). */
  pushState() {
    this._lastSentKey = '';
    this._leaderTick();
  }

  /* ── following ───────────────────────────────────────────────────────── */

  _onLeaderState(state) {
    this._update({ leaderState: state });
    if (this.isLeader) return;
    if (!this._follow.active) return;
    this._applyLeaderState(state, 'follow');
  }

  _applyLeaderState(state, mode) {
    if (!this._view?.applyState) return;
    this._follow.whileApplying(() => {
      try {
        this._view.applyState(state, { mode });
      } catch (error) {
        console.warn('[rooms] applyState failed', error);
      }
    });
  }

  _onManualMove() {
    if (this.isLeader) return;
    if (this._follow.noteManualMove()) {
      this._update({
        overridden: true,
        notice: 'You moved — following paused',
      });
    }
  }

  setFollowing(value) {
    const active = this._follow.setFollowing(value);
    this._update({
      following: this._follow.following,
      overridden: false,
      notice: null,
    });
    if (active && !this.isLeader) this._snapToLeader();
    return this._follow.following;
  }

  rejoinLeader() {
    this._follow.rejoin();
    this._update({ following: true, overridden: false, notice: null });
    if (!this.isLeader) this._snapToLeader();
  }

  _snapToLeader() {
    const released = this._view?.releaseCamera?.();
    if (released === false) {
      this._update({ notice: 'Exit Cockpit to follow the leader' });
      return;
    }
    if (this.state.leaderState) {
      this._applyLeaderState(this.state.leaderState, 'jump');
    }
  }

  /* ── leadership ──────────────────────────────────────────────────────── */

  takeLead() {
    if (!this._client?.open) return false;
    if (this.isLeader) return true;
    return this._client.send({ type: 'lead', action: 'take' });
  }

  handOff(memberId) {
    if (!this._client?.open || !this.isLeader) return false;
    return this._client.send({ type: 'lead', action: 'handoff', to: memberId });
  }

  /* ── chat / pings / moments ──────────────────────────────────────────── */

  sendChat(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !this._client?.open) return false;
    return this._client.send({
      type: 'chat',
      text: trimmed.slice(0, ROOM_LIMITS.chatMax),
    });
  }

  _pushChat(entry) {
    const chat = [...this.state.chat, entry].slice(-ROOM_LIMITS.chatKeep);
    this._update({ chat });
  }

  pingHere(label = '') {
    if (!this._client?.open) return false;
    const target = this._view?.pingTarget?.();
    if (!target) {
      this._update({ notice: 'Nothing under the crosshair to ping' });
      return false;
    }
    return this._client.send({
      type: 'ping',
      lon: target.lon,
      lat: target.lat,
      label: label || target.label || '',
    });
  }

  _onPing(ping) {
    const pings = [...this.state.pings.filter((p) => p.id !== ping.id), ping];
    this._update({ pings });
    try {
      this._view?.showPing?.(ping);
    } catch (error) {
      console.warn('[rooms] showPing failed', error);
    }
    const ttl = ping.ttlMs || ROOM_LIMITS.pingTtlMs;
    const timer = this._setTimer(() => {
      this._pingTimers.delete(ping.id);
      this._update({ pings: this.state.pings.filter((p) => p.id !== ping.id) });
    }, ttl);
    this._pingTimers.set(ping.id, timer);
  }

  shareMoment(note = '') {
    if (!this._client?.open) return false;
    const state = this._view?.getState?.();
    if (!state?.camera) return false;
    return this._client.send({
      type: 'event',
      note: String(note || '').slice(0, ROOM_LIMITS.noteMax),
      state,
    });
  }

  _pushMoment(moment) {
    const moments = [...this.state.moments, moment].slice(
      -ROOM_LIMITS.momentsKeep,
    );
    this._update({ moments });
  }

  jumpToMoment(momentId) {
    const moment = this.state.moments.find((m) => m.id === momentId);
    if (!moment) return false;
    if (!this.isLeader && this._follow.following && !this._follow.overridden) {
      // Jumping away from the leader is a deliberate detour.
      this._follow.overridden = true;
      this._update({
        overridden: true,
        notice: 'Viewing a moment — following paused',
      });
    }
    const released = this._view?.releaseCamera?.();
    if (released === false) {
      this._update({ notice: 'Exit Cockpit to jump to a moment' });
      return false;
    }
    this._applyLeaderState(moment.state, 'jump');
    return true;
  }

  clearNotice() {
    if (this.state.notice) this._update({ notice: null });
  }
}

/** Read `?room=CODE` from a page URL; null when absent or malformed. */
export function roomCodeFromUrl(href) {
  try {
    const url = new URL(href);
    const raw = url.searchParams.get('room');
    return raw ? normalizeRoomCode(raw) : null;
  } catch {
    return null;
  }
}
