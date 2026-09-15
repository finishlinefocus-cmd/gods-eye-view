import { LIVEATC_GENERATED_AT } from './liveatcFeeds.js';
import { findAtcAirport, findAtcFeed } from './directory.js';

/** UI-facing state snapshot and subscription for the ATC panel and voice. */
export function createPresentation({ state: layerState }) {
  function getAtcUIState() {
    const airport = layerState._selectedIcao
      ? findAtcAirport(layerState._selectedIcao)
      : null;
    const playingEntry = layerState._audioMount
      ? findAtcFeed(layerState._audioMount)
      : null;
    return {
      enabled: layerState._enabled,
      lifecycle: layerState._managerLifecyclePresentation,
      selectedIcao: airport?.icao || null,
      airport: airport
        ? {
            icao: airport.icao,
            name: airport.name,
            lat: airport.lat,
            lon: airport.lon,
            feeds: airport.feeds,
          }
        : null,
      audioState: layerState._audioState,
      audioError: layerState._audioError,
      playingMount: layerState._audioMount,
      playing: playingEntry
        ? {
            mount: playingEntry.feed.mount,
            label: playingEntry.feed.label,
            kind: playingEntry.feed.kind,
            online: playingEntry.feed.online,
            icao: playingEntry.airport.icao,
          }
        : null,
      generatedAt: LIVEATC_GENERATED_AT,
    };
  }

  function emitState() {
    const snapshot = getAtcUIState();
    for (const listener of layerState._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken consumer must not break playback or rendering.
      }
    }
  }

  /** Subscribe to ATC state; the current state is delivered immediately. */
  function subscribeToAtc(listener) {
    if (typeof listener !== 'function') return () => {};
    layerState._listeners.add(listener);
    listener(getAtcUIState());
    return () => layerState._listeners.delete(listener);
  }

  return { getAtcUIState, emitState, subscribeToAtc };
}
