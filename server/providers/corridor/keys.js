/**
 * Provider keys the corridor pack can use. Read lazily from process.env on
 * every request so a POWER UP panel save is live without a restart. An
 * absent key is a configuration state, not a fault: the route answers 402
 * with the key id and the layer shows "KEY REQUIRED" for that sub-layer.
 */
export const CORRIDOR_KEYS = Object.freeze({
  ga511: Object.freeze({ id: 'ga511', envVar: 'GA511_API_KEY' }),
  tdot: Object.freeze({ id: 'tdot', envVar: 'TDOT_API_KEY' }),
  carta: Object.freeze({ id: 'carta', envVar: 'CARTA_BUSTIME_KEY' }),
});

export function corridorKey(id, env = process.env) {
  const spec = CORRIDOR_KEYS[id];
  if (!spec) return '';
  return String(env[spec.envVar] || '').trim();
}

export function corridorKeyStatus(env = process.env) {
  return Object.fromEntries(
    Object.values(CORRIDOR_KEYS).map((spec) => [
      spec.id,
      { envVar: spec.envVar, set: corridorKey(spec.id, env).length > 0 },
    ]),
  );
}

/** Error the routes translate into a 402 "key required" reply. */
export class CorridorKeyRequired extends Error {
  constructor(keyId) {
    super(`${keyId} key required`);
    this.code = 'KEY_REQUIRED';
    this.keyId = keyId;
  }
}
