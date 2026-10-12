const config = require('./config');
const storage = require('./storage');

const LARGE_MODE_KEY = 'buicha:large_mode_manual';
// Upload reservations that are never committed (crash, etc.) are dropped by
// the sweeper once this much time has passed after expiry-to-be.
const RESERVE_MARGIN_MS = 3 * 86400 * 1000;
// /api/capacity result cache (reserve() never uses it)
const CAPACITY_CACHE_MS = 5000;

let capacityCache = null;
let cacheGeneration = 0;

function invalidateCapacityCache() {
  cacheGeneration++;
  capacityCache = null;
}

function keys() {
  return storage.trackKeys;
}

function hashKey(id) {
  return `${keys().hashPrefix}${id}`;
}

function limits() {
  return {
    normalMaxFileSize: config.large_file_threshold,
    largeMaxFileSize: config.max_file_size,
    largeExpireSeconds: config.large_expire_seconds,
    quotaBytes: config.storage_quota_bytes
  };
}

// Serialises check-and-reserve so concurrent uploads cannot overbook
// (single process only).
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function getLargeModeManual() {
  const v = await storage.redis.getAsync(LARGE_MODE_KEY);
  if (v === null || v === undefined) {
    return true; // default ON
  }
  return !(v === '0' || v === 'false');
}

async function setLargeModeManual(enabled) {
  await storage.redis.setAsync(LARGE_MODE_KEY, enabled ? '1' : '0');
  invalidateCapacityCache();
}

async function getUsedBytes() {
  const ids = await storage.redis.zrangeAsync(keys().zset, 0, -1);
  const sizes = await Promise.all(
    ids.map(id => storage.redis.hgetAsync(hashKey(id), 'size'))
  );
  return sizes.reduce((sum, s) => sum + (Number(s) || 0), 0);
}

async function computeCapacity() {
  const l = limits();
  const [manual, usedBytes] = await Promise.all([
    getLargeModeManual(),
    getUsedBytes()
  ]);
  const remainingBytes = Math.max(l.quotaBytes - usedBytes, 0);
  return {
    largeModeEnabled: manual && remainingBytes >= l.largeMaxFileSize,
    largeModeManual: manual,
    normalMaxFileSize: l.normalMaxFileSize,
    largeMaxFileSize: l.largeMaxFileSize,
    largeExpireSeconds: l.largeExpireSeconds,
    quotaBytes: l.quotaBytes,
    usedBytes,
    remainingBytes,
    uploadsAccepted: remainingBytes > 0
  };
}

// Cached for CAPACITY_CACHE_MS; returns a copy so callers may mutate it.
async function getCapacity() {
  const now = Date.now();
  if (capacityCache && now - capacityCache.at < CAPACITY_CACHE_MS) {
    return Object.assign({}, capacityCache.value);
  }
  const generation = cacheGeneration;
  const value = await computeCapacity();
  // do not cache a value computed before an invalidation
  if (generation === cacheGeneration) {
    capacityCache = { at: now, value };
  }
  return Object.assign({}, value);
}

/**
 * Reserves capacity for an upload that is about to start.
 * encryptedBytes: upper bound of the stored size.
 * Resolves {ok: true} or {ok: false, reason: 'large_disabled' | 'quota'}.
 */
function reserve(id, { encryptedBytes, large, expireSeconds }) {
  return withLock(async () => {
    // exact value, never the cached one
    const cap = await computeCapacity();
    if (large && !cap.largeModeEnabled) {
      return { ok: false, reason: 'large_disabled' };
    }
    if (cap.usedBytes + encryptedBytes > cap.quotaBytes) {
      return { ok: false, reason: 'quota' };
    }
    const now = Date.now();
    try {
      await storage.track(
        id,
        {
          size: encryptedBytes,
          prefix: Math.max(Math.floor(expireSeconds / 86400), 1),
          createdAt: now,
          large,
          reserved: true
        },
        now + expireSeconds * 1000 + RESERVE_MARGIN_MS
      );
    } finally {
      invalidateCapacityCache();
    }
    return { ok: true };
  });
}

// Finalises a reservation with the number of bytes actually received.
async function commit(id, actualBytes, expireSeconds) {
  const h = await storage.redis.hgetallAsync(hashKey(id));
  const now = Date.now();
  try {
    await storage.track(
      id,
      {
        size: actualBytes,
        prefix: h ? h.prefix : Math.max(Math.floor(expireSeconds / 86400), 1),
        createdAt: h ? Number(h.createdAt) : now,
        large: h ? h.large === '1' : false,
        reserved: false
      },
      now + expireSeconds * 1000
    );
  } finally {
    invalidateCapacityCache();
  }
}

// Drops a reservation (failed upload). The stored object, if any, is not touched.
async function release(id) {
  try {
    await storage.untrack(id);
  } finally {
    invalidateCapacityCache();
  }
}

function isNotFound(e) {
  return !!e && (e.code === 'ENOENT' || e.code === 'NoSuchKey');
}

// Removes stored object + redis metadata + tracking entry.
async function purge(id, prefix) {
  try {
    await purgeInner(id, prefix);
  } finally {
    invalidateCapacityCache();
  }
}

async function purgeInner(id, prefix) {
  if (prefix === undefined || prefix === null || prefix === '') {
    const h = await storage.redis.hgetAsync(hashKey(id), 'prefix');
    prefix = h || (await storage.redis.hgetAsync(id, 'prefix'));
  }
  if (prefix) {
    try {
      await storage.storage.del(`${prefix}-${id}`);
    } catch (e) {
      if (!isNotFound(e)) {
        throw e;
      }
    }
  }
  await storage.redis.delAsync(id);
  await storage.untrack(id);
}

async function deleteFile(id) {
  await purge(id);
}

async function listFiles() {
  const rows = await storage.redis.zrangeAsync(
    keys().zset,
    0,
    -1,
    'WITHSCORES'
  );
  const files = [];
  for (let i = 0; i < rows.length; i += 2) {
    const id = rows[i];
    const expiresAt = Number(rows[i + 1]);
    const [h, m, exists] = await Promise.all([
      storage.redis.hgetallAsync(hashKey(id)),
      storage.redis.hgetallAsync(id),
      storage.redis.existsAsync(id)
    ]);
    const t = h || {};
    const meta = m || {};
    files.push({
      id,
      size: Number(t.size) || 0,
      prefix: t.prefix ? Number(t.prefix) : undefined,
      createdAt: Number(t.createdAt) || 0,
      expiresAt,
      large: t.large === '1',
      dl: Number(meta.dl) || 0,
      dlimit: Number(meta.dlimit) || 1,
      alive: !!exists
    });
  }
  return files;
}

async function getS3Usage() {
  if (typeof storage.storage.list !== 'function') {
    return { objects: 0, bytes: 0 };
  }
  const items = await storage.storage.list();
  return {
    objects: items.length,
    bytes: items.reduce((sum, o) => sum + o.size, 0)
  };
}

module.exports = {
  getCapacity,
  listFiles,
  deleteFile,
  setLargeModeManual,
  getS3Usage,
  // used by routes and sweeper
  reserve,
  commit,
  release,
  purge
};
