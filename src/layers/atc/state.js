export function createState() {
  const layerState = {};

  layerState._viewer = null;

  layerState._dataSource = null;

  layerState._enabled = false;

  layerState._managerLifecyclePresentation = null;

  layerState._renderByIcao = new Map();

  layerState._selectedIcao = null;

  layerState._selectedEntity = null;

  layerState._clickHandler = null;

  layerState._horizonTimer = null;

  layerState._lastHorizonCameraPosition = null;

  layerState._removeClusterListener = null;

  layerState._audio = null;

  layerState._audioMount = null;

  layerState._audioState = 'stopped';

  layerState._audioError = null;

  layerState._playAttempt = 0;

  layerState._listeners = new Set();

  return layerState;
}
