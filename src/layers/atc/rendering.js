import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { listAtcAirports } from './directory.js';
import {
  ATC_CAMERA_MOVE_EPSILON_M,
  ATC_GLOBE_INTERACTION_MAX_DISTANCE_M,
  ATC_LABEL_COLOR,
  ATC_LABEL_MAX_DISTANCE_M,
  ATC_MARKER_COLOR,
  ATC_MARKER_LIFT_M,
  ATC_MARKER_OFFLINE_COLOR,
  ATC_PREFIX,
  ATC_SELECTED_COLOR,
  ATC_SELECTED_PREFIX,
} from './policy.js';

/**
 * Airport markers for the ATC Radio layer: one point per directory airport
 * (amber, with the ICAO code as a near-range label), Cesium clustering at
 * globe scale, horizon occlusion, and a brighter ring on the selected airport.
 * The Radio layer's marker recipe, in a different colour and glyph.
 */
export function createRendering({ state: layerState, services }) {
  const { cachedGroundFloor } = services.ground;
  const { governorRequestRender } = services.render;

  function markerPosition(airport, liftM = ATC_MARKER_LIFT_M) {
    const floor = cachedGroundFloor(airport.lat, airport.lon);
    return Cesium.Cartesian3.fromDegrees(
      airport.lon,
      airport.lat,
      (Number.isFinite(floor) ? floor : 0) + liftM,
    );
  }

  function airportHasOnlineFeed(airport) {
    return (airport.feeds || []).some((feed) => feed.online);
  }

  function markerColor(airport) {
    return airportHasOnlineFeed(airport)
      ? ATC_MARKER_COLOR
      : ATC_MARKER_OFFLINE_COLOR;
  }

  /** Draw every directory airport. Called once per session; the directory is static. */
  function reconcileAirports() {
    if (!layerState._dataSource) return;
    layerState._dataSource.entities.removeAll();
    layerState._renderByIcao.clear();
    for (const airport of listAtcAirports()) {
      const position = markerPosition(airport);
      const color = Cesium.Color.fromCssColorString(markerColor(airport));
      const entity = layerState._dataSource.entities.add({
        id: `${ATC_PREFIX}${airport.icao}`,
        position,
        point: {
          pixelSize: 12,
          color: color.withAlpha(0.9),
          outlineColor: Cesium.Color.fromCssColorString('#2a1a05'),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            100_000,
            1.15,
            12_000_000,
            1,
          ),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            ATC_GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
        },
        label: {
          text: airport.icao,
          font: '600 11px "JetBrains Mono", "SFMono-Regular", Menlo, monospace',
          fillColor: Cesium.Color.fromCssColorString(ATC_LABEL_COLOR),
          outlineColor: Cesium.Color.fromCssColorString('#1a0f02'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            ATC_LABEL_MAX_DISTANCE_M,
          ),
        },
      });
      layerState._renderByIcao.set(airport.icao, { airport, entity, position });
    }
    updateSelectionEntity();
    updateRenderVisibility();
  }

  /** A brighter, larger ring on the selected airport, added to viewer.entities like Radio. */
  function updateSelectionEntity() {
    const viewer = layerState._viewer;
    if (!viewer) return;
    if (layerState._selectedEntity) {
      viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
    }
    const record = layerState._selectedIcao
      ? layerState._renderByIcao.get(layerState._selectedIcao)
      : null;
    if (!record || !layerState._dataSource?.show) return;
    layerState._selectedEntity = viewer.entities.add({
      id: `${ATC_SELECTED_PREFIX}${record.airport.icao}`,
      position: markerPosition(record.airport, ATC_MARKER_LIFT_M + 2),
      point: {
        pixelSize: 18,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.fromCssColorString(ATC_SELECTED_COLOR),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          ATC_GLOBE_INTERACTION_MAX_DISTANCE_M,
        ),
      },
    });
    governorRequestRender('atc-selection');
  }

  function cameraMoved(previous, current) {
    if (!previous || !current) return true;
    return (
      Math.abs(previous.x - current.x) > ATC_CAMERA_MOVE_EPSILON_M ||
      Math.abs(previous.y - current.y) > ATC_CAMERA_MOVE_EPSILON_M ||
      Math.abs(previous.z - current.z) > ATC_CAMERA_MOVE_EPSILON_M
    );
  }

  /** Hide markers behind the horizon; polled while enabled, cheap when the camera is still. */
  function updateRenderVisibility({ force = true } = {}) {
    if (!layerState._viewer || !layerState._dataSource) return;
    const cameraPosition = layerState._viewer.camera?.positionWC;
    if (
      !force &&
      !cameraMoved(layerState._lastHorizonCameraPosition, cameraPosition)
    )
      return;
    layerState._lastHorizonCameraPosition = cameraPosition
      ? { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z }
      : null;
    const occluder = horizonOccluder(layerState._viewer.camera);
    let changed = false;
    for (const record of layerState._renderByIcao.values()) {
      const visible = occluder.isPointVisible(record.position);
      if (record.entity.show !== visible) changed = true;
      record.entity.show = visible;
    }
    if (layerState._selectedEntity) {
      const position = layerState._selectedEntity.position?.getValue?.(
        Cesium.JulianDate.now(),
      );
      const visible = !position || occluder.isPointVisible(position);
      if (layerState._selectedEntity.show !== visible) changed = true;
      layerState._selectedEntity.show = visible;
    }
    if (changed) governorRequestRender('atc-horizon');
  }

  /** Cluster neighbouring airports (Bay Area, LA basin, NYC) at globe scale. */
  function installClusterStyling() {
    if (!layerState._dataSource || layerState._removeClusterListener) return;
    const clustering = layerState._dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 36;
    clustering.minimumClusterSize = 2;
    clustering.clusterPoints = true;
    clustering.clusterLabels = true;
    clustering.clusterBillboards = false;
    const clusterColor = Cesium.Color.fromCssColorString(ATC_MARKER_COLOR);
    layerState._removeClusterListener =
      clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
        // Mirror the entity list onto the point so a click on either part of
        // the cluster resolves to its first airport.
        cluster.point.id = clusteredEntities;
        cluster.billboard.id = clusteredEntities;
        cluster.label.show = true;
        cluster.label.text = String(clusteredEntities.length);
        cluster.label.font = '700 10px "JetBrains Mono", Menlo, monospace';
        cluster.label.fillColor = Cesium.Color.fromCssColorString('#1a0f02');
        cluster.label.style = Cesium.LabelStyle.FILL;
        cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
        cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
        cluster.label.pixelOffset = new Cesium.Cartesian2(0, 0);
        cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.point.show = true;
        cluster.point.pixelSize = Math.min(
          26,
          14 + Math.log2(clusteredEntities.length) * 2,
        );
        cluster.point.color = clusterColor.withAlpha(0.92);
        cluster.point.outlineColor = Cesium.Color.fromCssColorString('#2a1a05');
        cluster.point.outlineWidth = 2;
        cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.point.distanceDisplayCondition =
          new Cesium.DistanceDisplayCondition(
            0,
            ATC_GLOBE_INTERACTION_MAX_DISTANCE_M,
          );
      });
  }

  return {
    markerPosition,
    reconcileAirports,
    updateSelectionEntity,
    updateRenderVisibility,
    installClusterStyling,
  };
}
