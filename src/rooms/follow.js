/**
 * Follow-the-leader planning: pure functions over view-state snapshots. No
 * Cesium, no DOM, so the policy is unit-testable and the adapter stays thin.
 */

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two lon/lat points. */
export function groundDistanceM(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Smallest absolute difference between two angles in degrees. */
export function angleDeltaDeg(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Break a camera change into the deltas the planner reasons about. */
export function cameraDelta(current, target) {
  if (!current || !target) return null;
  return {
    distanceM: groundDistanceM(current, target),
    heightDeltaM: Math.abs(target.height - current.height),
    headingDeg: angleDeltaDeg(current.heading || 0, target.heading || 0),
    pitchDeg: Math.abs((target.pitch ?? -90) - (current.pitch ?? -90)),
  };
}

/**
 * Decide how to move toward the leader's camera.
 *
 * Leader frames arrive up to 4×/s. Small deltas (continuous panning) are set
 * directly so the follower tracks without lag; bigger ones fly briefly so a
 * jump reads as motion; very large ones get a longer flight.
 *
 * @returns {{mode:'skip'|'set'|'fly', duration:number, delta:object|null}}
 */
export function planCameraApply(current, target) {
  if (!target) return { mode: 'skip', duration: 0, delta: null };
  if (!current) return { mode: 'fly', duration: 1.5, delta: null };
  const delta = cameraDelta(current, target);
  const scale = Math.max(Math.min(current.height, target.height), 50);
  const relative = (delta.distanceM + delta.heightDeltaM) / scale;
  if (
    relative < 0.0005 &&
    delta.headingDeg < 0.05 &&
    delta.pitchDeg < 0.05 &&
    delta.heightDeltaM < 0.5
  ) {
    return { mode: 'skip', duration: 0, delta };
  }
  if (relative < 0.35 && delta.headingDeg < 25 && delta.pitchDeg < 20) {
    return { mode: 'set', duration: 0, delta };
  }
  if (delta.distanceM > 2_000_000 || relative > 50) {
    return { mode: 'fly', duration: 2.2, delta };
  }
  if (delta.distanceM > 100_000 || relative > 8) {
    return { mode: 'fly', duration: 1.2, delta };
  }
  return { mode: 'fly', duration: 0.6, delta };
}

/** Which layers to switch on/off to match the leader. */
export function diffLayers(currentIds, targetIds, knownIds = null) {
  const current = new Set(currentIds || []);
  const target = new Set(targetIds || []);
  const known = knownIds ? new Set(knownIds) : null;
  const enable = [...target].filter(
    (id) => !current.has(id) && (!known || known.has(id)),
  );
  const disable = [...current].filter(
    (id) => !target.has(id) && (!known || known.has(id)),
  );
  return { enable, disable };
}

/** Whether two tracked-target descriptors name the same thing. */
export function sameTracked(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.layerId === b.layerId && String(a.id) === String(b.id);
}

/** Stable key for change detection on the leader side. */
export function stateKey(state) {
  if (!state) return '';
  const c = state.camera || {};
  return JSON.stringify([
    Number(c.lon).toFixed(6),
    Number(c.lat).toFixed(6),
    Math.round(Number(c.height) * 10) / 10,
    Math.round(Number(c.heading || 0) * 100) / 100,
    Math.round(Number(c.pitch ?? -90) * 100) / 100,
    Math.round(Number(c.roll || 0) * 100) / 100,
    state.style ?? null,
    [...(state.layers || [])].sort(),
    state.tracked ? [state.tracked.layerId, String(state.tracked.id)] : null,
    state.scene ? [state.scene.id, state.scene.playing !== false] : null,
  ]);
}

/**
 * Follower switch with a manual-override latch.
 *
 * `following` is what the user asked for; `overridden` records that the user
 * moved the camera themselves while following, which pauses application
 * until they press "Rejoin leader" (or toggle follow off and on).
 */
export class FollowController {
  constructor({ following = true } = {}) {
    this.following = Boolean(following);
    this.overridden = false;
    this.applying = false;
  }

  /** Whether leader state should be applied right now. */
  get active() {
    return this.following && !this.overridden;
  }

  setFollowing(value) {
    this.following = Boolean(value);
    this.overridden = false;
    return this.active;
  }

  /** The user grabbed the camera. Returns true when this changed anything. */
  noteManualMove() {
    if (this.applying || !this.following || this.overridden) return false;
    this.overridden = true;
    return true;
  }

  /** Snap back to the leader. */
  rejoin() {
    this.following = true;
    this.overridden = false;
    return true;
  }

  /** Run `fn` with the override guard raised so our own moves are not "manual". */
  whileApplying(fn) {
    const previous = this.applying;
    this.applying = true;
    try {
      return fn();
    } finally {
      this.applying = previous;
    }
  }
}
