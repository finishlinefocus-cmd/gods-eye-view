/**
 * Own the ATC Radio companion DOM inside Context: enable toggle, the airport
 * card and feed list with per-feed play/stop, the NEAREST ATC control for a
 * tracked aircraft, and mutual exclusion with the broadcast Radio player.
 */
export class AtcControls {
  constructor({ elements, atc, actions }) {
    Object.assign(this, elements);
    this.atc = atc;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._atcUnsubscribe = null;
    this._radioUnsubscribe = null;
    this._atcState = null;
    this._trackedSyncTimer = null;
    this._bind();
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  _bind() {
    this.listen(this._atcEnableBtn, 'click', () => this._toggleLayer());
    this.listen(this._atcStopBtn, 'click', () => {
      this.atc.stopPlayback?.({ origin: 'user' });
    });
    this.listen(this._atcNearestBtn, 'click', () => this._tuneNearest());
    this.listen(this._atcFeedList, 'click', (event) => {
      const button = event.target?.closest?.('button[data-atc-mount]');
      if (!button || !this._atcFeedList?.contains(button)) return;
      this._toggleFeed(button.dataset.atcMount);
    });
    if (typeof document !== 'undefined') {
      this.listen(document, 'gev:atc-selected', () => this._revealPanel());
      // Broadcast Radio yields to ATC and ATC yields to Radio: one voice at a time.
      this.listen(document, 'gev:atc-playback-starting', () => {
        this.actions.stopRadioPlayback?.();
        this._revealPanel();
      });
    }
    if (typeof window !== 'undefined') {
      this.listen(window, 'gev:awareness-subject-selected', () =>
        this._scheduleTrackedSync(),
      );
      this.listen(window, 'gev:awareness-subject-cleared', () =>
        this._scheduleTrackedSync(),
      );
    }
  }

  /** Open the ATC section and the Context panel that hosts it. */
  _revealPanel() {
    if (this.destroyed) return;
    const host = this._atcPanel?.closest?.('#global-context-panel');
    if (host?.classList.contains('collapsed')) {
      this.actions.setPanelCollapsed('global-context-panel', false);
    }
    this.actions.setPanelCollapsed('atc-panel', false);
  }

  connect() {
    this._atcUnsubscribe?.();
    this._atcUnsubscribe = null;
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    if (this.destroyed) return;
    this._atcUnsubscribe = this.atc.subscribe?.((state) =>
      this._renderAtcState(state),
    );
    this._radioUnsubscribe = this.actions.subscribeRadio?.((radioState) => {
      if (!['loading', 'buffering', 'playing'].includes(radioState?.audioState))
        return;
      const playing = this._atcState?.audioState;
      if (['loading', 'buffering', 'playing'].includes(playing))
        this.atc.stopPlayback?.({ origin: 'radio-playback' });
    });
    this._syncTrackedAvailability();
  }

  destroy() {
    this.destroyed = true;
    this.listeners.abort();
    this._atcUnsubscribe?.();
    this._atcUnsubscribe = null;
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    if (this._trackedSyncTimer) clearTimeout(this._trackedSyncTimer);
    this._trackedSyncTimer = null;
  }

  async _toggleLayer() {
    const trigger = this._atcEnableBtn;
    if (!trigger || this.destroyed) return;
    if (!this.actions.isRegistered()) return;
    if (trigger.getAttribute('aria-busy') === 'true') return;
    const enabling = !this.actions.isEnabled();
    trigger.setAttribute('aria-disabled', 'true');
    trigger.setAttribute('aria-busy', 'true');
    try {
      const toggled = await this.actions.runUserAction(
        (notificationToken) =>
          this.actions.setEnabled(enabling, {
            origin: 'user',
            notificationToken,
          }),
        `ATC Radio could not ${enabling ? 'start' : 'stop'} cleanly`,
      );
      if (this.destroyed || toggled === false) return;
      if (enabling) {
        this.actions.setPanelCollapsed('atc-panel', false, { explicit: true });
      }
    } finally {
      if (!this.destroyed) {
        trigger.removeAttribute('aria-disabled');
        trigger.removeAttribute('aria-busy');
      }
    }
  }

  /** Ensure the layer is on before a play request, then run it. */
  async _withLayerEnabled(run) {
    if (!this.actions.isRegistered()) return { ok: false };
    if (!this.actions.isEnabled()) {
      const toggled = await this.actions.runUserAction(
        (notificationToken) =>
          this.actions.setEnabled(true, { origin: 'user', notificationToken }),
        'ATC Radio could not start cleanly',
      );
      if (this.destroyed || toggled === false) return { ok: false };
      this.actions.setPanelCollapsed('atc-panel', false, { explicit: true });
    }
    return run();
  }

  _toggleFeed(mount) {
    if (!mount) return;
    void this._withLayerEnabled(() =>
      this.atc.toggleFeed(mount, { origin: 'user' }),
    );
  }

  _tuneNearest() {
    const position = this.actions.trackedPosition?.();
    if (!position) return;
    void this._withLayerEnabled(() =>
      this.atc.playNearest(position, { origin: 'user' }),
    );
  }

  _scheduleTrackedSync() {
    if (this._trackedSyncTimer) return;
    this._trackedSyncTimer = setTimeout(() => {
      this._trackedSyncTimer = null;
      this._syncTrackedAvailability();
    }, 50);
  }

  /** NEAREST ATC lights up only while an aircraft is tracked. */
  _syncTrackedAvailability() {
    if (this.destroyed || !this._atcNearestBtn) return;
    const position = this.actions.trackedPosition?.();
    const preview = position ? this.atc.previewNearest?.(position) : null;
    this._atcNearestBtn.disabled = !preview;
    this._atcNearestBtn.title = preview
      ? `Tune ${preview.airport.icao} ${preview.kind} (${Math.round(preview.distanceNm)} nm from the tracked aircraft)`
      : 'Track an aircraft to tune the nearest ATC feed';
  }

  _renderAtcState(state) {
    if (this.destroyed || !state) return;
    this._atcState = state;
    const lifecycle = state.lifecycle;
    const lifecycleState = lifecycle?.lifecycleState || null;
    const transitioning =
      lifecycleState === 'enabling' || lifecycleState === 'disabling';
    const enabled = state.enabled && lifecycleState !== 'disabling';
    const active = ['loading', 'buffering', 'playing'].includes(
      state.audioState,
    );

    if (this._atcLayerState) {
      this._atcLayerState.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : enabled
          ? active
            ? 'LIVE'
            : 'ON'
          : 'OFF';
      this._atcLayerState.classList.toggle('active', enabled);
    }
    if (this._atcEnableBtn) {
      this._atcEnableBtn.textContent = enabled ? 'DISABLE' : 'ENABLE';
      this._atcEnableBtn.setAttribute(
        'aria-pressed',
        enabled ? 'true' : 'false',
      );
      this._atcEnableBtn.classList.toggle('active', enabled);
    }
    if (this._atcStopBtn) this._atcStopBtn.disabled = !active;

    const airport = state.airport;
    if (this._atcAirportName) {
      this._atcAirportName.textContent = airport
        ? `${airport.icao} · ${airport.name}`
        : 'NO AIRPORT SELECTED';
    }
    if (this._atcAirportMeta) {
      if (airport) {
        const online = airport.feeds.filter((feed) => feed.online).length;
        this._atcAirportMeta.textContent = `${airport.feeds.length} LiveATC feeds · ${online} online at last check`;
      } else {
        this._atcAirportMeta.textContent = enabled
          ? 'Choose an airport marker on the globe, or use NEAREST ATC while tracking an aircraft.'
          : 'Enable ATC Radio, then choose an airport marker or use NEAREST ATC while tracking an aircraft.';
      }
    }
    this._renderFeedList(airport, state);

    if (this._atcPlaybackState) {
      const messages = {
        stopped: enabled ? 'Ready' : 'ATC Radio off',
        loading: 'Connecting to LiveATC…',
        buffering: 'Buffering…',
        playing: state.playing
          ? `Listening: ${state.playing.icao} ${state.playing.label}`
          : 'Playing',
        paused: 'Paused',
        error: state.audioError || 'ATC stream failed',
      };
      const lifecycleMessage = transitioning
        ? `ATC Radio is ${lifecycleState}…`
        : null;
      this._atcPlaybackState.textContent =
        lifecycleMessage || messages[state.audioState] || 'Ready';
      this._atcPlaybackState.classList.toggle(
        'error',
        state.audioState === 'error',
      );
    }
    if (
      !enabled &&
      !transitioning &&
      !this.actions.preservePanelStateDuringClear?.() &&
      this._atcPanel &&
      !this._atcPanel.classList.contains('collapsed')
    ) {
      this.actions.setPanelCollapsed('atc-panel', true);
    }
    this._syncTrackedAvailability();
    this.actions.scheduleLayout?.();
  }

  _renderFeedList(airport, state) {
    const list = this._atcFeedList;
    if (!list) return;
    const doc = list.ownerDocument;
    list.replaceChildren();
    if (!airport) return;
    const active = ['loading', 'buffering', 'playing'].includes(
      state.audioState,
    );
    for (const feed of airport.feeds) {
      const playing = active && state.playingMount === feed.mount;
      const item = doc.createElement('li');
      item.className = `atc-feed${playing ? ' playing' : ''}`;
      const kind = doc.createElement('span');
      kind.className = 'atc-feed-kind';
      kind.textContent = feed.kind;
      const label = doc.createElement('span');
      label.className = 'atc-feed-label';
      const name = doc.createElement('strong');
      name.textContent = feed.label;
      name.title = feed.label;
      const meta = doc.createElement('span');
      meta.textContent = feed.mount;
      if (!feed.online) {
        const offline = doc.createElement('em');
        offline.className = 'atc-feed-offline';
        offline.textContent = 'offline at last check';
        meta.append(offline);
      }
      label.append(name, meta);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `atc-feed-play${playing ? ' active' : ''}`;
      button.dataset.atcMount = feed.mount;
      button.textContent = playing ? 'STOP' : 'PLAY';
      button.setAttribute(
        'aria-label',
        `${playing ? 'Stop' : 'Play'} ${feed.label}`,
      );
      item.append(kind, label, button);
      list.append(item);
    }
  }
}
