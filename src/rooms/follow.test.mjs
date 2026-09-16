import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FollowController,
  angleDeltaDeg,
  cameraDelta,
  diffLayers,
  groundDistanceM,
  planCameraApply,
  sameTracked,
  stateKey,
} from './follow.js';

const SF = {
  lon: -122.4,
  lat: 37.8,
  height: 1200,
  heading: 0,
  pitch: -45,
  roll: 0,
};

test('geometry helpers', () => {
  const d = groundDistanceM({ lon: 0, lat: 0 }, { lon: 1, lat: 0 });
  assert.ok(Math.abs(d - 111_195) < 500);
  assert.equal(angleDeltaDeg(350, 10), 20);
  assert.equal(angleDeltaDeg(10, 350), 20);
  assert.equal(angleDeltaDeg(-90, 90), 180);
  const delta = cameraDelta(SF, { ...SF, height: 1300, heading: 15 });
  assert.equal(delta.distanceM, 0);
  assert.equal(delta.heightDeltaM, 100);
  assert.equal(delta.headingDeg, 15);
});

test('camera planning: skip tiny deltas, set small ones, fly the rest with scaled durations', () => {
  assert.equal(planCameraApply(SF, null).mode, 'skip');
  assert.deepEqual(planCameraApply(null, SF), {
    mode: 'fly',
    duration: 1.5,
    delta: null,
  });
  assert.equal(planCameraApply(SF, { ...SF }).mode, 'skip');
  // A 40 m nudge at 1.2 km altitude is a direct set.
  assert.equal(
    planCameraApply(SF, { ...SF, lon: SF.lon + 0.0004 }).mode,
    'set',
  );
  // A few kilometres away at the same altitude: short flight.
  const short = planCameraApply(SF, { ...SF, lon: SF.lon + 0.05 });
  assert.equal(short.mode, 'fly');
  assert.equal(short.duration, 0.6);
  // Big heading swing forces a flight even when the position barely moved.
  assert.equal(planCameraApply(SF, { ...SF, heading: 90 }).mode, 'fly');
  // Across a state from a regional altitude → medium flight; across the planet → long flight.
  const regional = { ...SF, height: 200_000 };
  assert.equal(
    planCameraApply(regional, { ...regional, lon: SF.lon + 3 }).duration,
    1.2,
  );
  // The same hop from street level is a huge relative jump → long flight.
  assert.equal(planCameraApply(SF, { ...SF, lon: SF.lon + 3 }).duration, 2.2);
  assert.equal(
    planCameraApply(SF, { ...SF, lon: 139.7, lat: 35.7 }).duration,
    2.2,
  );
  // From orbit down to street level: relative delta is huge → long flight.
  assert.equal(
    planCameraApply({ ...SF, height: 20_000_000 }, SF).duration,
    2.2,
  );
});

test('layer diff honours the known-layer allowlist', () => {
  assert.deepEqual(diffLayers(['a', 'b'], ['b', 'c']), {
    enable: ['c'],
    disable: ['a'],
  });
  assert.deepEqual(diffLayers(['a', 'b'], ['b', 'zzz'], ['a', 'b', 'c']), {
    enable: [],
    disable: ['a'],
  });
  assert.deepEqual(diffLayers(new Set(['x']), ['x']), {
    enable: [],
    disable: [],
  });
});

test('tracked comparison and state keys', () => {
  assert.ok(sameTracked(null, null));
  assert.ok(
    sameTracked(
      { layerId: 'flights', id: 'abc' },
      { layerId: 'flights', id: 'abc', label: 'X' },
    ),
  );
  assert.ok(
    !sameTracked(
      { layerId: 'flights', id: 'abc' },
      { layerId: 'military', id: 'abc' },
    ),
  );
  assert.ok(!sameTracked({ layerId: 'flights', id: 'abc' }, null));
  const base = {
    camera: SF,
    style: 'noir',
    layers: ['b', 'a'],
    tracked: null,
    scene: null,
  };
  assert.equal(stateKey(base), stateKey({ ...base, layers: ['a', 'b'] }));
  assert.notEqual(stateKey(base), stateKey({ ...base, style: 'normal' }));
  assert.notEqual(
    stateKey(base),
    stateKey({ ...base, camera: { ...SF, lon: SF.lon + 0.001 } }),
  );
  assert.equal(
    stateKey(base),
    stateKey({ ...base, camera: { ...SF, lon: SF.lon + 0.0000001 } }),
  );
  assert.equal(stateKey(null), '');
});

test('FollowController: manual move latches an override until rejoin; own applies are ignored', () => {
  const follow = new FollowController({ following: true });
  assert.ok(follow.active);
  assert.equal(
    follow.whileApplying(() => follow.noteManualMove()),
    false,
  );
  assert.ok(follow.active, 'applying our own state is not a manual move');
  assert.equal(follow.applying, false);
  assert.ok(follow.noteManualMove());
  assert.ok(!follow.active);
  assert.ok(follow.overridden);
  assert.equal(follow.noteManualMove(), false, 'already overridden');
  follow.rejoin();
  assert.ok(follow.active);
  follow.setFollowing(false);
  assert.ok(!follow.active);
  assert.equal(
    follow.noteManualMove(),
    false,
    'not following: nothing to pause',
  );
  assert.ok(follow.setFollowing(true));
  assert.ok(follow.active);
});
