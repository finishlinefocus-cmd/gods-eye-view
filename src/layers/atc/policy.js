export const ATC_LAYER_ID = 'atc';

export const ATC_PREFIX = 'atc:';

export const ATC_SELECTED_PREFIX = 'atc:selected:';

/** Where the browser fetches audio: the same-origin relay in server/providers/atc.js. */
export const ATC_STREAM_ROUTE = '/api/atc/stream';

export const ATC_MARKER_COLOR = '#ffb347';

export const ATC_MARKER_OFFLINE_COLOR = '#8a6a3a';

export const ATC_SELECTED_COLOR = '#ffe0a3';

export const ATC_LABEL_COLOR = '#ffd9a0';

export const ATC_MARKER_LIFT_M = 6;

export const ATC_PICK_TOLERANCE_PX = 8;

/** Markers stay pickable out to a full-globe view, like Radio. */
export const ATC_GLOBE_INTERACTION_MAX_DISTANCE_M = 50_000_000;

/** ICAO labels only once the camera is close enough for them to read. */
export const ATC_LABEL_MAX_DISTANCE_M = 4_000_000;

export const ATC_HORIZON_TICK_MS = 250;

export const ATC_CAMERA_MOVE_EPSILON_M = 1;

/** Stream route for a mount; the proxy validates the mount against the directory. */
export function atcStreamUrl(mount) {
  return `${ATC_STREAM_ROUTE}/${encodeURIComponent(mount)}`;
}

export const ATC_PICK_OFFSETS = Object.freeze([
  [ATC_PICK_TOLERANCE_PX, 0],
  [-ATC_PICK_TOLERANCE_PX, 0],
  [0, ATC_PICK_TOLERANCE_PX],
  [0, -ATC_PICK_TOLERANCE_PX],
  [ATC_PICK_TOLERANCE_PX, ATC_PICK_TOLERANCE_PX],
  [-ATC_PICK_TOLERANCE_PX, ATC_PICK_TOLERANCE_PX],
  [ATC_PICK_TOLERANCE_PX, -ATC_PICK_TOLERANCE_PX],
  [-ATC_PICK_TOLERANCE_PX, -ATC_PICK_TOLERANCE_PX],
]);
