import { createState } from './state.js';
import { createRendering } from './rendering.js';
import { createInteraction } from './interaction.js';
import { createPresentation } from './presentation.js';
import { createPlayback } from './playback.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';

/**
 * Construct one ATC Radio layer: LiveATC airport markers with a same-origin
 * audio relay. Nothing is module-global; every Cesium and DOM resource lives
 * on the instance and is released by `destroy()`.
 */
export function createAtcLayer({ services }) {
  if (!services?.ground || !services?.picking || !services?.render) {
    throw new TypeError(
      'An ATC layer needs ground, picking and render services',
    );
  }
  const state = createState();
  const parts = {};
  const context = { state, services, parts };
  parts.rendering = createRendering(context);
  parts.interaction = createInteraction(context);
  parts.presentation = createPresentation(context);
  parts.playback = createPlayback(context);
  parts.selection = createSelection(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign({}, parts.controls.methods, parts.lifecycle.methods, {
    atcIcaoFromPick: parts.interaction.atcIcaoFromPick,
  });
}

export {
  ATC_LAYER_ID,
  ATC_PREFIX,
  ATC_STREAM_ROUTE,
  ATC_MARKER_COLOR,
  atcStreamUrl,
} from './policy.js';
export {
  ATC_TERMINAL_RANGE_NM,
  ATC_TOWER_CEILING_FT,
  ATC_TOWER_RANGE_NM,
  chooseAtcFeed,
  defaultAtcKind,
  findAtcAirport,
  findAtcFeed,
  greatCircleNm,
  isKnownAtcMount,
  listAtcAirports,
  nearestAtcAirport,
  nearestAtcSelection,
  normalizeIcao,
  resolveAtcAirportQuery,
} from './directory.js';
export {
  FEED_KINDS,
  classifyFeedKind,
  normalizeFeedKind,
} from './feedKinds.js';
export { LIVEATC_AIRPORTS, LIVEATC_GENERATED_AT } from './liveatcFeeds.js';
