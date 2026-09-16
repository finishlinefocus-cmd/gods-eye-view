/**
 * Same-origin-or-allowlisted CORS policy shared by the services other lab
 * instances call cross-origin (rooms, profiles). Browsers always send
 * `Origin`; non-browser clients (curl, scripts) send none and get no CORS
 * headers, which is fine for them. Behind a reverse proxy the public host
 * arrives in `X-Forwarded-Host`.
 */

export function originAllowed(headers, { allowedOrigins = [] } = {}) {
  const origin = headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [headers.host, headers['x-forwarded-host']]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.includes(originHost)) return true;
  return allowedOrigins.some(
    (allowed) => allowed.toLowerCase() === origin.toLowerCase(),
  );
}

/**
 * Headers to echo for an allowed cross-origin request; null when the request
 * has no Origin or the origin is refused (the browser then blocks it).
 */
export function corsHeaders(
  headers,
  {
    allowedOrigins = [],
    methods = 'GET, POST, OPTIONS',
    requestHeaders = 'Content-Type',
  } = {},
) {
  const origin = headers.origin;
  if (!origin || !originAllowed(headers, { allowedOrigins })) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': requestHeaders,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Comma-separated origins from the first env var that is set. */
export function allowedOriginsFromEnvVars(names, env = process.env) {
  for (const name of names) {
    const raw = String(env[name] || '').trim();
    if (raw) {
      return raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return [];
}
