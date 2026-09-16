import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProfileStore,
  ensureWritableDir,
  profilesDirFromEnv,
} from './profiles/store.js';
import {
  allowedOriginsFromEnv,
  bearerToken,
  corsHeaders,
  createProfilesMiddleware,
  readJsonBody,
} from './profiles/transport.js';

export {
  createProfileStore,
  ProfileError,
  profileFileKey,
  publicProfile,
  profilesDirFromEnv,
  ensureWritableDir,
  writeJsonAtomic,
} from './profiles/store.js';
export {
  allowedOriginsFromEnv,
  bearerToken,
  corsHeaders,
  createProfilesMiddleware,
  readJsonBody,
};

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * Vite plugin: user profiles (name + PIN, per-device tokens, one JSON file per
 * profile). Registers `/api/profiles*` on the dev or preview server.
 *
 *   GEV_PROFILES_DIR              where profile files live
 *                                 (default `<repo>/.data/profiles`, gitignored;
 *                                 `/var/lib/gev/profiles` on the Pi)
 *   GEV_PROFILES_ALLOWED_ORIGINS  extra origins allowed to call these routes
 *                                 (falls back to GEV_ROOMS_ALLOWED_ORIGINS)
 */
export function profilesProvider(options = {}) {
  let store = null;
  const install = (server) => {
    const dir = options.dir || profilesDirFromEnv(process.env, REPO_ROOT);
    if (!ensureWritableDir(dir)) {
      console.warn(
        `[profiles] ${dir} is not writable; profiles are off. Set GEV_PROFILES_DIR to a writable directory.`,
      );
      server.middlewares.use('/api/profiles', (req, res) => {
        res.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(
          JSON.stringify({
            error: 'Profile store unavailable',
            code: 'STORE_UNAVAILABLE',
          }),
        );
      });
      return;
    }
    store = createProfileStore({ dir, ...options.store });
    server.middlewares.use(
      '/api/profiles',
      createProfilesMiddleware(store, {
        allowedOrigins: options.allowedOrigins ?? allowedOriginsFromEnv(),
      }),
    );
    console.info(`[profiles] store at ${dir}`);
    server.httpServer?.once?.('close', () => store?.clearCache());
  };
  return {
    name: 'profiles-provider',
    configureServer: install,
    configurePreviewServer: install,
  };
}
