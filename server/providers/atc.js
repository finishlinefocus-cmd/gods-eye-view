import { createAtcProxyMiddleware } from './atc/stream.js';
export {
  createAtcProxyMiddleware,
  atcRedirectDecision,
  atcStreamUpstreamUrl,
  openAtcStream,
  parseAtcStreamPath,
} from './atc/stream.js';

/** Vite plugin: LiveATC audio relay for the ATC Radio layer (`/api/atc/stream/:mount`). */
export function atcProxy(options = {}) {
  const middleware = createAtcProxyMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/atc', middleware);
  };
  return {
    name: 'atc-stream-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
