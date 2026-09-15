import * as Cesium from 'cesium';

export function createLifecycle({ state: layerState, parts }) {
  const methods = {
    /** Create the data source, draw the static directory, prepare the audio element. */
    init(viewer) {
      layerState._viewer = viewer;
      parts.playback.installAudio();
      if (!layerState._dataSource) {
        layerState._dataSource = new Cesium.CustomDataSource('ATC airports');
        viewer.dataSources.add(layerState._dataSource);
        parts.rendering.installClusterStyling();
      }
      layerState._dataSource.show = false;
      parts.rendering.reconcileAirports();
    },

    /** Show airports. Enabling never starts audio. */
    enable() {
      layerState._enabled = true;
      parts.interaction.syncAtcLifecyclePresentation();
      parts.presentation.emitState();
    },

    /** Hide the layer and stop audio; the selected airport is remembered. */
    disable() {
      layerState._enabled = false;
      parts.interaction.removeInteraction();
      parts.playback.stopAtcPlayback({ origin: 'layer-disable' });
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._selectedEntity && layerState._viewer)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
      parts.presentation.emitState();
    },

    /** The directory is static: nothing to poll. */
    async update() {},

    destroy() {
      this.disable();
      layerState._audio = null;
      layerState._removeClusterListener?.();
      layerState._removeClusterListener = null;
      if (layerState._dataSource && layerState._viewer)
        layerState._viewer.dataSources.remove(layerState._dataSource, true);
      layerState._dataSource = null;
      layerState._renderByIcao.clear();
      layerState._lastHorizonCameraPosition = null;
      layerState._selectedIcao = null;
      layerState._managerLifecyclePresentation = null;
      layerState._viewer = null;
      parts.presentation.emitState();
      layerState._listeners.clear();
    },
  };

  return { methods };
}
