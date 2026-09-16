import * as Cesium from 'cesium';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';
import { diffLayers, planCameraApply, sameTracked } from './follow.js';
import { ROOM_LIMITS } from './protocol.js';

/**
 * Bridge between a RoomSession and the running application: reads the view
 * state the leader broadcasts and applies a leader's (or a moment's) state on
 * a follower. This is the only rooms module that touches Cesium or the shell.
 */

/** Layers whose tracked/selected subject a room can name and re-select. */
const TRACKED_FAMILIES = Object.freeze([
  {
    layerId: 'flights',
    read: 'getTrackedInfo',
    idKey: 'icao24',
    labelKey: 'callsign',
  },
  {
    layerId: 'military',
    read: 'getTrackedInfo',
    idKey: 'icao24',
    labelKey: 'callsign',
  },
  {
    layerId: 'satellites',
    read: 'getTrackedInfo',
    idKey: 'noradId',
    labelKey: 'name',
  },
  {
    layerId: 'ais-live-vessels',
    read: 'getSelectedInfo',
    idKey: 'mmsi',
    labelKey: 'name',
  },
]);

const PING_COLORS = new Map();

function pingColor(hex) {
  if (!PING_COLORS.has(hex)) {
    PING_COLORS.set(hex, Cesium.Color.fromCssColorString(hex || '#ffb347'));
  }
  return PING_COLORS.get(hex);
}

export function createRoomViewAdapter({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  window: win = globalThis.window,
  origin = 'tool',
}) {
  const layerModule = (layerId) => dataManager?.layers?.get?.(layerId)?.module;
  let lastLayersKey = null;
  let lastTrackedKey = null;
  let pingSource = null;
  const pingTimers = new Map();

  function currentCamera() {
    const state = styleManager?.getCameraState?.();
    if (!state) return null;
    return {
      lon: state.lon,
      lat: state.lat,
      height: state.alt,
      heading: state.heading,
      pitch: state.pitch,
      roll: state.roll,
    };
  }

  function currentTracked() {
    for (const family of TRACKED_FAMILIES) {
      const module = layerModule(family.layerId);
      const info = module?.[family.read]?.();
      const id = info?.[family.idKey];
      if (id === undefined || id === null || id === '') continue;
      const label = info[family.labelKey];
      return {
        layerId: family.layerId,
        id: String(id),
        ...(label ? { label: String(label).trim() } : {}),
      };
    }
    return null;
  }

  function currentScene() {
    const status = sceneDirector?.getPlaybackStatus?.();
    if (!status?.running || !status.selectedSceneId) return null;
    return { id: status.selectedSceneId, playing: true };
  }

  function getState() {
    const camera = currentCamera();
    if (!camera) return null;
    return {
      camera,
      style: styleManager?.activeStyle || null,
      layers: [...(dataManager?.getEnabledLayerIds?.() || [])],
      tracked: currentTracked(),
      scene: currentScene(),
    };
  }

  function applyStyle(style) {
    if (!style || typeof style !== 'string') return;
    if (styleManager?.activeStyle === style) return;
    try {
      styleManager.setStyle(style, {
        applyPreset: true,
        revealParameters: false,
        restore: true,
      });
    } catch (error) {
      console.warn('[rooms] setStyle failed', error);
    }
  }

  function applyLayers(layers) {
    if (!dataManager || !Array.isArray(layers)) return;
    const key = [...layers].sort().join(',');
    if (key === lastLayersKey) return;
    lastLayersKey = key;
    const known = [...(dataManager.layers?.keys?.() || [])];
    const { enable, disable } = diffLayers(
      dataManager.getEnabledLayerIds?.() || [],
      layers,
      known,
    );
    for (const id of disable) {
      Promise.resolve(dataManager.setEnabled(id, false, { origin })).catch(
        () => {},
      );
    }
    for (const id of enable) {
      Promise.resolve(dataManager.setEnabled(id, true, { origin })).catch(
        () => {},
      );
    }
  }

  function applyTracked(tracked) {
    const current = currentTracked();
    const key = tracked ? `${tracked.layerId}:${tracked.id}` : '';
    if (sameTracked(current, tracked)) {
      lastTrackedKey = key;
      return Boolean(tracked);
    }
    if (!tracked) {
      // Only let go of a subject the room asked us to follow.
      if (lastTrackedKey && current) {
        const module = layerModule(current.layerId);
        if (current.layerId === 'ais-live-vessels') module?.clearSelection?.();
        else module?.stopTracking?.({ origin });
      }
      lastTrackedKey = '';
      return false;
    }
    if (key === lastTrackedKey) return true; // requested, target not yet loaded
    lastTrackedKey = key;
    const module = layerModule(tracked.layerId);
    if (!module) return false;
    if (current && current.layerId !== tracked.layerId) {
      const previous = layerModule(current.layerId);
      if (current.layerId === 'ais-live-vessels') previous?.clearSelection?.();
      else previous?.stopTracking?.({ origin });
    }
    try {
      if (tracked.layerId === 'ais-live-vessels') {
        module.selectById?.(tracked.id);
        return false; // vessels do not lock the camera; keep applying it
      }
      if (tracked.layerId === 'satellites') {
        return Boolean(module.trackById?.(Number(tracked.id), { origin }));
      }
      return Boolean(module.trackById?.(tracked.id, { origin }));
    } catch (error) {
      console.warn('[rooms] track failed', error);
      return false;
    }
  }

  function applyScene(scene) {
    if (!sceneDirector) return false;
    const status = sceneDirector.getPlaybackStatus?.();
    const running = Boolean(status?.running);
    if (scene?.playing && scene.id) {
      if (!running || status.selectedSceneId !== scene.id) {
        Promise.resolve(sceneDirector.startScene(scene.id)).catch(() => {});
      }
      return true;
    }
    if (running) sceneDirector.stopScene?.('Room leader stopped the scene');
    return false;
  }

  function applyCamera(camera, mode) {
    if (!camera || !viewer?.camera) return;
    const plan =
      mode === 'jump'
        ? { mode: 'fly', duration: 1.8 }
        : planCameraApply(currentCamera(), camera);
    if (plan.mode === 'skip') return;
    const view = {
      destination: Cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(camera.heading || 0),
        pitch: Cesium.Math.toRadians(camera.pitch ?? -90),
        roll: Cesium.Math.toRadians(camera.roll || 0),
      },
    };
    try {
      viewer.camera.cancelFlight();
      if (plan.mode === 'set') {
        viewer.camera.setView(view);
      } else {
        viewer.camera.flyTo({
          ...view,
          duration: plan.duration,
          easingFunction:
            plan.duration <= 0.6
              ? Cesium.EasingFunction.LINEAR_NONE
              : Cesium.EasingFunction.CUBIC_IN_OUT,
        });
      }
      viewer.scene?.requestRender?.();
    } catch (error) {
      console.warn('[rooms] camera apply failed', error);
    }
  }

  function applyState(state, { mode = 'follow' } = {}) {
    if (!state) return;
    applyStyle(state.style);
    applyLayers(state.layers || []);
    const sceneOwnsCamera = applyScene(state.scene);
    const trackingOwnsCamera = applyTracked(state.tracked);
    if (sceneOwnsCamera) return;
    if (trackingOwnsCamera && mode === 'follow') return;
    applyCamera(state.camera, mode);
  }

  /** Take navigation authority once (stops orbit/tracking/flights). */
  function releaseCamera() {
    lastLayersKey = null;
    lastTrackedKey = null;
    if (typeof styleManager?.runImmediateNavigation !== 'function') return true;
    try {
      return styleManager.runImmediateNavigation('room', () => true) !== false;
    } catch {
      return true;
    }
  }

  function onManualMove(callback) {
    const canvas = viewer?.scene?.canvas || viewer?.canvas;
    const handler = () => callback();
    const options = { passive: true, capture: true };
    canvas?.addEventListener('pointerdown', handler, options);
    canvas?.addEventListener('wheel', handler, options);
    canvas?.addEventListener('touchstart', handler, options);
    const disposeAuthority = registerNavigationAuthorityListener(win, handler);
    return () => {
      canvas?.removeEventListener('pointerdown', handler, options);
      canvas?.removeEventListener('wheel', handler, options);
      canvas?.removeEventListener('touchstart', handler, options);
      disposeAuthority();
    };
  }

  /** Where "here" is: the tracked subject, else the globe under screen centre. */
  function pingTarget() {
    const tracked = currentTracked();
    if (tracked) {
      const module = layerModule(tracked.layerId);
      const family = TRACKED_FAMILIES.find(
        (f) => f.layerId === tracked.layerId,
      );
      const info = module?.[family.read]?.();
      if (Number.isFinite(info?.longitude) && Number.isFinite(info?.latitude)) {
        return {
          lon: info.longitude,
          lat: info.latitude,
          label: tracked.label || '',
        };
      }
    }
    const scene = viewer?.scene;
    const canvas = scene?.canvas;
    if (scene && canvas) {
      const centre = new Cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      let cartesian = null;
      try {
        const ray = viewer.camera.getPickRay(centre);
        cartesian = ray ? scene.globe?.pick(ray, scene) : null;
        if (!cartesian) {
          cartesian = viewer.camera.pickEllipsoid(
            centre,
            scene.globe?.ellipsoid,
          );
        }
      } catch {
        cartesian = null;
      }
      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        if (carto) {
          return {
            lon: Cesium.Math.toDegrees(carto.longitude),
            lat: Cesium.Math.toDegrees(carto.latitude),
            label: '',
          };
        }
      }
    }
    const camera = currentCamera();
    return camera ? { lon: camera.lon, lat: camera.lat, label: '' } : null;
  }

  function ensurePingSource() {
    if (pingSource || !viewer?.dataSources) return pingSource;
    pingSource = new Cesium.CustomDataSource('rooms-pings');
    viewer.dataSources.add(pingSource);
    return pingSource;
  }

  function showPing(ping) {
    const source = ensurePingSource();
    if (!source) return;
    const color = pingColor(ping.from?.color);
    const text = [ping.from?.name, ping.label].filter(Boolean).join(' · ');
    const entity = source.entities.add({
      id: `room-ping-${ping.id}`,
      position: Cesium.Cartesian3.fromDegrees(ping.lon, ping.lat, 0),
      point: {
        pixelSize: 12,
        color,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: text || 'ping',
        font: '600 12px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: color.withAlpha(0.35),
      },
    });
    viewer.scene?.requestRender?.();
    const timer = setTimeout(() => {
      pingTimers.delete(ping.id);
      source.entities.remove(entity);
      viewer.scene?.requestRender?.();
    }, ping.ttlMs || ROOM_LIMITS.pingTtlMs);
    pingTimers.set(ping.id, timer);
  }

  function clearPings() {
    for (const timer of pingTimers.values()) clearTimeout(timer);
    pingTimers.clear();
    pingSource?.entities.removeAll();
    viewer?.scene?.requestRender?.();
  }

  function destroy() {
    clearPings();
    if (pingSource && viewer?.dataSources && !viewer.isDestroyed?.()) {
      try {
        viewer.dataSources.remove(pingSource, true);
      } catch {
        /* viewer gone */
      }
    }
    pingSource = null;
  }

  return {
    getState,
    applyState,
    releaseCamera,
    onManualMove,
    pingTarget,
    showPing,
    clearPings,
    destroy,
  };
}
