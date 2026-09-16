import {
  PROFILE_LIMITS,
  ProfileValidationError,
} from '../../../src/profiles/schema.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import {
  allowedOriginsFromEnvVars,
  corsHeaders as sharedCorsHeaders,
} from '../common/cors.js';
import { ProfileError } from './store.js';

/**
 * HTTP routes for profiles (connect-style middleware mounted at `/api/profiles`).
 *
 *   POST /api/profiles/login               {name, pin} → {token, profile, created}
 *   GET  /api/profiles/me                  Bearer      → profile
 *   PUT  /api/profiles/me                  Bearer      → merged profile (≤64 KB, schema-validated)
 *   POST /api/profiles/logout              Bearer      → revoke this token
 *   POST /api/profiles/devices/revoke-all  Bearer      → revoke every token
 *
 * Cross-origin callers (the lab's other instances) are allowed when their
 * Origin is the same host, the forwarded host, or listed in
 * `GEV_PROFILES_ALLOWED_ORIGINS` (falling back to `GEV_ROOMS_ALLOWED_ORIGINS`
 * so one allowlist covers both shared services on the Pi).
 */

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_MINUTE = 10;

export function allowedOriginsFromEnv(env = process.env) {
  return allowedOriginsFromEnvVars(
    ['GEV_PROFILES_ALLOWED_ORIGINS', 'GEV_ROOMS_ALLOWED_ORIGINS'],
    env,
  );
}

export function corsHeaders(headers, { allowedOrigins = [] } = {}) {
  return sharedCorsHeaders(headers, {
    allowedOrigins,
    methods: 'GET, POST, PUT, OPTIONS',
    requestHeaders: 'Content-Type, Authorization',
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** Bearer token from the Authorization header; '' when absent. */
export function bearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(String(raw).trim());
  return match ? match[1] : '';
}

/** Read a JSON body capped at `maxBytes`; rejects with a ProfileError. */
export function readJsonBody(req, maxBytes = PROFILE_LIMITS.bodyBytesMax) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(
        new ProfileError(413, 'TOO_LARGE', `Body exceeds ${maxBytes} bytes`),
      );
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop keeping bytes; the rest of the body is drained so the 413 can
        // still be written on this connection.
        chunks.length = 0;
        finish(() =>
          reject(
            new ProfileError(
              413,
              'TOO_LARGE',
              `Body exceeds ${maxBytes} bytes`,
            ),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ProfileError(400, 'BAD_JSON', 'Body is not valid JSON'));
        }
      });
    });
    req.on('error', (error) =>
      finish(() =>
        reject(
          new ProfileError(400, 'BAD_BODY', error?.message || 'read failed'),
        ),
      ),
    );
  });
}

function errorResponse(error) {
  if (error instanceof ProfileError) {
    return [error.status, { error: error.message, code: error.code }];
  }
  if (error instanceof ProfileValidationError) {
    return [
      400,
      {
        error: error.message,
        code: error.code,
        ...(error.field ? { field: error.field } : {}),
      },
    ];
  }
  console.warn('[profiles] request failed', error);
  return [500, { error: 'Profile error', code: 'PROFILE_ERROR' }];
}

function deviceLabel(req) {
  const ua = String(req.headers?.['user-agent'] || '');
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  if (/curl/i.test(ua)) return 'curl';
  return ua ? 'Browser' : '';
}

/** connect-style middleware for `/api/profiles`. */
export function createProfilesMiddleware(
  store,
  {
    loginLimiter,
    allowedOrigins = allowedOriginsFromEnv(),
    readBody = readJsonBody,
  } = {},
) {
  const allowLogin =
    loginLimiter ||
    makeRateLimiter({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_PER_MINUTE });

  return async function profilesMiddleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(req.headers || {}, { allowedOrigins });
    const reply = (status, body) => sendJson(res, status, body, cors || {});
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      if (!cors) {
        reply(403, { error: 'Origin not allowed' });
        return;
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // A browser page from a refused origin must not read or write anything.
    if (req.headers?.origin && !cors) {
      reply(403, { error: 'Origin not allowed', code: 'ORIGIN_REFUSED' });
      return;
    }

    try {
      if (pathname === '/login') {
        if (method !== 'POST') {
          reply(405, { error: 'POST {name, pin}' });
          return;
        }
        if (!allowLogin(clientKey(req))) {
          reply(429, {
            error: 'Too many sign-in attempts; wait a minute',
            code: 'RATE_LIMITED',
          });
          return;
        }
        const body = await readBody(req, 4096);
        const result = await store.login({
          name: body?.name,
          pin: body?.pin,
          deviceLabel: deviceLabel(req),
        });
        reply(result.created ? 201 : 200, result);
        return;
      }
      if (pathname === '/me') {
        const token = bearerToken(req.headers);
        if (method === 'GET' || method === 'HEAD') {
          reply(200, await store.me(token));
          return;
        }
        if (method === 'PUT' || method === 'PATCH') {
          const body = await readBody(req, PROFILE_LIMITS.bodyBytesMax);
          const result = await store.update(token, body);
          reply(200, { ...result.profile, applied: result.applied });
          return;
        }
        reply(405, { error: 'GET or PUT' });
        return;
      }
      if (pathname === '/logout') {
        if (method !== 'POST') {
          reply(405, { error: 'POST' });
          return;
        }
        reply(200, await store.logout(bearerToken(req.headers)));
        return;
      }
      if (pathname === '/devices/revoke-all') {
        if (method !== 'POST') {
          reply(405, { error: 'POST' });
          return;
        }
        reply(200, await store.revokeAll(bearerToken(req.headers)));
        return;
      }
      next();
    } catch (error) {
      const [status, body] = errorResponse(error);
      reply(status, body);
    }
  };
}
