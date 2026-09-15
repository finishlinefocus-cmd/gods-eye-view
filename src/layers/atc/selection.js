import {
  chooseAtcFeed,
  findAtcAirport,
  nearestAtcSelection,
  resolveAtcAirportQuery,
} from './directory.js';

/** Airport selection and the "which feed" decisions built on the directory helpers. */
export function createSelection({ state: layerState, parts }) {
  /** Select an airport for the panel; never starts audio by itself. */
  function selectAtcAirport(icao, { emit = true } = {}) {
    const airport = findAtcAirport(icao);
    if (!airport) return false;
    layerState._selectedIcao = airport.icao;
    parts.rendering.updateSelectionEntity();
    if (emit) parts.presentation.emitState();
    return true;
  }

  function clearAtcSelection() {
    layerState._selectedIcao = null;
    parts.rendering.updateSelectionEntity();
    parts.presentation.emitState();
  }

  /**
   * Tune an airport by code or name, choosing the feed for the requested kind
   * (tower by default). One call from voice or the HUD is enough to hear audio.
   */
  async function playAtcAirport(
    query,
    { kind = 'tower', origin = 'user' } = {},
  ) {
    const airport = findAtcAirport(query) || resolveAtcAirportQuery(query);
    if (!airport)
      return { ok: false, error: `No ATC airport matches "${query}"` };
    const feed = chooseAtcFeed(airport, kind);
    selectAtcAirport(airport.icao, { origin });
    if (!feed)
      return {
        ok: false,
        icao: airport.icao,
        airport: airport.name,
        error: `${airport.icao} has no LiveATC feeds in the directory`,
      };
    const result = await parts.playback.playAtcFeed(feed.mount, { origin });
    return {
      ...result,
      icao: airport.icao,
      airport: airport.name,
      requestedKind: kind,
      kind: feed.kind,
    };
  }

  /**
   * Nearest airport to a position, feed chosen from altitude and distance
   * (tower low and close, approach in terminal range, else center).
   */
  async function playNearestAtc(
    position,
    { kind = null, origin = 'user' } = {},
  ) {
    const selection = nearestAtcSelection(position);
    if (!selection) return { ok: false, error: 'No position to search from' };
    const feed = kind ? chooseAtcFeed(selection.airport, kind) : selection.feed;
    selectAtcAirport(selection.airport.icao, { origin });
    if (!feed)
      return {
        ok: false,
        icao: selection.airport.icao,
        airport: selection.airport.name,
        distanceNm: selection.distanceNm,
        error: `${selection.airport.icao} has no LiveATC feeds in the directory`,
      };
    const result = await parts.playback.playAtcFeed(feed.mount, { origin });
    return {
      ...result,
      icao: selection.airport.icao,
      airport: selection.airport.name,
      distanceNm: Math.round(selection.distanceNm * 10) / 10,
      kind: feed.kind,
    };
  }

  /** The nearest-airport answer without playing: what the HUD button previews. */
  function previewNearestAtc(position) {
    return nearestAtcSelection(position);
  }

  return {
    selectAtcAirport,
    clearAtcSelection,
    playAtcAirport,
    playNearestAtc,
    previewNearestAtc,
  };
}
