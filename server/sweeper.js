const config = require('./config');
const storage = require('./storage');
const usage = require('./usage');
const mozlog = require('./log');
const { encryptedSize } = require('../app/utils');

const log = mozlog('send.sweeper');

const KEY_REGEX = /^(\d+)-([0-9a-fA-F]{10,16})$/;

let running = false;
let started = false;
let timer = null;
// reconcile state: orphan deletion is disabled until it succeeded once
let reconciled = false;
let lastReconcileAt = 0;

const DAY_MS = 86400 * 1000;

function hashKey(id) {
  return `${storage.trackKeys.hashPrefix}${id}`;
}

function canList() {
  return typeof storage.storage.list === 'function';
}

// Registers already stored objects whose redis key is alive but that are
// not tracked yet (e.g. uploaded before this feature existed).
async function reconcile() {
  if (!canList()) {
    return { registered: 0 };
  }
  const items = await storage.storage.list();
  const largeBoundary = encryptedSize(config.large_file_threshold);
  let registered = 0;
  for (const o of items) {
    const m = KEY_REGEX.exec(o.key);
    if (!m) continue;
    const [, prefix, id] = m;
    const tracked = await storage.redis.zscoreAsync(storage.trackKeys.zset, id);
    if (tracked !== null && tracked !== undefined) continue;
    const pttl = await storage.redis.pttlAsync(id);
    if (!(pttl > 0)) continue;
    const created = o.lastModified ? new Date(o.lastModified).getTime() : 0;
    await storage.track(
      id,
      {
        size: o.size,
        prefix,
        createdAt: created || Date.now(),
        large: o.size > largeBoundary,
        reserved: false
      },
      Date.now() + pttl
    );
    registered++;
  }
  return { registered };
}

// Retries until the first success, then repeats every reconcile interval.
async function maybeReconcile(stats) {
  const due =
    !reconciled ||
    Date.now() - lastReconcileAt >= config.reconcile_interval_seconds * 1000;
  if (!due) {
    return;
  }
  try {
    await reconcile();
    reconciled = true;
    lastReconcileAt = Date.now();
  } catch (e) {
    stats.errors++;
    log.error('reconcile', e);
  }
}

// An uncommitted reservation this old is considered abandoned (e.g. the
// process restarted mid-upload).
async function isStaleReservation(id, now) {
  const [createdAt, large] = await Promise.all([
    storage.redis.hgetAsync(hashKey(id), 'createdAt'),
    storage.redis.hgetAsync(hashKey(id), 'large')
  ]);
  const created = Number(createdAt);
  if (!(created > 0)) {
    return false;
  }
  const maxSeconds =
    large === '1' ? config.large_expire_seconds : config.max_expire_seconds;
  return now - created >= maxSeconds * 1000 + DAY_MS;
}

async function runOnce() {
  if (running) {
    return { skipped: true };
  }
  running = true;
  const stats = { expired: 0, dead: 0, stale: 0, orphans: 0, errors: 0 };
  try {
    await maybeReconcile(stats);
    const now = Date.now();
    const { zset } = storage.trackKeys;

    // (1) expired entries
    const expired = await storage.redis.zrangebyscoreAsync(zset, '-inf', now);
    for (const id of expired) {
      try {
        await usage.purge(id);
        stats.expired++;
      } catch (e) {
        stats.errors++;
        log.error('purge expired', e);
      }
    }

    // (1b) tracked, committed entries whose redis key vanished
    // (deleted elsewhere): remove the leftover object.
    const ids = await storage.redis.zrangeAsync(zset, 0, -1);
    for (const id of ids) {
      try {
        const reserved = await storage.redis.hgetAsync(hashKey(id), 'reserved');
        if (reserved === '1') {
          // untrack only; a stored object, if any, is handled as an orphan
          if (await isStaleReservation(id, now)) {
            await usage.release(id);
            stats.stale++;
          }
          continue;
        }
        const exists = await storage.redis.existsAsync(id);
        if (!exists) {
          await usage.purge(id);
          stats.dead++;
        }
      } catch (e) {
        stats.errors++;
        log.error('purge dead', e);
      }
    }

    // (2) orphans: stored objects with neither a live redis key nor tracking
    if (canList()) {
      const minAgeMs = config.sweep_orphan_min_age_seconds * 1000;
      const items = await storage.storage.list();
      const trackedIds = new Set(await storage.redis.zrangeAsync(zset, 0, -1));
      const candidates = [];
      for (const o of items) {
        const m = KEY_REGEX.exec(o.key);
        if (!m) continue;
        const id = m[2];
        if (trackedIds.has(id)) continue;
        const last = o.lastModified ? new Date(o.lastModified).getTime() : NaN;
        if (!(Date.now() - last > minAgeMs)) continue;
        try {
          if (await storage.redis.existsAsync(id)) continue;
          candidates.push(o.key);
        } catch (e) {
          stats.errors++;
          log.error('check orphan', e);
        }
      }
      stats.orphanCandidates = candidates.length;
      if (candidates.length > 0) {
        if (!reconciled) {
          log.warn(
            'orphan deletion skipped: reconcile has not succeeded yet',
            candidates.length
          );
        } else if (candidates.length > config.sweep_orphan_max_per_run) {
          log.warn(
            'orphan deletion aborted: too many candidates (redis loss?)',
            candidates.length
          );
        } else if (config.sweep_orphan_dry_run) {
          log.info('orphan dry run, would delete', candidates);
        } else {
          for (const key of candidates) {
            try {
              await storage.storage.del(key);
              stats.orphans++;
            } catch (e) {
              stats.errors++;
              log.error('purge orphan', e);
            }
          }
        }
      }
    }
  } catch (e) {
    stats.errors++;
    log.error('sweep', e);
  } finally {
    running = false;
  }
  log.info('sweep', stats);
  return stats;
}

async function start() {
  if (started) {
    return;
  }
  started = true;
  await runOnce(); // reconciles first (retried on later runs until it works)
  timer = setInterval(runOnce, config.sweep_interval_seconds * 1000);
  if (timer.unref) {
    timer.unref();
  }
}

module.exports = { start, runOnce, reconcile };
