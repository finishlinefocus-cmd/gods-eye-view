/**
 * PROFILE chip + panel: sign in (name + PIN), signed-in view (name, device
 * count, sync state, Sync now, Sign out, Sign out everywhere), home view and
 * saved places (save this view, fly to, share with room, delete). Pure DOM
 * over a ProfileSession; every render is a full, cheap sync of the session
 * snapshot. User strings only ever reach the page through textContent.
 */

const IDS = Object.freeze({
  chip: 'profile-chip',
  chipBadge: 'profile-chip-badge',
  panel: 'profile-panel',
  status: 'profile-status',
  notice: 'profile-notice',
  close: 'profile-close-btn',
  loginForm: 'profile-login-form',
  nameInput: 'profile-name-input',
  pinInput: 'profile-pin-input',
  rememberInput: 'profile-remember-input',
  loginBtn: 'profile-login-btn',
  signedIn: 'profile-signed-in',
  name: 'profile-name',
  devices: 'profile-devices',
  syncState: 'profile-sync-state',
  syncBtn: 'profile-sync-btn',
  homeBtn: 'profile-home-btn',
  setHomeBtn: 'profile-set-home-btn',
  placeForm: 'profile-place-form',
  placeInput: 'profile-place-input',
  placeBtn: 'profile-place-btn',
  places: 'profile-places',
  logoutBtn: 'profile-logout-btn',
  logoutAllBtn: 'profile-logout-all-btn',
});

export function statusLabel(state) {
  switch (state.phase) {
    case 'signing-in':
      return 'Signing in…';
    case 'signed-in':
      if (!state.online) return `${state.name} · offline`;
      if (state.syncing) return `${state.name} · syncing`;
      if (state.dirty?.length) return `${state.name} · unsaved`;
      return state.name;
    default:
      return 'Not signed in';
  }
}

export function syncLabel(state, now = Date.now()) {
  if (!state.online) return 'profile offline — using local copy';
  if (state.syncing) return 'syncing…';
  if (state.dirty?.length) return 'changes pending';
  if (!state.lastSyncAt) return '';
  const ago = Math.max(0, Math.round((now - state.lastSyncAt) / 1000));
  if (ago < 5) return 'synced just now';
  if (ago < 60) return `synced ${ago}s ago`;
  const minutes = Math.round(ago / 60);
  return `synced ${minutes} min ago`;
}

function formatPlaceMeta(place) {
  const bits = [];
  if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    bits.push(`${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`);
  }
  if (Number.isFinite(place.height)) {
    bits.push(
      place.height >= 10_000
        ? `${Math.round(place.height / 1000)} km`
        : `${Math.round(place.height)} m`,
    );
  }
  return bits.join(' · ');
}

export class ProfileControls {
  constructor({
    session,
    rooms = null,
    document: doc = globalThis.document,
    toast = null,
    confirm = (message) => globalThis.confirm?.(message) ?? true,
  }) {
    this._session = session;
    this._rooms = rooms;
    this._document = doc;
    this._toast = toast;
    this._confirm = confirm;
    this._els = {};
    for (const [key, id] of Object.entries(IDS)) {
      this._els[key] = doc.getElementById(id);
    }
    this._disposers = [];
    this._noticeTimer = null;
    this._shownNotice = null;
    this._destroyed = false;
    this._lastPlacesKey = null;
    if (!this._els.chip || !this._els.panel) return;
    this._bind();
    this._disposers.push(session.subscribe((state) => this._render(state)));
    if (rooms?.subscribe) {
      this._disposers.push(
        rooms.subscribe(() => this._renderPlaces(session.state, true)),
      );
    }
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

    this._listen(els.chip, 'click', () => this.toggle());
    this._listen(els.close, 'click', () => this.close());
    this._listen(this._document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) {
        if (this._document.activeElement?.closest?.('#profile-panel')) {
          this.close();
          els.chip.focus();
        }
      }
    });

    this._listen(els.loginForm, 'submit', async (event) => {
      event.preventDefault();
      els.loginBtn.disabled = true;
      try {
        await session.login(els.nameInput.value, els.pinInput.value, {
          remember: Boolean(els.rememberInput?.checked),
        });
        els.pinInput.value = '';
      } catch (error) {
        this._notice(error?.message || 'Sign-in failed');
      } finally {
        els.loginBtn.disabled = false;
        els.pinInput.value = '';
      }
    });

    this._listen(els.syncBtn, 'click', async () => {
      els.syncBtn.disabled = true;
      try {
        await session.syncNow();
        if (session.state.online) this._flash('Profile synced');
      } finally {
        els.syncBtn.disabled = false;
      }
    });
    this._listen(els.homeBtn, 'click', () => {
      if (!session.goHome()) this._notice('No home view yet — SET HOME first');
    });
    this._listen(els.setHomeBtn, 'click', () => {
      if (session.setHome()) this._flash('Home view set');
    });
    this._listen(els.placeForm, 'submit', (event) => {
      event.preventDefault();
      const place = session.savePlace(els.placeInput.value);
      if (place) {
        els.placeInput.value = '';
        this._flash(`Saved "${place.name}"`);
      } else {
        this._notice('Give the place a name');
      }
    });
    this._listen(els.places, 'click', (event) => {
      const button = event.target.closest?.('[data-place-id]');
      if (!button) return;
      const id = button.dataset.placeId;
      const action = button.dataset.placeAction || 'fly';
      if (action === 'delete') {
        const place = session.findPlace(id);
        if (place && this._confirm(`Delete "${place.name}"?`))
          session.deletePlace(id);
        return;
      }
      if (action === 'share') {
        if (session.sharePlace(id)) this._flash('Shared with the room');
        else this._notice('Join a room first');
        return;
      }
      const flown = session.flyToPlace(id);
      if (!flown) this._notice('Exit Cockpit to fly to a saved place');
    });
    this._listen(els.logoutBtn, 'click', () => {
      void session.logout();
    });
    this._listen(els.logoutAllBtn, 'click', () => {
      if (this._confirm('Sign this profile out on every device?')) {
        void session.logout({ everywhere: true });
      }
    });
    // Keep typing in the panel from reaching the globe's keyboard shortcuts.
    this._listen(els.panel, 'keydown', (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
    this._listen(els.panel, 'keyup', (event) => event.stopPropagation());
    this._listen(els.panel, 'keypress', (event) => event.stopPropagation());
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

  get isOpen() {
    return Boolean(this._els.panel) && !this._els.panel.hidden;
  }

  open() {
    if (!this._els.panel) return;
    this._els.panel.hidden = false;
    this._els.chip.setAttribute('aria-expanded', 'true');
    if (this._session.state.phase === 'signed-out')
      this._els.nameInput?.focus?.();
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
    const signedIn = state.phase === 'signed-in';

    els.chip.dataset.profileState = state.phase;
    els.chip.dataset.online = state.online ? 'true' : 'false';
    els.chipBadge.hidden = !(signedIn && !state.online);
    els.chip.title = signedIn
      ? `Profile: ${state.name}${state.online ? '' : ' (offline)'}`
      : 'Profile: sign in to sync your preferences and saved places';
    els.status.dataset.state = state.online ? state.phase : 'offline';
    els.status.textContent = statusLabel(state);
    if (state.notice && state.notice !== this._shownNotice) {
      this._shownNotice = state.notice;
      this._notice(state.notice);
    }

    els.loginForm.hidden = signedIn || state.phase === 'signing-in';
    els.signedIn.hidden = !signedIn;
    els.loginBtn.disabled = state.phase === 'signing-in';
    if (!signedIn) {
      this._lastPlacesKey = null;
      return;
    }
    els.name.textContent = state.name;
    els.devices.textContent =
      state.devices > 0
        ? `${state.devices} device${state.devices === 1 ? '' : 's'}`
        : '';
    els.syncState.textContent = syncLabel(state);
    els.syncState.dataset.online = state.online ? 'true' : 'false';
    els.homeBtn.hidden = !state.homeAvailable;
    this._renderPlaces(state);
  }

  _renderPlaces(state, force = false) {
    if (this._destroyed || state.phase !== 'signed-in') return;
    const doc = this._document;
    const places = state.profile?.savedPlaces || [];
    const inRoom = Boolean(this._rooms?.inRoom);
    const key = `${inRoom}:${places.map((p) => `${p.id}:${p.name}`).join('|')}`;
    if (!force && key === this._lastPlacesKey) return;
    this._lastPlacesKey = key;
    if (!places.length) {
      const empty = doc.createElement('li');
      empty.className = 'room-empty';
      empty.textContent =
        'No saved places yet — name the current view above and SAVE. Say "take me to <name>" to fly back.';
      this._els.places.replaceChildren(empty);
      return;
    }
    const items = places.map((place) => {
      const li = doc.createElement('li');
      li.className = 'profile-place';
      const fly = doc.createElement('button');
      fly.type = 'button';
      fly.className = 'room-moment-btn profile-place-fly';
      fly.dataset.placeId = place.id;
      fly.dataset.placeAction = 'fly';
      fly.title = 'Fly to this place';
      const star = doc.createElement('span');
      star.className = 'profile-place-star';
      star.textContent = '★';
      star.setAttribute('aria-hidden', 'true');
      const name = doc.createElement('span');
      name.className = 'room-moment-note';
      name.textContent = place.name;
      const meta = doc.createElement('span');
      meta.className = 'room-moment-meta';
      meta.textContent = formatPlaceMeta(place);
      fly.append(star, name, meta);
      li.append(fly);
      if (inRoom) {
        const share = doc.createElement('button');
        share.type = 'button';
        share.className = 'room-btn room-btn-quiet profile-place-share';
        share.dataset.placeId = place.id;
        share.dataset.placeAction = 'share';
        share.title = 'Share this place with the room as a moment';
        share.textContent = 'SHARE';
        li.append(share);
      }
      const del = doc.createElement('button');
      del.type = 'button';
      del.className = 'room-icon-btn profile-place-delete';
      del.dataset.placeId = place.id;
      del.dataset.placeAction = 'delete';
      del.title = `Delete ${place.name}`;
      del.setAttribute('aria-label', `Delete ${place.name}`);
      del.textContent = '×';
      li.append(del);
      return li;
    });
    this._els.places.replaceChildren(...items);
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._noticeTimer);
    for (const dispose of this._disposers.splice(0)) dispose();
  }
}
