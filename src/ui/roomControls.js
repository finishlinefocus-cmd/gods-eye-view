import { roomCodeFromUrl } from '../rooms/session.js';

/**
 * ROOM chip + panel: create/join, presence, follow/lead, chat, pings and
 * moments. Pure DOM over a RoomSession; every render is a full, cheap sync of
 * the session snapshot, so there is no incremental state to drift.
 */

const IDS = Object.freeze({
  chip: 'room-chip',
  chipCount: 'room-chip-count',
  panel: 'room-panel',
  status: 'room-status',
  notice: 'room-notice',
  close: 'room-close-btn',
  entry: 'room-entry',
  nameInput: 'room-name-input',
  createBtn: 'room-create-btn',
  joinForm: 'room-join-form',
  codeInput: 'room-code-input',
  joinBtn: 'room-join-btn',
  live: 'room-live',
  code: 'room-code',
  copyLink: 'room-copy-link-btn',
  leave: 'room-leave-btn',
  members: 'room-members',
  followToggle: 'room-follow-toggle',
  rejoin: 'room-rejoin-btn',
  lead: 'room-lead-btn',
  handoffRow: 'room-handoff-row',
  handoffSelect: 'room-handoff-select',
  handoffBtn: 'room-handoff-btn',
  ping: 'room-ping-btn',
  moment: 'room-moment-btn',
  momentForm: 'room-moment-form',
  momentNote: 'room-moment-note',
  momentCancel: 'room-moment-cancel',
  moments: 'room-moments',
  chatLog: 'room-chat-log',
  chatForm: 'room-chat-form',
  chatInput: 'room-chat-input',
});

function formatTime(t) {
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function statusLabel(state) {
  switch (state.phase) {
    case 'joined':
      return state.connection === 'open'
        ? `${state.members.length} in room`
        : 'Connection lost';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return state.error || 'Connection failed';
    default:
      return 'Not in a room';
  }
}

export class RoomControls {
  constructor({
    session,
    document: doc = globalThis.document,
    location = globalThis.location,
    navigator: nav = globalThis.navigator,
    toast = null,
  }) {
    this._session = session;
    this._document = doc;
    this._location = location;
    this._navigator = nav;
    this._toast = toast;
    this._els = {};
    for (const [key, id] of Object.entries(IDS)) {
      this._els[key] = doc.getElementById(id);
    }
    this._disposers = [];
    this._lastChatCount = -1;
    this._noticeTimer = null;
    this._shownNotice = null;
    this._destroyed = false;
    if (!this._els.chip || !this._els.panel) return;
    this._bind();
    this._disposers.push(session.subscribe((state) => this._render(state)));
    this._autoJoinFromUrl();
  }

  _listen(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._disposers.push(() =>
      element.removeEventListener(event, handler, options),
    );
  }

  _bind() {
    const els = this._els;
    const session = this._session;
    els.nameInput.value = session.rememberedName;

    this._listen(els.chip, 'click', () => this.toggle());
    this._listen(els.close, 'click', () => this.close());
    this._listen(this._document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) {
        if (this._document.activeElement?.closest?.('#room-panel')) {
          this.close();
          els.chip.focus();
        }
      }
    });

    this._listen(els.createBtn, 'click', async () => {
      await this._run(() => session.create(els.nameInput.value), 'CREATE ROOM');
    });
    this._listen(els.joinForm, 'submit', async (event) => {
      event.preventDefault();
      const code = els.codeInput.value;
      await this._run(() => session.join(code, els.nameInput.value), 'JOIN');
    });
    this._listen(els.copyLink, 'click', async () => {
      const link = session.joinLink;
      if (!link) return;
      const ok = await this._copy(link);
      this._flash(ok ? 'Link copied!' : link);
    });
    this._listen(els.code, 'click', async () => {
      const ok = await this._copy(session.state.roomId || '');
      if (ok) this._flash('Code copied!');
    });
    this._listen(els.leave, 'click', () => {
      session.leave();
      this._flash('Left the room');
    });
    this._listen(els.followToggle, 'change', () => {
      session.setFollowing(els.followToggle.checked);
    });
    this._listen(els.rejoin, 'click', () => session.rejoinLeader());
    this._listen(els.lead, 'click', () => {
      if (session.isLeader) {
        els.handoffRow.hidden = !els.handoffRow.hidden;
      } else {
        session.takeLead();
      }
    });
    this._listen(els.handoffBtn, 'click', () => {
      const to = els.handoffSelect.value;
      if (to && session.handOff(to)) els.handoffRow.hidden = true;
    });
    this._listen(els.ping, 'click', () => {
      if (session.pingHere()) this._flash('Pinged');
    });
    this._listen(els.moment, 'click', () => {
      els.momentForm.hidden = !els.momentForm.hidden;
      if (!els.momentForm.hidden) els.momentNote.focus();
    });
    this._listen(els.momentCancel, 'click', () => {
      els.momentForm.hidden = true;
      els.momentNote.value = '';
    });
    this._listen(els.momentForm, 'submit', (event) => {
      event.preventDefault();
      if (session.shareMoment(els.momentNote.value)) {
        els.momentNote.value = '';
        els.momentForm.hidden = true;
        this._flash('Moment shared');
      }
    });
    this._listen(els.chatForm, 'submit', (event) => {
      event.preventDefault();
      if (session.sendChat(els.chatInput.value)) els.chatInput.value = '';
    });
    this._listen(els.moments, 'click', (event) => {
      const button = event.target.closest?.('[data-moment-id]');
      if (button) session.jumpToMoment(button.dataset.momentId);
    });
    // Keep typing in the panel from reaching the globe's keyboard shortcuts.
    this._listen(els.panel, 'keydown', (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
    this._listen(els.panel, 'keyup', (event) => event.stopPropagation());
    this._listen(els.panel, 'keypress', (event) => event.stopPropagation());
  }

  async _run(action, label) {
    const els = this._els;
    els.createBtn.disabled = els.joinBtn.disabled = true;
    try {
      await action();
      els.codeInput.value = '';
    } catch (error) {
      this._notice(error?.message || `${label} failed`);
    } finally {
      els.createBtn.disabled = els.joinBtn.disabled = false;
    }
  }

  async _copy(text) {
    try {
      if (!this._navigator?.clipboard?.writeText) return false;
      await this._navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  _flash(message) {
    if (this._toast) this._toast(message);
    else this._notice(message);
  }

  _notice(message) {
    const el = this._els.notice;
    if (!el) return;
    clearTimeout(this._noticeTimer);
    el.textContent = message;
    el.hidden = !message;
    if (message) {
      this._noticeTimer = setTimeout(() => {
        el.hidden = true;
        this._shownNotice = null;
        this._session.clearNotice();
      }, 6000);
    }
  }

  _autoJoinFromUrl() {
    const code = roomCodeFromUrl(this._location?.href || '');
    if (!code) return;
    this._els.codeInput.value = code;
    this.open();
    if (this._session.rememberedName) {
      this._run(
        () => this._session.join(code, this._session.rememberedName),
        'JOIN',
      );
    } else {
      this._notice(`Enter a display name to join room ${code}`);
      this._els.nameInput.focus();
    }
  }

  get isOpen() {
    return Boolean(this._els.panel) && !this._els.panel.hidden;
  }

  open() {
    if (!this._els.panel) return;
    this._els.panel.hidden = false;
    this._els.chip.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (!this._els.panel) return;
    this._els.panel.hidden = true;
    this._els.chip.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  _render(state) {
    if (this._destroyed) return;
    const els = this._els;
    const session = this._session;
    const inRoom = Boolean(state.roomId) && state.phase !== 'failed';
    const isLeader = session.isLeader;

    els.chip.dataset.roomState = state.phase;
    els.chipCount.hidden = !(inRoom && state.phase === 'joined');
    els.chipCount.textContent = String(state.members.length);
    els.status.dataset.state = state.phase;
    els.status.textContent = statusLabel(state);
    if (state.notice && state.notice !== this._shownNotice) {
      this._shownNotice = state.notice;
      this._notice(state.notice);
    }

    els.entry.hidden = inRoom;
    els.live.hidden = !inRoom;
    if (!inRoom) {
      this._lastChatCount = -1;
      return;
    }

    els.code.textContent = state.roomId;
    this._renderMembers(state, isLeader);

    els.followToggle.checked = state.following;
    els.followToggle.disabled = isLeader;
    els.followToggle.closest('label')?.classList.toggle('is-leader', isLeader);
    els.rejoin.hidden = isLeader || !state.following || !state.overridden;
    els.lead.textContent = isLeader ? 'HAND OFF…' : 'TAKE LEAD';
    els.lead.setAttribute('aria-pressed', isLeader ? 'true' : 'false');
    els.lead.disabled = state.connection !== 'open';
    if (!isLeader) els.handoffRow.hidden = true;
    const others = state.members.filter((m) => m.id !== state.memberId);
    els.handoffBtn.disabled = others.length === 0;
    els.handoffSelect.replaceChildren(
      ...others.map((member) => {
        const option = this._document.createElement('option');
        option.value = member.id;
        option.textContent = member.name;
        return option;
      }),
    );
    const offline = state.connection !== 'open';
    els.ping.disabled = offline;
    els.moment.disabled = offline;
    els.copyLink.disabled = false;

    this._renderMoments(state);
    this._renderChat(state);
  }

  _renderMembers(state, isLeader) {
    const doc = this._document;
    const items = state.members.map((member) => {
      const li = doc.createElement('li');
      li.className = 'room-member';
      if (member.id === state.memberId) li.classList.add('is-me');
      li.style.color = member.color;
      const swatch = doc.createElement('span');
      swatch.className = 'room-member-swatch';
      swatch.style.background = member.color;
      li.append(swatch);
      if (member.id === state.leaderId) {
        const crown = doc.createElement('span');
        crown.className = 'room-member-crown';
        crown.textContent = '👑';
        crown.title = 'Leader';
        crown.setAttribute('aria-label', 'leader');
        li.append(crown);
      }
      const name = doc.createElement('span');
      name.className = 'room-member-name';
      name.style.color = 'var(--text-primary)';
      name.textContent =
        member.id === state.memberId ? `${member.name} (you)` : member.name;
      li.append(name);
      li.title =
        isLeader && member.id !== state.memberId
          ? 'Hand off via HAND OFF…'
          : member.name;
      return li;
    });
    this._els.members.replaceChildren(...items);
  }

  _renderMoments(state) {
    const doc = this._document;
    if (!state.moments.length) {
      const empty = doc.createElement('li');
      empty.className = 'room-empty';
      empty.textContent =
        'No moments yet — SHARE MOMENT posts this view for everyone.';
      this._els.moments.replaceChildren(empty);
      return;
    }
    const items = [...state.moments].reverse().map((moment) => {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'room-moment-btn';
      button.dataset.momentId = moment.id;
      button.title = 'Jump to this moment';
      const swatch = doc.createElement('span');
      swatch.className = 'room-member-swatch';
      swatch.style.background = moment.from?.color || '#fff';
      swatch.style.color = moment.from?.color || '#fff';
      const note = doc.createElement('span');
      note.className = 'room-moment-note';
      const bits = [];
      if (moment.state?.tracked?.label) bits.push(moment.state.tracked.label);
      if (moment.state?.scene?.id) bits.push(`scene ${moment.state.scene.id}`);
      note.textContent =
        moment.note ||
        bits.join(' · ') ||
        `${moment.from?.name || 'Someone'}'s view`;
      const meta = doc.createElement('span');
      meta.className = 'room-moment-meta';
      meta.textContent =
        `${moment.from?.name || ''} ${formatTime(moment.t)}`.trim();
      button.append(swatch, note, meta);
      li.append(button);
      return li;
    });
    this._els.moments.replaceChildren(...items);
  }

  _renderChat(state) {
    if (state.chat.length === this._lastChatCount) return;
    this._lastChatCount = state.chat.length;
    const doc = this._document;
    const log = this._els.chatLog;
    const pinned =
      log.scrollHeight - log.scrollTop - log.clientHeight < 24 ||
      log.childElementCount === 0;
    const items = state.chat.map((entry) => {
      const li = doc.createElement('li');
      li.className = 'room-chat-line';
      const name = doc.createElement('span');
      name.className = 'room-chat-name';
      name.style.color = entry.from?.color || 'inherit';
      name.textContent = entry.from?.name || '?';
      const text = doc.createElement('span');
      text.className = 'room-chat-text';
      text.textContent = entry.text;
      const time = doc.createElement('span');
      time.className = 'room-chat-time';
      time.textContent = formatTime(entry.t);
      li.append(name, text, time);
      return li;
    });
    log.replaceChildren(...items);
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._noticeTimer);
    for (const dispose of this._disposers.splice(0)) dispose();
  }
}
