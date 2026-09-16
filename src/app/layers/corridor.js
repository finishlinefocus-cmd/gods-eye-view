import { createCorridorLayer } from '../../layers/corridor/index.js';
import * as picking from '../../data/pickRegistry.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { keySetupRequirement } from '../../keySetupCore.mjs';

/** Construct the Corridor: CHA ↔ ATL layer group with the application services. */
export function createApplicationCorridor() {
  return createCorridorLayer({
    services: {
      picking,
      credits: { registerDynamicCredit },
      keyGuidance: (keyId) => (keyId ? keySetupRequirement(keyId) : ''),
    },
  });
}
