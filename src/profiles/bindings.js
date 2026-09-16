/**
 * The one profiles module that touches the running application. It turns the
 * shell's style manager, data manager, rooms session and voice controls into
 * the small `bindings` surface a ProfileSession drives (see session.js):
 * read/write style, enabled layers, voice mode and room name, read/fly the
 * camera, and report when the user changes any of them.
 */

const FLY_DURATION_S = 2.4;

export function createProfileBindings({
  styleManager,
  dataManager,
  rooms = null,
  getVoiceCommands = () => null,
  window: win = globalThis.window,
  document: doc = globalThis.document,
  toast = null,
}) {
  const localVoice = () => getVoiceCommands()?.localVoice || null;

  function getStyle() {
    return styleManager?.activeStyle || null;
  }

  function setStyle(style) {
    if (!style || styleManager?.activeStyle === style) return;
    try {
      styleManager.setStyle(style, {
        applyPreset: true,
        revealParameters: false,
        restore: true,
      });
    } catch (error) {
      console.warn('[profiles] setStyle failed', error);
    }
  }

  function getEnabledLayers() {
    return [...(dataManager?.getEnabledLayerIds?.() || [])];
  }

  function enableLayers(ids) {
    if (!dataManager) return;
    const known = dataManager.layers;
    for (const id of ids) {
      if (known?.has && !known.has(id)) continue;
      Promise.resolve(
        dataManager.setEnabled(id, true, { origin: 'profile' }),
      ).catch(() => {});
    }
  }

  function getVoiceMode() {
    const voice = localVoice();
    if (!voice) return null;
    return voice.isEnabled?.() ? 'local' : 'openai';
  }

  function setVoiceMode(mode) {
    const voice = localVoice();
    if (!voice?.setEnabled) return;
    const apply = () => {
      if (mode === 'local') voice.setEnabled(true);
      else if (mode === 'openai' || mode === 'off') voice.setEnabled(false);
    };
    // The local backend probes its service asynchronously; the toggle is a
    // no-op until that resolves, so apply once it has.
    Promise.resolve(voice.ready).then(apply, apply);
  }

  function getRoomName() {
    return rooms?.rememberedName || '';
  }

  function setRoomName(name) {
    if (!rooms || !name) return;
    rooms.rememberName(name);
    const input = doc?.getElementById?.('room-name-input');
    if (input && input.value !== name) input.value = name;
  }

  function getCamera() {
    const state = styleManager?.getCameraState?.();
    if (!state) return null;
    return {
      lat: state.lat,
      lon: state.lon,
      height: state.alt,
      heading: state.heading,
      pitch: state.pitch,
      roll: state.roll,
    };
  }

  /** Fly to a saved place / home camera; false when the shell refuses (e.g. Cockpit). */
  function flyTo(place) {
    if (!place || typeof styleManager?.applyCameraState !== 'function')
      return false;
    const camera = {
      lat: place.lat,
      lon: place.lon,
      alt: Number.isFinite(place.height) ? place.height : 1500,
      heading: place.heading || 0,
      pitch: Number.isFinite(place.pitch) ? place.pitch : -35,
      roll: place.roll || 0,
    };
    const navigate = () => {
      styleManager.applyCameraState(camera, FLY_DURATION_S);
      return true;
    };
    if (typeof styleManager.runImmediateNavigation === 'function') {
      try {
        return (
          styleManager.runImmediateNavigation('profile', navigate) !== false
        );
      } catch (error) {
        console.warn('[profiles] navigation refused', error);
        return false;
      }
    }
    return navigate();
  }

  /** Fly to the place, then post it to the room as a moment once we are there. */
  function shareMoment(place) {
    if (!rooms?.inRoom) return false;
    if (!flyTo(place)) return false;
    win?.setTimeout?.(
      () => {
        rooms.shareMoment(place.name || '');
      },
      FLY_DURATION_S * 1000 + 150,
    );
    return true;
  }

  /** Report user-driven changes to the tracked state. */
  function onChange(callback) {
    const disposers = [];
    const onStyle = (event) =>
      callback('style', event?.detail?.style || getStyle());
    win?.addEventListener?.('gev:style-change', onStyle);
    disposers.push(() =>
      win?.removeEventListener?.('gev:style-change', onStyle),
    );

    if (dataManager?.subscribe) {
      disposers.push(
        dataManager.subscribe((change) => {
          if (change?.type !== 'visibility') return;
          if (change.origin === 'profile') return;
          callback('layers', getEnabledLayers());
        }),
      );
    }

    if (rooms && typeof rooms.rememberName === 'function') {
      const original = rooms.rememberName.bind(rooms);
      rooms.rememberName = (name) => {
        original(name);
        callback('roomName', rooms.rememberedName);
      };
      disposers.push(() => {
        rooms.rememberName = original;
      });
    }

    const button = doc?.getElementById?.('gev-voice-local');
    if (button && typeof win?.MutationObserver === 'function') {
      const observer = new win.MutationObserver(() => {
        const mode = getVoiceMode();
        if (mode) callback('voice', mode);
      });
      observer.observe(button, {
        attributes: true,
        attributeFilter: ['aria-pressed'],
      });
      disposers.push(() => observer.disconnect());
    }

    return () => {
      for (const dispose of disposers.splice(0)) dispose();
    };
  }

  return {
    getStyle,
    setStyle,
    getEnabledLayers,
    enableLayers,
    getVoiceMode,
    setVoiceMode,
    getRoomName,
    setRoomName,
    getCamera,
    flyTo,
    shareMoment,
    onChange,
    toast: (message) => toast?.(message),
  };
}
