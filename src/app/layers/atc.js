import { createAtcLayer } from '../../layers/atc/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as render from '../../renderGovernor.js';

/** Construct one ATC Radio layer using the application scene owners. */
export function createApplicationAtc({ surface }) {
  if (!surface?.groundFloor)
    throw new TypeError('ATC needs the application surface services');
  const { groundFloor: ground } = surface;
  return createAtcLayer({ services: { ground, picking, render } });
}
