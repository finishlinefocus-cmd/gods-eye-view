import { findAtcFeed } from './directory.js';
import { atcStreamUrl } from './policy.js';

/**
 * One HTMLAudioElement per layer instance, pointed at the same-origin relay.
 * Only one ATC stream plays at a time: starting a mount replaces the element,
 * which drops the previous relay connection (and, through it, the upstream).
 * Before audio starts the layer announces itself on `document` so the
 * broadcast Radio companion can yield, and it yields in turn when Radio starts.
 */
export function createPlayback({ state: layerState, parts }) {
  function releaseAudio(audio) {
    if (!audio) return;
    try {
      audio.pause();
    } catch {
      /* already stopped */
    }
    try {
      audio.removeAttribute('src');
    } catch {
      /* no source */
    }
    try {
      audio.load();
    } catch {
      /* detached media */
    }
  }

  function installAudio({ replace = false } = {}) {
    if (layerState._audio && !replace) return;
    if (typeof Audio === 'undefined') return;
    const previous = layerState._audio;
    layerState._audio = null;
    releaseAudio(previous);
    const audio = new Audio();
    layerState._audio = audio;
    audio.preload = 'none';
    audio.crossOrigin = null;
    const current = () => layerState._audio === audio;
    audio.addEventListener('playing', () => {
      if (!current()) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      layerState._audioState = 'playing';
      layerState._audioError = null;
      parts.presentation.emitState();
    });
    audio.addEventListener('waiting', () => {
      if (!current()) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      layerState._audioState = 'buffering';
      parts.presentation.emitState();
    });
    audio.addEventListener('pause', () => {
      if (!current()) return;
      if (['stopped', 'loading', 'error'].includes(layerState._audioState))
        return;
      layerState._audioState = 'paused';
      parts.presentation.emitState();
    });
    audio.addEventListener('error', () => {
      if (!current()) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      layerState._audioState = 'error';
      layerState._audioError =
        'ATC stream is unavailable (feed offline or relay unreachable).';
      parts.presentation.emitState();
    });
  }

  function announce(name, detail) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /**
   * Start one mount. Resolves once the browser reports audio flowing, or with
   * ok:false when the mount is unknown or the element refuses to play.
   */
  async function playAtcFeed(mount, { origin = 'user' } = {}) {
    const entry = findAtcFeed(mount);
    if (!entry) {
      return { ok: false, error: `Unknown ATC feed: ${mount}` };
    }
    installAudio({ replace: true });
    const audio = layerState._audio;
    if (!audio) return { ok: false, error: 'Audio playback unavailable' };
    const attempt = (layerState._playAttempt += 1);
    layerState._audioMount = entry.feed.mount;
    layerState._audioState = 'loading';
    layerState._audioError = null;
    if (layerState._selectedIcao !== entry.airport.icao)
      parts.selection.selectAtcAirport(entry.airport.icao, {
        origin,
        emit: false,
      });
    parts.presentation.emitState();
    announce('gev:atc-playback-starting', {
      mount: entry.feed.mount,
      icao: entry.airport.icao,
      origin,
    });
    audio.src = atcStreamUrl(entry.feed.mount);
    try {
      await audio.play();
    } catch (error) {
      if (attempt !== layerState._playAttempt || layerState._audio !== audio)
        return { ok: false, error: 'Superseded by a newer ATC request' };
      layerState._audioState = 'error';
      layerState._audioError =
        error?.name === 'NotAllowedError'
          ? 'Browser blocked autoplay; press play once to allow ATC audio.'
          : 'ATC stream could not start.';
      parts.presentation.emitState();
      return { ok: false, error: layerState._audioError };
    }
    if (attempt !== layerState._playAttempt || layerState._audio !== audio)
      return { ok: false, error: 'Superseded by a newer ATC request' };
    return {
      ok: true,
      mount: entry.feed.mount,
      label: entry.feed.label,
      icao: entry.airport.icao,
      airport: entry.airport.name,
      online: entry.feed.online,
    };
  }

  /** Stop the stream and release its relay connection. */
  function stopAtcPlayback({ origin = 'programmatic' } = {}) {
    const wasActive = layerState._audioMount !== null;
    layerState._playAttempt += 1;
    releaseAudio(layerState._audio);
    layerState._audioMount = null;
    layerState._audioState = 'stopped';
    layerState._audioError = null;
    parts.presentation.emitState();
    if (wasActive) announce('gev:atc-playback-stopped', { origin });
    return wasActive;
  }

  /** Play the mount, or stop it when it is the one already playing. */
  function toggleAtcFeed(mount, options = {}) {
    if (
      layerState._audioMount === mount &&
      ['loading', 'buffering', 'playing'].includes(layerState._audioState)
    ) {
      stopAtcPlayback(options);
      return Promise.resolve({ ok: true, stopped: true, mount });
    }
    return playAtcFeed(mount, options);
  }

  return { installAudio, playAtcFeed, stopAtcPlayback, toggleAtcFeed };
}
