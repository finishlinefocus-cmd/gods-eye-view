import { Readable } from 'node:stream';
import { isKnownAtcMount } from '../../../src/layers/atc/directory.js';
import {
  ATC_STREAM_HOST_SUFFIX,
  ATC_STREAM_MAX_CONCURRENT,
  ATC_STREAM_MAX_REDIRECTS,
  ATC_STREAM_ORIGIN,
  ATC_STREAM_TIMEOUT_MS,
  ATC_STREAM_USER_AGENT,
} from './constants.js';

/**
 * LiveATC audio relay: `GET /api/atc/stream/:mount`.
 *
 * The application is served over HTTPS on the tailnet while LiveATC edges
 * speak plain HTTP to browsers, so a direct `<audio src>` would be blocked as
 * mixed content. The proxy relays the MPEG stream byte-for-byte: no buffering
 * beyond Node's own, the upstream socket dropped the moment the listener goes
 * away, and only mounts from the committed directory are ever requested.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Parse `/stream/<mount>` from the path the middleware receives. */
export function parseAtcStreamPath(pathname) {
  const match = /^\/stream\/([^/]+)\/?$/.exec(pathname || '');
  if (!match) return null;
  let mount;
  try {
    mount = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return mount.toLowerCase();
}

/** Where a mount is fetched from; null when it is not in the directory. */
export function atcStreamUpstreamUrl(
  mount,
  { isKnown = isKnownAtcMount } = {},
) {
  if (!isKnown(mount)) return null;
  return `${ATC_STREAM_ORIGIN}/${mount}`;
}

/**
 * Decide whether a redirect may be followed: https or http, any host that is
 * a LiveATC host, nothing else. LiveATC hands d.liveatc.net requests to a
 * per-region edge such as s1-fmt2.liveatc.net.
 */
export function atcRedirectDecision(currentUrl, location) {
  if (!location) return { ok: false, reason: 'redirect without location' };
  let next;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return { ok: false, reason: 'redirect to unparseable location' };
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') {
    return { ok: false, reason: 'redirect to non-http location' };
  }
  const host = next.hostname.toLowerCase();
  if (
    host !== ATC_STREAM_HOST_SUFFIX.slice(1) &&
    !host.endsWith(ATC_STREAM_HOST_SUFFIX)
  ) {
    return { ok: false, reason: 'redirect off liveatc.net' };
  }
  return { ok: true, url: next.href };
}

/** Open the stream, following LiveATC-internal redirects, within a header deadline. */
export async function openAtcStream(
  url,
  { fetchImpl = fetch, signal = null, timeoutMs = ATC_STREAM_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', onAbort);
  const headers = {
    'User-Agent': ATC_STREAM_USER_AGENT,
    Accept: 'audio/mpeg, */*',
  };
  try {
    let current = url;
    for (let hop = 0; hop <= ATC_STREAM_MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, finalUrl: current };
      }
      const decision = atcRedirectDecision(
        current,
        response.headers.get('location'),
      );
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      if (!decision.ok) throw new Error(`upstream ${decision.reason}`);
      if (hop === ATC_STREAM_MAX_REDIRECTS)
        throw new Error('upstream redirected too many times');
      current = decision.url;
    }
    throw new Error('upstream redirected too many times');
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Watch the listener's response for an early goodbye. */
function watchDownstreamClose(res) {
  const controller = new AbortController();
  const state = { signal: controller.signal, closed: false };
  const onClose = () => {
    if (res.writableEnded) return;
    state.closed = true;
    controller.abort();
  };
  res.once?.('close', onClose);
  res.once?.('error', onClose);
  return state;
}

/** Pipe the upstream body to the listener and tear both down together. */
function relayAtcBody(res, upstream, onDone) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  const body = upstream.body;
  const stream =
    body &&
    typeof body.pipe !== 'function' &&
    typeof Readable.fromWeb === 'function'
      ? Readable.fromWeb(body)
      : body;
  if (!stream || typeof stream.pipe !== 'function') {
    res.end();
    onDone();
    return;
  }
  let released = false;
  const releaseUpstream = () => {
    if (released) return;
    released = true;
    stream.unpipe(res);
    stream.destroy();
    try {
      const cancelled = body?.cancel?.();
      if (typeof cancelled?.catch === 'function') cancelled.catch(() => {});
    } catch {
      /* already closed */
    }
    onDone();
  };
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
    releaseUpstream();
  });
  stream.once('end', () => {
    released = true;
    onDone();
  });
  res.once('close', () => {
    if (!res.writableEnded) releaseUpstream();
  });
  res.once('error', releaseUpstream);
  stream.pipe(res);
}

/**
 * Connect-style middleware mounted at `/api/atc`.
 * @param {{fetchImpl?: typeof fetch, isKnown?: (mount: string) => boolean, maxConcurrent?: number}} [options]
 */
export function createAtcProxyMiddleware({
  fetchImpl = fetch,
  isKnown = isKnownAtcMount,
  maxConcurrent = ATC_STREAM_MAX_CONCURRENT,
} = {}) {
  let active = 0;
  return async function atcProxyMiddleware(req, res, next) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const mount = parseAtcStreamPath(pathname);
    if (mount === null) {
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    const upstreamUrl = atcStreamUpstreamUrl(mount, { isKnown });
    if (!upstreamUrl) return sendJson(res, 404, { error: 'Unknown ATC mount' });
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    if (active >= maxConcurrent) {
      return sendJson(res, 503, { error: 'Too many ATC listeners' });
    }
    active += 1;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      active -= 1;
    };
    const downstream = watchDownstreamClose(res);
    let upstream;
    try {
      ({ response: upstream } = await openAtcStream(upstreamUrl, {
        fetchImpl,
        signal: downstream.signal,
      }));
    } catch (error) {
      done();
      if (downstream.closed) return;
      const aborted =
        error?.name === 'AbortError' || error?.name === 'TimeoutError';
      return sendJson(res, aborted ? 504 : 502, {
        error: aborted
          ? 'ATC stream timed out'
          : `ATC stream unavailable: ${error?.message || 'error'}`,
      });
    }
    if (downstream.closed) {
      done();
      try {
        await upstream.body?.cancel();
      } catch {
        /* no-op */
      }
      return;
    }
    if (!upstream.ok) {
      done();
      try {
        await upstream.body?.cancel();
      } catch {
        /* no-op */
      }
      return sendJson(res, upstream.status === 404 ? 404 : 502, {
        error: `ATC stream answered ${upstream.status}`,
      });
    }
    relayAtcBody(res, upstream, done);
  };
}
