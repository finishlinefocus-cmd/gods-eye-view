import { randomBytes, randomInt } from 'node:crypto';
import {
  MEMBER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_LIMITS,
  sanitizeName,
  sanitizePing,
  sanitizeText,
  sanitizeViewState,
} from '../../../src/rooms/protocol.js';

/**
 * In-memory room registry. Transport-agnostic: members are `{ send }` sinks and
 * every inbound message goes through `handleMessage`. Nothing is persisted.
 */

export class RoomError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function makeRoomId(taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let id = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      id += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!taken.has(id)) return id;
  }
  throw new RoomError('ROOM_ID_EXHAUSTED', 'Could not allocate a room', 503);
}

function makeToken() {
  return randomBytes(18).toString('base64url');
}

let memberSeq = 0;
let messageSeq = 0;

function nextMemberId() {
  memberSeq += 1;
  return `m${memberSeq.toString(36)}${randomBytes(3).toString('hex')}`;
}

function nextMessageId(prefix) {
  messageSeq += 1;
  return `${prefix}${messageSeq.toString(36)}`;
}

function publicMember(member) {
  return { id: member.id, name: member.name, color: member.color };
}

export function createRoomStore({
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  expiryMs = ROOM_LIMITS.expiryMs,
  maxRooms = ROOM_LIMITS.maxRooms,
  maxMembers = ROOM_LIMITS.maxMembers,
  chatWindowMs = ROOM_LIMITS.chatWindowMs,
  chatPerWindow = ROOM_LIMITS.chatPerWindow,
  stateMinIntervalMs = ROOM_LIMITS.stateMinIntervalMs,
  log = (line) => console.log(line),
} = {}) {
  /** @type {Map<string, object>} */
  const rooms = new Map();

  function pickColor(room) {
    const used = new Set([...room.members.values()].map((m) => m.color));
    return (
      MEMBER_COLORS.find((color) => !used.has(color)) ||
      MEMBER_COLORS[room.members.size % MEMBER_COLORS.length]
    );
  }

  function send(member, message) {
    try {
      member.send(message);
    } catch {
      /* a dead sink is cleaned up by its transport's close handler */
    }
  }

  function broadcast(room, message, { except = null } = {}) {
    for (const member of room.members.values()) {
      if (member.id !== except) send(member, message);
    }
  }

  function presence(room) {
    return {
      type: 'presence',
      members: [...room.members.values()].map(publicMember),
      leaderId: room.leaderId,
    };
  }

  function summary(room) {
    const leader = room.leaderId ? room.members.get(room.leaderId) : null;
    return {
      roomId: room.id,
      createdAt: room.createdAt,
      memberCount: room.members.size,
      members: [...room.members.values()].map(publicMember),
      leaderId: room.leaderId,
      leaderName: leader ? leader.name : null,
      momentCount: room.moments.length,
      hasState: Boolean(room.lastState),
    };
  }

  function expire(room) {
    if (!rooms.has(room.id)) return;
    rooms.delete(room.id);
    room.expiryTimer = null;
    log(
      `[rooms] expired ${room.id} after ${Math.round((now() - room.createdAt) / 1000)}s ` +
        `(${room.chat.length} chat, ${room.moments.length} moments)`,
    );
  }

  function armExpiry(room) {
    if (room.expiryTimer) clearTimer(room.expiryTimer);
    room.emptySince = now();
    room.expiryTimer = setTimer(() => expire(room), expiryMs);
  }

  function disarmExpiry(room) {
    if (room.expiryTimer) clearTimer(room.expiryTimer);
    room.expiryTimer = null;
    room.emptySince = null;
  }

  function setLeader(room, leaderId, reason, by) {
    if (room.leaderId === leaderId) return;
    room.leaderId = leaderId;
    room.lastStateAt = 0; // a new leader's first frame is never throttled
    broadcast(room, { type: 'lead', leaderId, by: by || null, reason });
    broadcast(room, presence(room));
  }

  function requireRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found', 404);
    return room;
  }

  function requireMember(room, memberId) {
    const member = room.members.get(memberId);
    if (!member)
      throw new RoomError('NOT_A_MEMBER', 'Not a member of this room', 403);
    return member;
  }

  return {
    createRoom() {
      if (rooms.size >= maxRooms) {
        throw new RoomError('ROOMS_FULL', 'Too many rooms right now', 503);
      }
      const id = makeRoomId(rooms);
      const room = {
        id,
        joinToken: makeToken(),
        createdAt: now(),
        members: new Map(),
        leaderId: null,
        lastState: null,
        lastStateAt: 0,
        chat: [],
        moments: [],
        expiryTimer: null,
        emptySince: null,
      };
      rooms.set(id, room);
      // A room nobody ever joins must still go away.
      armExpiry(room);
      log(`[rooms] created ${id}`);
      return { roomId: id, joinToken: room.joinToken };
    },

    hasRoom(roomId) {
      return rooms.has(roomId);
    },

    summary(roomId) {
      return summary(requireRoom(roomId));
    },

    /** Add a member; the `send(message)` sink receives every outbound frame. */
    join(roomId, { name, token = null, send: sink }) {
      const room = requireRoom(roomId);
      if (room.members.size >= maxMembers) {
        throw new RoomError('ROOM_FULL', 'Room is full', 409);
      }
      if (typeof sink !== 'function') {
        throw new RoomError('BAD_SINK', 'Member sink required', 500);
      }
      disarmExpiry(room);
      const member = {
        id: nextMemberId(),
        name: sanitizeName(name),
        color: pickColor(room),
        send: sink,
        joinedAt: now(),
        chatTimes: [],
        isCreator: Boolean(token) && token === room.joinToken,
      };
      room.members.set(member.id, member);
      const firstJoiner = room.members.size === 1;
      const becomesLeader =
        firstJoiner || room.leaderId === null || member.isCreator;
      send(member, {
        type: 'hello',
        roomId: room.id,
        memberId: member.id,
        name: member.name,
        color: member.color,
        members: [...room.members.values()].map(publicMember),
        leaderId: becomesLeader ? member.id : room.leaderId,
        state: room.lastState,
        chat: room.chat,
        moments: room.moments,
        serverTime: now(),
        limits: {
          chatMax: ROOM_LIMITS.chatMax,
          noteMax: ROOM_LIMITS.noteMax,
          pingTtlMs: ROOM_LIMITS.pingTtlMs,
        },
      });
      if (becomesLeader) {
        room.leaderId = member.id;
        broadcast(room, {
          type: 'lead',
          leaderId: member.id,
          by: member.id,
          reason: firstJoiner
            ? 'first'
            : member.isCreator
              ? 'creator'
              : 'vacant',
        });
      }
      broadcast(room, presence(room));
      return publicMember(member);
    },

    leave(roomId, memberId) {
      const room = rooms.get(roomId);
      if (!room) return;
      const member = room.members.get(memberId);
      if (!member) return;
      room.members.delete(memberId);
      if (room.members.size === 0) {
        room.leaderId = null;
        armExpiry(room);
        return;
      }
      if (room.leaderId === memberId) {
        // Oldest remaining member inherits the lead.
        const next = [...room.members.values()].sort(
          (a, b) => a.joinedAt - b.joinedAt,
        )[0];
        room.leaderId = null;
        setLeader(room, next.id, 'leader-left', memberId);
        return;
      }
      broadcast(room, presence(room));
    },

    /**
     * Route one inbound message. Returns the outbound reply for the sender (an
     * `error` frame, or null when nothing needs to be said back).
     */
    handleMessage(roomId, memberId, raw) {
      const room = requireRoom(roomId);
      const member = requireMember(room, memberId);
      const message = raw && typeof raw === 'object' ? raw : null;
      if (!message || typeof message.type !== 'string') {
        return { type: 'error', code: 'BAD_MESSAGE', message: 'Malformed' };
      }
      switch (message.type) {
        case 'heartbeat':
          return { type: 'heartbeat', t: now() };

        case 'state': {
          if (room.leaderId !== member.id) {
            return {
              type: 'error',
              code: 'NOT_LEADER',
              message: 'Only the leader broadcasts state',
            };
          }
          const state = sanitizeViewState(message.state);
          if (!state) {
            return {
              type: 'error',
              code: 'BAD_STATE',
              message: 'State needs a camera',
            };
          }
          const t = now();
          if (t - room.lastStateAt < stateMinIntervalMs) return null; // throttled
          room.lastStateAt = t;
          room.lastState = state;
          broadcast(
            room,
            { type: 'state', from: member.id, state, t },
            { except: member.id },
          );
          return null;
        }

        case 'lead': {
          const action = message.action;
          if (action === 'take') {
            setLeader(room, member.id, 'take', member.id);
            return null;
          }
          if (action === 'handoff') {
            if (room.leaderId !== member.id) {
              return {
                type: 'error',
                code: 'NOT_LEADER',
                message: 'Only the leader can hand off',
              };
            }
            const target =
              typeof message.to === 'string'
                ? room.members.get(message.to)
                : null;
            if (!target) {
              return {
                type: 'error',
                code: 'NO_SUCH_MEMBER',
                message: 'That member is not here',
              };
            }
            setLeader(room, target.id, 'handoff', member.id);
            return null;
          }
          return {
            type: 'error',
            code: 'BAD_LEAD_ACTION',
            message: 'lead.action must be take or handoff',
          };
        }

        case 'chat': {
          const text = sanitizeText(message.text, ROOM_LIMITS.chatMax);
          if (!text) {
            return {
              type: 'error',
              code: 'EMPTY_CHAT',
              message: 'Say something',
            };
          }
          const t = now();
          member.chatTimes = member.chatTimes.filter(
            (time) => t - time < chatWindowMs,
          );
          if (member.chatTimes.length >= chatPerWindow) {
            return {
              type: 'error',
              code: 'RATE_LIMITED',
              message: 'Slow down a little',
              retryInMs:
                chatWindowMs - (t - member.chatTimes[0]) || chatWindowMs,
            };
          }
          member.chatTimes.push(t);
          const entry = {
            type: 'chat',
            id: nextMessageId('c'),
            from: publicMember(member),
            text,
            t,
          };
          room.chat.push(entry);
          if (room.chat.length > ROOM_LIMITS.chatKeep) {
            room.chat.splice(0, room.chat.length - ROOM_LIMITS.chatKeep);
          }
          broadcast(room, entry);
          return null;
        }

        case 'ping': {
          const ping = sanitizePing(message);
          if (!ping) {
            return {
              type: 'error',
              code: 'BAD_PING',
              message: 'Ping needs lon/lat',
            };
          }
          broadcast(room, {
            type: 'ping',
            id: nextMessageId('p'),
            from: publicMember(member),
            ...ping,
            t: now(),
            ttlMs: ROOM_LIMITS.pingTtlMs,
          });
          return null;
        }

        case 'event': {
          const state = sanitizeViewState(message.state);
          if (!state) {
            return {
              type: 'error',
              code: 'BAD_STATE',
              message: 'A moment needs a camera',
            };
          }
          const moment = {
            id: nextMessageId('e'),
            from: publicMember(member),
            note: sanitizeText(message.note, ROOM_LIMITS.noteMax),
            state,
            t: now(),
          };
          room.moments.push(moment);
          if (room.moments.length > ROOM_LIMITS.momentsKeep) {
            room.moments.splice(
              0,
              room.moments.length - ROOM_LIMITS.momentsKeep,
            );
          }
          broadcast(room, { type: 'event', moment });
          return null;
        }

        default:
          return {
            type: 'error',
            code: 'UNKNOWN_TYPE',
            message: `Unknown message type: ${String(message.type).slice(0, 32)}`,
          };
      }
    },

    /** Test/inspection helpers. */
    roomCount() {
      return rooms.size;
    },
    leaderOf(roomId) {
      return rooms.get(roomId)?.leaderId ?? null;
    },
    memberIds(roomId) {
      return [...(rooms.get(roomId)?.members.keys() ?? [])];
    },
    /** Drop every room immediately (dispose). */
    clear() {
      for (const room of rooms.values()) {
        if (room.expiryTimer) clearTimer(room.expiryTimer);
      }
      rooms.clear();
    },
  };
}
