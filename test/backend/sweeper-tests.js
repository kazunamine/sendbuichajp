const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const config = {
  large_file_threshold: 10 * 1024 * 1024 * 1024,
  sweep_interval_seconds: 600,
  sweep_orphan_min_age_seconds: 691200,
  sweep_orphan_max_per_run: 50,
  sweep_orphan_dry_run: false,
  reconcile_interval_seconds: 21600,
  large_expire_seconds: 86400,
  max_expire_seconds: 7 * 86400
};

function makeEnv({ live = [], tracked = {}, objects, cfg = {} } = {}) {
  // tracked: id -> {expiresAt, prefix, reserved}
  const zset = new Map();
  const hashes = new Map();
  Object.keys(tracked).forEach(id => {
    zset.set(id, tracked[id].expiresAt);
    hashes.set(id, {
      prefix: String(tracked[id].prefix || 1),
      reserved: tracked[id].reserved ? '1' : '0',
      createdAt: String(tracked[id].createdAt || Date.now()),
      large: tracked[id].large ? '1' : '0'
    });
  });
  const liveSet = new Set(live);
  const deleted = [];
  const purged = [];
  const released = [];
  const redis = {
    zrangebyscoreAsync: async (k, min, max) =>
      [...zset.entries()].filter(e => e[1] <= max).map(e => e[0]),
    zrangeAsync: async () => [...zset.keys()],
    hgetAsync: async (id, f) => (hashes.has(id) ? hashes.get(id)[f] : null),
    existsAsync: async id => (liveSet.has(id) ? 1 : 0),
    zscoreAsync: async (k, id) => (zset.has(id) ? String(zset.get(id)) : null),
    pttlAsync: async id => (liveSet.has(id) ? 5000 : -2)
  };
  const storage = {
    redis,
    trackKeys: { zset: 'buicha:files', hashPrefix: '' },
    track: sinon.spy(async (id, entry, exp) => {
      zset.set(id, exp);
    }),
    storage: {
      del: sinon.spy(async key => deleted.push(key))
    }
  };
  if (objects) {
    storage.storage.list = async () => objects;
  }
  const usage = {
    purge: sinon.spy(async id => {
      purged.push(id);
      zset.delete(id);
    }),
    release: sinon.spy(async id => {
      released.push(id);
      zset.delete(id);
    })
  };
  const sweeper = proxyquire('../../server/sweeper', {
    './config': Object.assign({}, config, cfg),
    './storage': storage,
    './usage': usage,
    './log': () => ({ info() {}, warn() {}, error() {} }),
    '../app/utils': { encryptedSize: n => n }
  });
  return { sweeper, storage, usage, deleted, purged, released, zset };
}

const day = 86400 * 1000;

describe('sweeper', function() {
  it('purges expired tracked entries only', async function() {
    const t = makeEnv({
      tracked: {
        old: { expiresAt: Date.now() - 1000 },
        fresh: { expiresAt: Date.now() + day }
      },
      live: ['fresh']
    });
    const stats = await t.sweeper.runOnce();
    assert.deepEqual(t.purged, ['old']);
    assert.equal(stats.expired, 1);
  });

  it('purges committed entries whose redis key vanished', async function() {
    const t = makeEnv({
      tracked: {
        gone: { expiresAt: Date.now() + day },
        uploading: { expiresAt: Date.now() + day, reserved: true }
      }
    });
    const stats = await t.sweeper.runOnce();
    assert.deepEqual(t.purged, ['gone']);
    assert.equal(stats.dead, 1);
  });

  it('deletes old orphans but keeps young, tracked and live objects', async function() {
    const old = new Date(Date.now() - 10 * day);
    const young = new Date(Date.now() - 1 * day);
    const t = makeEnv({
      tracked: { aaaaaaaaaaaaaaaa: { expiresAt: Date.now() + day } },
      live: ['aaaaaaaaaaaaaaaa', 'cccccccccccccccc'],
      objects: [
        { key: '1-aaaaaaaaaaaaaaaa', size: 1, lastModified: old },
        { key: '1-bbbbbbbbbbbbbbbb', size: 1, lastModified: old },
        { key: '1-cccccccccccccccc', size: 1, lastModified: old },
        { key: '1-dddddddddddddddd', size: 1, lastModified: young },
        { key: 'unrelated.txt', size: 1, lastModified: old }
      ]
    });
    const stats = await t.sweeper.runOnce();
    assert.deepEqual(t.deleted, ['1-bbbbbbbbbbbbbbbb']);
    assert.equal(stats.orphans, 1);
  });

  it('works without a listing backend (fs storage)', async function() {
    const t = makeEnv({});
    const stats = await t.sweeper.runOnce();
    assert.equal(stats.errors, 0);
    assert.equal(stats.orphans, 0);
  });

  it('does not run concurrently', async function() {
    const t = makeEnv({});
    const [a, b] = await Promise.all([
      t.sweeper.runOnce(),
      t.sweeper.runOnce()
    ]);
    assert.ok(a.skipped || b.skipped);
  });

  it('reconcile tracks live untracked objects', async function() {
    const t = makeEnv({
      live: ['eeeeeeeeeeeeeeee'],
      objects: [
        {
          key: '7-eeeeeeeeeeeeeeee',
          size: 42,
          lastModified: new Date()
        },
        { key: '1-ffffffffffffffff', size: 5, lastModified: new Date() }
      ]
    });
    const r = await t.sweeper.reconcile();
    assert.equal(r.registered, 1);
    sinon.assert.calledOnce(t.storage.track);
    const [id, entry] = t.storage.track.firstCall.args;
    assert.equal(id, 'eeeeeeeeeeeeeeee');
    assert.equal(entry.size, 42);
    assert.equal(entry.prefix, '7');
  });

  describe('safety valves', function() {
    const old = new Date(Date.now() - 10 * day);
    function orphans(n) {
      const objects = [];
      for (let i = 0; i < n; i++) {
        const id = ('b' + i).padEnd(16, '0');
        objects.push({ key: `1-${id}`, size: 1, lastModified: old });
      }
      return objects;
    }

    it('deletes nothing when candidates exceed the per-run max', async function() {
      const t = makeEnv({
        objects: orphans(4),
        cfg: { sweep_orphan_max_per_run: 3 }
      });
      const stats = await t.sweeper.runOnce();
      assert.deepEqual(t.deleted, []);
      assert.equal(stats.orphans, 0);
      assert.equal(stats.orphanCandidates, 4);
    });

    it('deletes when candidates are exactly at the max', async function() {
      const t = makeEnv({
        objects: orphans(3),
        cfg: { sweep_orphan_max_per_run: 3 }
      });
      const stats = await t.sweeper.runOnce();
      assert.equal(t.deleted.length, 3);
      assert.equal(stats.orphans, 3);
    });

    it('dry run deletes nothing', async function() {
      const t = makeEnv({
        objects: orphans(2),
        cfg: { sweep_orphan_dry_run: true }
      });
      const stats = await t.sweeper.runOnce();
      assert.deepEqual(t.deleted, []);
      assert.equal(stats.orphanCandidates, 2);
    });

    it('does not delete orphans while reconcile has never succeeded', async function() {
      const t = makeEnv({ objects: orphans(2) });
      const list = sinon.stub();
      // first listing (reconcile) fails, later ones (orphan scan) work
      list.onFirstCall().rejects(new Error('s3 down'));
      list.callsFake(async () => orphans(2));
      t.storage.storage.list = list;
      const first = await t.sweeper.runOnce();
      assert.deepEqual(t.deleted, []);
      assert.ok(first.errors >= 1);
      // retried at the start of the next run; now succeeds and deletes
      const second = await t.sweeper.runOnce();
      assert.equal(list.callCount, 4);
      assert.equal(second.orphans, 2);
    });

    it('does not rerun reconcile before the interval, then reruns', async function() {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      try {
        const t = makeEnv({ objects: [] });
        const list = sinon.spy(t.storage.storage.list);
        t.storage.storage.list = list;
        await t.sweeper.runOnce(); // reconcile + orphan scan
        assert.equal(list.callCount, 2);
        await t.sweeper.runOnce(); // orphan scan only
        assert.equal(list.callCount, 3);
        clock.tick(21600 * 1000);
        await t.sweeper.runOnce(); // reconcile again + scan
        assert.equal(list.callCount, 5);
      } finally {
        clock.restore();
      }
    });

    it('untracks stale reservations without touching storage', async function() {
      const t = makeEnv({
        tracked: {
          stale: {
            expiresAt: Date.now() + day,
            reserved: true,
            createdAt: Date.now() - 8.5 * day
          },
          staleLarge: {
            expiresAt: Date.now() + day,
            reserved: true,
            large: true,
            createdAt: Date.now() - 2.5 * day
          },
          fresh: {
            expiresAt: Date.now() + day,
            reserved: true,
            createdAt: Date.now() - 1 * day
          },
          freshLarge: {
            expiresAt: Date.now() + day,
            reserved: true,
            large: true,
            createdAt: Date.now() - 1.5 * day
          }
        }
      });
      const stats = await t.sweeper.runOnce();
      assert.deepEqual(t.released.sort(), ['stale', 'staleLarge']);
      assert.equal(stats.stale, 2);
      assert.deepEqual(t.purged, []);
      assert.deepEqual(t.deleted, []);
    });
  });
});
