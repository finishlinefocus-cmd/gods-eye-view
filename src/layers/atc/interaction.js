import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  ATC_HORIZON_TICK_MS,
  ATC_LAYER_ID,
  ATC_PICK_OFFSETS,
  ATC_PREFIX,
  ATC_SELECTED_PREFIX,
} from './policy.js';

/** Globe clicks on airport markers, and the manager-gated show/hide of the whole presentation. */
export function createInteraction({ state: layerState, services, parts }) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  /** Resolve an ICAO from ordinary, selected, or Cesium cluster pick shapes. */
  function atcIcaoFromPick(picked) {
    const pending = [picked?.id, picked?.primitive?.id];
    const seen = new Set();
    while (pending.length) {
      const value = pending.shift();
      if (typeof value === 'string' || typeof value === 'number') {
        const id = String(value);
        if (id.startsWith(ATC_SELECTED_PREFIX))
          return id.slice(ATC_SELECTED_PREFIX.length);
        if (id.startsWith(ATC_PREFIX)) return id.slice(ATC_PREFIX.length);
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) pending.push(...value);
      else {
        pending.push(value.id);
        if (value.primitive) pending.push(value.primitive.id);
      }
    }
    return null;
  }

  function pickedAtcAirportAt(position) {
    const scene = layerState._viewer?.scene;
    if (!scene || !position) return null;
    const fromPick = (picked) => {
      const icao = atcIcaoFromPick(picked);
      return icao && layerState._renderByIcao.has(icao) ? icao : null;
    };
    const primary = fromPick(scene.pick(position));
    if (primary) return primary;
    const drilled = scene.drillPick?.(position, 16) || [];
    for (const picked of drilled) {
      const icao = fromPick(picked);
      if (icao) return icao;
    }
    for (const [dx, dy] of ATC_PICK_OFFSETS) {
      const icao = fromPick(
        scene.pick(new Cesium.Cartesian2(position.x + dx, position.y + dy)),
      );
      if (icao) return icao;
    }
    return null;
  }

  function atcPresentationAllowed() {
    if (!layerState._managerLifecyclePresentation) return layerState._enabled;
    return (
      layerState._enabled &&
      layerState._managerLifecyclePresentation.lifecycleState === 'enabled' &&
      layerState._managerLifecyclePresentation.enabled &&
      !layerState._managerLifecyclePresentation.uncertain
    );
  }

  function syncAtcLifecyclePresentation() {
    const visible = atcPresentationAllowed();
    if (layerState._dataSource) layerState._dataSource.show = visible;
    if (visible) {
      installInteraction();
      parts.rendering.updateSelectionEntity();
      parts.rendering.updateRenderVisibility();
    } else {
      removeInteraction();
      if (layerState._selectedEntity && layerState._viewer)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
    }
  }

  function installInteraction() {
    if (!layerState._viewer || layerState._clickHandler) return;
    registerPickOwner(ATC_LAYER_ID, (id) => id.startsWith(ATC_PREFIX));
    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      layerState._viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      if (!atcPresentationAllowed()) return;
      const icao = pickedAtcAirportAt(click.position);
      if (!icao) return;
      parts.selection.selectAtcAirport(icao, { origin: 'user' });
      if (typeof document !== 'undefined') {
        document.dispatchEvent(
          new CustomEvent('gev:atc-selected', { detail: { icao } }),
        );
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    layerState._horizonTimer = setInterval(
      () => parts.rendering.updateRenderVisibility({ force: false }),
      ATC_HORIZON_TICK_MS,
    );
  }

  function removeInteraction() {
    unregisterPickOwner(ATC_LAYER_ID);
    layerState._clickHandler?.destroy();
    layerState._clickHandler = null;
    if (layerState._horizonTimer) clearInterval(layerState._horizonTimer);
    layerState._horizonTimer = null;
  }

  return {
    atcIcaoFromPick,
    pickedAtcAirportAt,
    atcPresentationAllowed,
    syncAtcLifecyclePresentation,
    installInteraction,
    removeInteraction,
  };
}
