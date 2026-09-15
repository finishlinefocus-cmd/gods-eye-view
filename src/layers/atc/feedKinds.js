/**
 * LiveATC feed kinds: the controller position a feed carries.
 * Shared by the offline feed-directory builder and the runtime layer.
 */

export const FEED_KINDS = Object.freeze([
  'tower',
  'ground',
  'clearance',
  'approach',
  'departure',
  'center',
  'other',
]);

/**
 * Label keywords in leftmost-match order. A combined feed such as
 * "Del/Gnd (Alt)/Twr (Alt)" is classified by whichever position appears first
 * in the label, which is how LiveATC orders combined channels.
 */
const LABEL_RULES = Object.freeze([
  ['tower', /\b(tower|twr)\b/i],
  ['ground', /\b(ground|gnd)\b/i],
  ['clearance', /\b(clearance|clnc|del|delivery)\b/i],
  ['approach', /\b(approach|app|arrival|arr|final|tracon)\b/i],
  ['departure', /\b(departure|dep)\b/i],
  ['center', /\b(center|centre|ctr|artcc|oceanic)\b/i],
]);

const MOUNT_RULES = Object.freeze([
  ['tower', /_twr/],
  ['ground', /_gnd/],
  ['clearance', /_del|_clnc/],
  ['approach', /_app|_arr|_final/],
  ['departure', /_dep/],
  ['center', /^z[a-z]{2}_|_ctr|_center/],
]);

/** Classify a feed by its human label first, then by its mount name. */
export function classifyFeedKind(label, mount) {
  const text = String(label || '');
  let best = null;
  for (const [kind, pattern] of LABEL_RULES) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index))
      best = { kind, index: match.index };
  }
  if (best) return best.kind;
  const name = String(mount || '').toLowerCase();
  for (const [kind, pattern] of MOUNT_RULES) {
    if (pattern.test(name)) return kind;
  }
  return 'other';
}

/** Normalize a user-supplied kind ("Tower", "app", "TRACON") to a FEED_KINDS value. */
export function normalizeFeedKind(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (FEED_KINDS.includes(text)) return text;
  const kind = classifyFeedKind(text, '');
  return kind === 'other' ? null : kind;
}
