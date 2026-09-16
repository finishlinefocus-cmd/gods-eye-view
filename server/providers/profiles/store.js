import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROFILE_LIMITS,
  emptyProfileFields,
  isValidPin,
  mergeProfileFields,
  normalizeProfileName,
  profileNameKey,
  sanitizeProfileFields,
  sanitizeProfileUpdate,
} from '../../../src/profiles/schema.js';

/**
 * Persistent profile store: one JSON file per profile under `dir`, written
 * atomically (temp file + rename). Auth is name + PIN; the PIN is kept as an
 * scrypt hash with a per-profile salt, and every device holds its own random
 * bearer token, stored hashed, valid 180 days, revocable.
 *
 * Token format: `<profileKey>.<secret>` so a request can be routed to its
 * profile file without an index; only the secret's SHA-256 is compared.
 */

const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1 });
const KEY_LENGTH = 32;
const TOKEN_TTL_MS = PROFILE_LIMITS.tokenDays * 24 * 60 * 60 * 1000;
const FILE_VERSION = 1;

export class ProfileError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProfileError';
    this.status = status;
    this.code = code;
  }
}

/** Filesystem-safe identity of a profile name (32 hex chars). */
export function profileFileKey(name) {
  return crypto
    .createHash('sha256')
    .update(profileNameKey(name), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function hashSecret(secret) {
  return crypto
    .createHash('sha256')
    .update(String(secret), 'utf8')
    .digest('hex');
}

function scrypt(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(pin),
      Buffer.from(salt, 'hex'),
      KEY_LENGTH,
      SCRYPT_OPTIONS,
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Write `data` to `file` atomically; the directory is created on demand. */
export async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const body = JSON.stringify(data, null, 2);
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

/** Public shape of a stored profile (never the PIN or token hashes). */
export function publicProfile(record, { now = Date.now() } = {}) {
  const devices = (record.devices || []).filter((d) => d.expiresAt > now);
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...emptyProfileFields(),
    ...record.fields,
    fieldUpdatedAt: { ...(record.fieldUpdatedAt || {}) },
    devices: devices.length,
  };
}

function defaultLog(line) {
  console.info(`[profiles] ${line}`);
}

export function createProfileStore({
  dir,
  now = Date.now,
  log = defaultLog,
  randomBytes = (n) => crypto.randomBytes(n),
  tokenTtlMs = TOKEN_TTL_MS,
} = {}) {
  if (!dir) throw new Error('profile store needs a directory');
  /** @type {Map<string, object>} key → record */
  const cache = new Map();
  /** Serialise writes per profile so two devices cannot interleave a file. */
  const locks = new Map();

  const fileFor = (key) => path.join(dir, `${key}.json`);

  async function withLock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(
      key,
      previous.then(() => current),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  async function load(key) {
    if (cache.has(key)) return cache.get(key);
    let raw;
    try {
      raw = await fsp.readFile(fileFor(key), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProfileError(
        500,
        'CORRUPT_PROFILE',
        'Profile file is unreadable',
      );
    }
    const record = {
      version: FILE_VERSION,
      id: String(parsed.id || key),
      key,
      name: normalizeProfileName(parsed.name) || key,
      createdAt: Number(parsed.createdAt) || now(),
      updatedAt: Number(parsed.updatedAt) || now(),
      pin: parsed.pin && typeof parsed.pin === 'object' ? parsed.pin : null,
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      fields: sanitizeProfileFields(parsed.fields),
      fieldUpdatedAt:
        parsed.fieldUpdatedAt && typeof parsed.fieldUpdatedAt === 'object'
          ? parsed.fieldUpdatedAt
          : {},
    };
    if (!record.pin?.hash || !record.pin?.salt) {
      throw new ProfileError(500, 'CORRUPT_PROFILE', 'Profile file has no PIN');
    }
    cache.set(key, record);
    return record;
  }

  async function persist(record) {
    record.devices = record.devices.filter((d) => d.expiresAt > now());
    await writeJsonAtomic(fileFor(record.key), {
      version: FILE_VERSION,
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pin: record.pin,
      devices: record.devices,
      fields: record.fields,
      fieldUpdatedAt: record.fieldUpdatedAt,
    });
    cache.set(record.key, record);
  }

  function mintToken(record, { label = '' } = {}) {
    const secret = randomBytes(32).toString('hex');
    const t = now();
    const device = {
      id: randomBytes(6).toString('hex'),
      tokenHash: hashSecret(secret),
      label: String(label || '').slice(0, 80),
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + tokenTtlMs,
    };
    record.devices.push(device);
    return { token: `${record.key}.${secret}`, device };
  }

  /**
   * Name + PIN → token. Creates the profile when the name is unknown.
   * A wrong PIN on an existing name is a 401 after a full scrypt, so timing
   * does not distinguish "no such name" from "wrong PIN" beyond the create path.
   */
  async function login({ name, pin, deviceLabel = '' }) {
    const display = normalizeProfileName(name);
    if (!display)
      throw new ProfileError(400, 'INVALID_NAME', 'A name is required');
    if (!isValidPin(pin)) {
      throw new ProfileError(400, 'INVALID_PIN', 'PIN must be 4-8 digits');
    }
    const key = profileFileKey(display);
    return withLock(key, async () => {
      let record = await load(key);
      let created = false;
      if (!record) {
        const salt = randomBytes(16).toString('hex');
        const hash = (await scrypt(pin, salt)).toString('hex');
        const t = now();
        record = {
          version: FILE_VERSION,
          id: key,
          key,
          name: display,
          createdAt: t,
          updatedAt: t,
          pin: { algo: 'scrypt', salt, hash, ...SCRYPT_OPTIONS },
          devices: [],
          fields: emptyProfileFields(),
          fieldUpdatedAt: {},
        };
        created = true;
      } else {
        const candidate = (await scrypt(pin, record.pin.salt)).toString('hex');
        if (!timingSafeEqualHex(candidate, record.pin.hash)) {
          log(`login refused for "${record.name}" (wrong PIN)`);
          throw new ProfileError(401, 'WRONG_PIN', 'Wrong PIN');
        }
      }
      const { token, device } = mintToken(record, { label: deviceLabel });
      await persist(record);
      log(
        `${created ? 'created' : 'login'} "${record.name}" device ${device.id} (${record.devices.length} active)`,
      );
      return { token, created, profile: publicProfile(record, { now: now() }) };
    });
  }

  /** Resolve a bearer token to `{ record, device }` or throw 401. */
  async function authenticate(token) {
    const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(String(token || ''));
    if (!match) throw new ProfileError(401, 'UNAUTHORIZED', 'Sign in required');
    const [, key, secret] = match;
    const record = await load(key);
    if (!record)
      throw new ProfileError(401, 'UNAUTHORIZED', 'Sign in required');
    const hash = hashSecret(secret);
    const t = now();
    const device = record.devices.find(
      (d) => d.expiresAt > t && timingSafeEqualHex(d.tokenHash, hash),
    );
    if (!device) throw new ProfileError(401, 'UNAUTHORIZED', 'Session expired');
    return { record, device };
  }

  async function me(token) {
    const { record, device } = await authenticate(token);
    // Touch lastSeen at most hourly so reads do not rewrite the file.
    if (now() - device.lastSeenAt > 60 * 60 * 1000) {
      device.lastSeenAt = now();
      await withLock(record.key, () => persist(record));
    }
    return publicProfile(record, { now: now() });
  }

  async function update(token, body) {
    const { record } = await authenticate(token);
    const t = now();
    const sanitized = sanitizeProfileUpdate(body, { now: t });
    return withLock(record.key, async () => {
      const merged = mergeProfileFields(record, sanitized);
      record.fields = merged.fields;
      record.fieldUpdatedAt = merged.fieldUpdatedAt;
      if (merged.applied.length) record.updatedAt = t;
      await persist(record);
      return {
        profile: publicProfile(record, { now: t }),
        applied: merged.applied,
      };
    });
  }

  async function logout(token) {
    const { record, device } = await authenticate(token);
    return withLock(record.key, async () => {
      record.devices = record.devices.filter((d) => d.id !== device.id);
      await persist(record);
      log(`logout "${record.name}" device ${device.id}`);
      return { revoked: 1, devices: record.devices.length };
    });
  }

  async function revokeAll(token) {
    const { record } = await authenticate(token);
    return withLock(record.key, async () => {
      const count = record.devices.length;
      record.devices = [];
      await persist(record);
      log(`revoke-all "${record.name}" (${count} devices)`);
      return { revoked: count, devices: 0 };
    });
  }

  function clearCache() {
    cache.clear();
  }

  return {
    dir,
    login,
    authenticate,
    me,
    update,
    logout,
    revokeAll,
    clearCache,
    publicProfile,
  };
}

/** Default on-disk location: `GEV_PROFILES_DIR`, else `<repo>/.data/profiles`. */
export function profilesDirFromEnv(
  env = process.env,
  repoRoot = process.cwd(),
) {
  const configured = String(env.GEV_PROFILES_DIR || '').trim();
  return configured
    ? path.resolve(configured)
    : path.join(repoRoot, '.data', 'profiles');
}

/** True when the directory exists (or can be created) and is writable. */
export function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
