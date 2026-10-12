const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const GiB = 1024 * 1024 * 1024;

function fakeStorage() {
  const kv = new Map();
  const hashes = new Map();
  const zset = new Map();
  const redis = {
    getAsync: async k => (kv.has(k) ? kv.get(k) : null),
    setAsync: async (k, v) => kv.set(k, v),
    zrangeAsync: async (k, a, b, withScores) => {
      const sorted = [...zset.entries()].sort((x, y) => x[1] - y[1]);
      if (withScores) {
        return sorted.reduce(
          (acc, [id, sc]) => acc.concat([id, String(sc)]),
          []
        );
      }
      return sorted.map(e => e[0]);
    },
    hgetAsync: async (k, f) =>
      hashes.has(k) ? hashes.get(k)[f] || null : null,
    hgetallAsync: async k => (hashes.has(k) ? { ...hashes.get(k) } : null),
    existsAsync: async k => (hashes.has(k) && !k.startsWith('buicha:') ? 1 : 0),
    delAsync: sinon.spy(async k => hashes.delete(k))
  };
  const st = {
    redis,
    trackKeys: { zset: 'buicha:files', hashPrefix: 'buicha:file:' },
    track: async (id, entry, expiresAt) => {
      hashes.set(`buicha:file:${id}`, {
        size: String(entry.size),
        prefix: String(entry.prefix),
        createdAt: String(entry.createdAt),
        large: entry.large ? '1' : '0',
        reserved: entry.reserved ? '1' : '0'
      });
      zset.set(id, expiresAt);
    },
    untrack: async id => {
      zset.delete(id);
      hashes.delete(`buicha:file:${id}`);
    },
    storage: { del: sinon.stub().resolves() },
    _hashes: hashes,
    _zset: zset
  };
  return st;
}

function load(storage, overrides = {}) {
  const config = Object.assign(
    {
      large_file_threshold: 10 * GiB,
      max_file_size: 300 * GiB,
      large_expire_seconds: 86400,
      storage_quota_bytes: 2000 * GiB
    },
    overrides
  );
  return proxyquire('../../server/usage', {
    './config': config,
    './storage': storage
  });
}

describe('usage', function() {
  describe('getCapacity', function() {
    it('reports an empty store', async function() {
      const usage = load(fakeStorage());
      const c = await usage.getCapacity();
      assert.equal(c.usedBytes, 0);
      assert.equal(c.remainingBytes, 2000 * GiB);
      assert.equal(c.largeModeEnabled, true);
      assert.equal(c.largeModeManual, true);
      assert.equal(c.normalMaxFileSize, 10 * GiB);
      assert.equal(c.largeMaxFileSize, 300 * GiB);
      assert.equal(c.largeExpireSeconds, 86400);
      assert.equal(c.uploadsAccepted, true);
    });

    it('disables large mode when the manual toggle is off', async function() {
      const usage = load(fakeStorage());
      await usage.setLargeModeManual(false);
      const c = await usage.getCapacity();
      assert.equal(c.largeModeManual, false);
      assert.equal(c.largeModeEnabled, false);
      await usage.setLargeModeManual(true);
      assert.equal((await usage.getCapacity()).largeModeEnabled, true);
    });

    it('disables large mode when remaining < large max', async function() {
      const usage = load(fakeStorage(), { storage_quota_bytes: 400 * GiB });
      const r = await usage.reserve('a', {
        encryptedBytes: 150 * GiB,
        large: true,
        expireSeconds: 86400
      });
      assert.ok(r.ok);
      const c = await usage.getCapacity();
      assert.equal(c.usedBytes, 150 * GiB);
      assert.equal(c.largeModeManual, true);
      assert.equal(c.largeModeEnabled, false);
      assert.equal(c.uploadsAccepted, true);
    });

    it('stops accepting uploads when full', async function() {
      const usage = load(fakeStorage(), { storage_quota_bytes: 10 * GiB });
      await usage.reserve('a', {
        encryptedBytes: 10 * GiB,
        large: false,
        expireSeconds: 86400
      });
      const c = await usage.getCapacity();
      assert.equal(c.remainingBytes, 0);
      assert.equal(c.uploadsAccepted, false);
    });
  });

  describe('reserve / commit / release', function() {
    it('rejects over quota', async function() {
      const usage = load(fakeStorage(), { storage_quota_bytes: 10 * GiB });
      const ok = await usage.reserve('a', {
        encryptedBytes: 6 * GiB,
        large: false,
        expireSeconds: 86400
      });
      const ng = await usage.reserve('b', {
        encryptedBytes: 6 * GiB,
        large: false,
        expireSeconds: 86400
      });
      assert.ok(ok.ok);
      assert.deepEqual(ng, { ok: false, reason: 'quota' });
    });

    it('rejects large uploads when large mode is off', async function() {
      const usage = load(fakeStorage());
      await usage.setLargeModeManual(false);
      const r = await usage.reserve('a', {
        encryptedBytes: 11 * GiB,
        large: true,
        expireSeconds: 86400
      });
      assert.deepEqual(r, { ok: false, reason: 'large_disabled' });
    });

    it('does not overbook with concurrent reservations', async function() {
      const usage = load(fakeStorage(), { storage_quota_bytes: 10 * GiB });
      const opts = { encryptedBytes: 6 * GiB, large: false, expireSeconds: 60 };
      const results = await Promise.all([
        usage.reserve('a', opts),
        usage.reserve('b', opts)
      ]);
      assert.equal(results.filter(r => r.ok).length, 1);
    });

    it('commit stores the real size and release removes the entry', async function() {
      const st = fakeStorage();
      const usage = load(st);
      await usage.reserve('a', {
        encryptedBytes: 10 * GiB,
        large: false,
        expireSeconds: 3600
      });
      await usage.commit('a', 1234, 3600);
      assert.equal((await usage.getCapacity()).usedBytes, 1234);
      assert.equal(st._hashes.get('buicha:file:a').reserved, '0');
      await usage.release('a');
      assert.equal((await usage.getCapacity()).usedBytes, 0);
    });
  });

  describe('deleteFile', function() {
    it('removes object, redis key and tracking', async function() {
      const st = fakeStorage();
      const usage = load(st);
      await usage.reserve('abc', {
        encryptedBytes: 100,
        large: false,
        expireSeconds: 86400 * 7
      });
      await usage.deleteFile('abc');
      sinon.assert.calledWith(st.storage.del, '7-abc');
      sinon.assert.calledWith(st.redis.delAsync, 'abc');
      assert.equal(st._zset.size, 0);
    });

    it('ignores a missing object', async function() {
      const st = fakeStorage();
      st.storage.del = sinon
        .stub()
        .rejects(Object.assign(new Error(), { code: 'ENOENT' }));
      const usage = load(st);
      await usage.reserve('abc', {
        encryptedBytes: 100,
        large: false,
        expireSeconds: 86400
      });
      await usage.deleteFile('abc');
      assert.equal(st._zset.size, 0);
    });
  });

  describe('listFiles / getS3Usage', function() {
    it('lists tracked files', async function() {
      const usage = load(fakeStorage());
      await usage.reserve('abc', {
        encryptedBytes: 100,
        large: true,
        expireSeconds: 86400
      });
      const files = await usage.listFiles();
      assert.equal(files.length, 1);
      assert.equal(files[0].id, 'abc');
      assert.equal(files[0].size, 100);
      assert.equal(files[0].large, true);
      assert.equal(files[0].alive, false);
    });

    it('sums S3 objects', async function() {
      const st = fakeStorage();
      st.storage.list = async () => [{ size: 1 }, { size: 2 }];
      const usage = load(st);
      assert.deepEqual(await usage.getS3Usage(), { objects: 2, bytes: 3 });
    });

    it('returns zero without a listing backend', async function() {
      const usage = load(fakeStorage());
      assert.deepEqual(await usage.getS3Usage(), { objects: 0, bytes: 0 });
    });
  });

  describe('getCapacity cache', function() {
    const opts = { encryptedBytes: 100, large: false, expireSeconds: 3600 };
    let clock;
    beforeEach(function() {
      clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    });
    afterEach(function() {
      clock.restore();
    });

    it('serves from cache for 5 seconds, then recomputes', async function() {
      const st = fakeStorage();
      const usage = load(st);
      await usage.getCapacity();
      st._zset.set('x', 1); // changed behind usage's back
      st._hashes.set('buicha:file:x', { size: '500' });
      assert.equal((await usage.getCapacity()).usedBytes, 0);
      clock.tick(5001);
      assert.equal((await usage.getCapacity()).usedBytes, 500);
    });

    it('returns copies so callers can mutate them', async function() {
      const usage = load(fakeStorage());
      const a = await usage.getCapacity();
      delete a.largeModeManual;
      assert.equal((await usage.getCapacity()).largeModeManual, true);
    });

    it('is invalidated by reserve, commit, release, delete, setLargeModeManual', async function() {
      const usage = load(fakeStorage());
      await usage.getCapacity();
      await usage.reserve('a', opts);
      assert.equal((await usage.getCapacity()).usedBytes, 100);
      await usage.commit('a', 40, 3600);
      assert.equal((await usage.getCapacity()).usedBytes, 40);
      await usage.setLargeModeManual(false);
      assert.equal((await usage.getCapacity()).largeModeManual, false);
      await usage.release('a');
      assert.equal((await usage.getCapacity()).usedBytes, 0);
      await usage.reserve('b', opts);
      assert.equal((await usage.getCapacity()).usedBytes, 100);
      await usage.deleteFile('b');
      assert.equal((await usage.getCapacity()).usedBytes, 0);
    });

    it('reserve ignores a stale cache', async function() {
      const st = fakeStorage();
      const usage = load(st, { storage_quota_bytes: 1000 });
      await usage.getCapacity(); // caches usedBytes 0
      st._zset.set('x', 1); // 950 bytes appear without invalidation
      st._hashes.set('buicha:file:x', { size: '950' });
      const r = await usage.reserve('a', opts);
      assert.deepEqual(r, { ok: false, reason: 'quota' });
    });
  });
});
