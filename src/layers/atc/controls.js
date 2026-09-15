import { listAtcAirports } from './directory.js';

export function createControls({ state: layerState, parts }) {
  const methods = {
    id: 'atc',

    name: 'ATC Radio',

    icon: '🗼',

    source: 'LiveATC',

    /** Apply the manager-owned lifecycle gate to visible and pickable ATC state. */
    setLifecyclePresentation({
      lifecycleState = null,
      enabled = false,
      uncertain = false,
    } = {}) {
      const settledState = enabled ? 'enabled' : 'disabled';
      const normalizedState = [
        'enabling',
        'enabled',
        'disabling',
        'disabled',
      ].includes(lifecycleState)
        ? lifecycleState
        : settledState;
      layerState._managerLifecyclePresentation = {
        lifecycleState: normalizedState,
        enabled: Boolean(enabled),
        uncertain: Boolean(uncertain),
      };
      parts.interaction.syncAtcLifecyclePresentation();
      parts.presentation.emitState();
    },

    /** Panel row count: airports in the committed directory. */
    getStats() {
      const airports = listAtcAirports();
      const feeds = airports.reduce(
        (sum, airport) => sum + (airport.feeds?.length || 0),
        0,
      );
      return {
        count: airports.length,
        countLabel: `${airports.length} airports · ${feeds} feeds`,
      };
    },

    subscribe(listener) {
      return parts.presentation.subscribeToAtc(listener);
    },

    getUIState() {
      return parts.presentation.getAtcUIState();
    },

    selectAirport(icao, options) {
      return parts.selection.selectAtcAirport(icao, options);
    },

    clearSelection() {
      return parts.selection.clearAtcSelection();
    },

    playFeed(mount, options) {
      return parts.playback.playAtcFeed(mount, options);
    },

    toggleFeed(mount, options) {
      return parts.playback.toggleAtcFeed(mount, options);
    },

    stopPlayback(options) {
      return parts.playback.stopAtcPlayback(options);
    },

    playAirport(query, options) {
      return parts.selection.playAtcAirport(query, options);
    },

    playNearest(position, options) {
      return parts.selection.playNearestAtc(position, options);
    },

    previewNearest(position) {
      return parts.selection.previewNearestAtc(position);
    },
  };

  return { methods };
}
