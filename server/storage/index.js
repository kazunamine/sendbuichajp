const config = require('../config');
const Metadata = require('../metadata');
const mozlog = require('../log');
const createRedisClient = require('./redis');

// Usage tracking (see usage.js). These keys carry no TTL on purpose:
// sweeper.js removes them together with the stored object.
const TRACK_ZSET = 'buicha:files'; // member=id, score=expiresAt (ms)
const TRACK_HASH_PREFIX = 'buicha:file:'; // hash: size,prefix,createdAt,large,reserved

function getPrefix(seconds) {
  return Math.max(Math.floor(seconds / 86400), 1);
}

class DB {
  constructor(config) {
    let Storage = null;
    if (config.s3_bucket) {
      Storage = require('./s3');
    } else if (config.gcs_bucket) {
      Storage = require('./gcs');
    } else {
      Storage = require('./fs');
    }
    this.log = mozlog('send.storage');

    this.storage = new Storage(config, this.log);

    this.redis = createRedisClient(config);
    this.redis.on('error', err => {
      this.log.error('Redis:', err);
    });
  }

  async ttl(id) {
    const result = await this.redis.ttlAsync(id);
    return Math.ceil(result) * 1000;
  }

  async getPrefixedId(id) {
    const prefix = await this.redis.hgetAsync(id, 'prefix');
    return `${prefix}-${id}`;
  }

  async length(id) {
    const filePath = await this.getPrefixedId(id);
    return this.storage.length(filePath);
  }

  async get(id) {
    const filePath = await this.getPrefixedId(id);
    return this.storage.getStream(filePath);
  }

  get trackKeys() {
    return { zset: TRACK_ZSET, hashPrefix: TRACK_HASH_PREFIX };
  }

  // entry: {size, prefix, createdAt, large, reserved}; expiresAt in ms
  async track(id, entry, expiresAt) {
    await this.redis.hmsetAsync(`${TRACK_HASH_PREFIX}${id}`, {
      size: String(entry.size),
      prefix: String(entry.prefix),
      createdAt: String(entry.createdAt),
      large: entry.large ? '1' : '0',
      reserved: entry.reserved ? '1' : '0'
    });
    await this.redis.zaddAsync(TRACK_ZSET, expiresAt, id);
  }

  async untrack(id) {
    await this.redis.zremAsync(TRACK_ZSET, id);
    await this.redis.delAsync(`${TRACK_HASH_PREFIX}${id}`);
  }

  async set(id, file, meta, expireSeconds = config.default_expire_seconds) {
    const prefix = getPrefix(expireSeconds);
    const filePath = `${prefix}-${id}`;
    await this.storage.set(filePath, file);
    this.redis.hset(id, 'prefix', prefix);
    if (meta) {
      this.redis.hmset(id, meta);
    }
    this.redis.expire(id, expireSeconds);
  }

  setField(id, key, value) {
    this.redis.hset(id, key, value);
  }

  incrementField(id, key, increment = 1) {
    this.redis.hincrby(id, key, increment);
  }

  async del(id) {
    const filePath = await this.getPrefixedId(id);
    let delError = null;
    try {
      await this.storage.del(filePath);
    } catch (e) {
      delError = e;
    }
    this.redis.del(id);
    if (delError) {
      // keep the tracking entry: the sweeper removes the leftover object
      this.log && this.log.error('storage.del', delError);
      throw delError;
    }
    try {
      await this.untrack(id);
    } catch (e) {
      this.log && this.log.error('untrack', e);
    }
  }

  async ping() {
    await this.redis.pingAsync();
    await this.storage.ping();
  }

  async metadata(id) {
    const result = await this.redis.hgetallAsync(id);
    return result && new Metadata(result);
  }
}

module.exports = new DB(config);
