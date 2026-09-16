import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORRIDOR_ANCHORS,
  CORRIDOR_BBOX,
  CORRIDOR_POLYGON,
  CORRIDOR_WAYPOINTS,
  corridorBboxContains,
  corridorOutlineFeature,
  flattenCoordinates,
  geometryTouchesCorridor,
  isInsideCorridor,
} from './constants.js';

test('corridor polygon is a closed ring inside the loose bbox', () => {
  assert.ok(CORRIDOR_POLYGON.length >= 4);
  assert.deepEqual(CORRIDOR_POLYGON[0], CORRIDOR_POLYGON.at(-1));
  for (const [lon, lat] of CORRIDOR_POLYGON) {
    assert.ok(corridorBboxContains(lon, lat), `${lon},${lat} outside bbox`);
  }
});

test('both anchors and every waypoint town sit inside the corridor', () => {
  for (const anchor of Object.values(CORRIDOR_ANCHORS))
    assert.ok(isInsideCorridor(anchor.lon, anchor.lat), anchor.icao);
  for (const town of CORRIDOR_WAYPOINTS)
    assert.ok(isInsideCorridor(town.lon, town.lat), town.name);
});

test('neighbouring cities outside the band are excluded', () => {
  assert.equal(isInsideCorridor(-86.7816, 36.1627), false); // Nashville
  assert.equal(isInsideCorridor(-83.3776, 33.951), false); // Athens GA
  assert.equal(isInsideCorridor(-85.1647, 34.257), false); // Rome GA
  assert.equal(isInsideCorridor(-86.5861, 34.7304), false); // Huntsville
  assert.equal(isInsideCorridor(NaN, 34), false);
  assert.equal(isInsideCorridor(-84.9, undefined), false);
});

test('geometryTouchesCorridor accepts overlap and containment, rejects far shapes', () => {
  const dalton = {
    type: 'Polygon',
    coordinates: [
      [
        [-85.1, 34.6],
        [-84.8, 34.6],
        [-84.8, 34.9],
        [-85.1, 34.9],
        [-85.1, 34.6],
      ],
    ],
  };
  const coast = {
    type: 'Polygon',
    coordinates: [
      [
        [-81.3, 31.7],
        [-81.0, 31.7],
        [-81.0, 32.1],
        [-81.3, 32.1],
        [-81.3, 31.7],
      ],
    ],
  };
  const statewide = {
    type: 'Polygon',
    coordinates: [
      [
        [-90, 30],
        [-80, 30],
        [-80, 37],
        [-90, 37],
        [-90, 30],
      ],
    ],
  };
  assert.equal(geometryTouchesCorridor(dalton), true);
  assert.equal(geometryTouchesCorridor(coast), false);
  assert.equal(geometryTouchesCorridor(statewide), true);
  assert.equal(geometryTouchesCorridor(null), false);
  assert.equal(
    geometryTouchesCorridor({ type: 'Point', coordinates: [-84.5, 33.95] }),
    true,
  );
});

test('flattenCoordinates walks any GeoJSON geometry', () => {
  assert.deepEqual(
    flattenCoordinates({
      type: 'MultiPolygon',
      coordinates: [[[[1, 2]]], [[[3, 4]]]],
    }),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.deepEqual(
    flattenCoordinates({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [5, 6] }],
    }),
    [[5, 6]],
  );
  assert.deepEqual(flattenCoordinates(undefined), []);
});

test('outline feature is a GeoJSON polygon of the constant ring', () => {
  const feature = corridorOutlineFeature();
  assert.equal(feature.geometry.type, 'Polygon');
  assert.equal(feature.geometry.coordinates[0].length, CORRIDOR_POLYGON.length);
  assert.ok(CORRIDOR_BBOX.west < CORRIDOR_BBOX.east);
});
