const assert = require('assert');
const sinon = require('sinon');
const EventEmitter = require('events');
const { PassThrough } = require('stream');
const proxyquire = require('proxyquire').noCallThru();

function makeEnv(cfg = {}, usageOverrides = {}) {
  const config = Object.assign(
    {
      large_file_threshold: 100,
      max_file_size: 10000,
      default_expire_seconds: 3600,
      large_expire_seconds: 86400,
      max_expire_seconds: 7 * 86400,
      default_downloads: 1,
      max_downloads: 10,
      fxa_required: false,
      upload_idle_timeout_seconds: 60,
      upload_min_bytes_per_window: 1000,
      max_concurrent_large_uploads: 2,
      deriveBaseUrl: () => 'http://x'
    },
    cfg
  );
  const usage = Object.assign(
    {
      reserve: sinon.spy(async () => ({ ok: true })),
      commit: sinon.spy(async () => {}),
      release: sinon.spy(async () => {})
    },
    usageOverrides
  );
  const storage = {
    // consumes the stream; settles on end or error/close
    set: sinon.spy(
      (id, stream) =>
        new Promise((resolve, reject) => {
          stream.on('error', reject);
          stream.on('close', resolve);
          stream.resume();
        })
    )
  };
  const handler = proxyquire('../../server/routes/ws', {
    '../storage': storage,
    '../config': config,
    '../log': () => ({ info() {}, warn() {}, error() {} }),
    '../limiter': require('../../server/limiter'),
    '../fxa': { verify: async () => null },
    '../usage': usage,
    '../../app/utils': { encryptedSize: n => n }
  });
  return { handler, usage, storage };
}

function makeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.stream = new PassThrough();
  ws.send = m => ws.sent.push(JSON.parse(m));
  ws.close = sinon.spy(() => {
    ws.readyState = 3;
    ws.emit('close', 1000);
  });
  ws.terminate = sinon.spy(() => {
    ws.readyState = 3;
    ws.emit('close', 1006);
  });
  ws.constructor = { createWebSocketStream: w => w.stream };
  return ws;
}

function first(fileSize) {
  return JSON.stringify({
    fileSize,
    fileMetadata: 'm',
    authorization: 'send-v1 abc'
  });
}

const tick = () => new Promise(r => setImmediate(r));

describe('ws upload protections', function() {
  let clock;
  beforeEach(function() {
    clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(function() {
    clock.restore();
  });

  it('releases the reservation when no data arrives within the window', async function() {
    const t = makeEnv();
    const ws = makeWs();
    t.handler(ws, {});
    ws.emit('message', first(50));
    await tick();
    assert.equal(t.usage.reserve.callCount, 1);
    clock.tick(60 * 1000);
    await tick();
    sinon.assert.calledOnce(t.usage.release);
    sinon.assert.calledOnce(ws.terminate);
    sinon.assert.notCalled(t.usage.commit);
    assert.equal(clock.countTimers(), 0);
  });

  it('keeps uploads that make enough progress and clears the timer on completion', async function() {
    const t = makeEnv();
    const ws = makeWs();
    t.handler(ws, {});
    ws.emit('message', first(5000));
    await tick();
    ws.emit('message', Buffer.alloc(2000));
    clock.tick(60 * 1000);
    await tick();
    sinon.assert.notCalled(t.usage.release);
    ws.stream.end();
    await tick();
    await tick();
    sinon.assert.calledOnce(t.usage.commit);
    assert.equal(clock.countTimers(), 0);
  });

  it('times out when progress per window is below the minimum', async function() {
    const t = makeEnv();
    const ws = makeWs();
    t.handler(ws, {});
    ws.emit('message', first(5000));
    await tick();
    ws.emit('message', Buffer.alloc(999));
    clock.tick(60 * 1000);
    await tick();
    sinon.assert.calledOnce(t.usage.release);
  });

  it('rejects large uploads beyond the concurrency limit and frees slots on every path', async function() {
    const t = makeEnv({ max_concurrent_large_uploads: 2 });
    const open = [];
    for (let i = 0; i < 2; i++) {
      const ws = makeWs();
      t.handler(ws, {});
      ws.emit('message', first(500)); // > threshold 100 => large
      open.push(ws);
    }
    await tick();
    const third = makeWs();
    t.handler(third, {});
    third.emit('message', first(500));
    await tick();
    assert.deepEqual(third.sent, [{ error: 507 }]);
    assert.equal(t.usage.reserve.callCount, 2);
    // normal uploads are not limited
    const normal = makeWs();
    t.handler(normal, {});
    normal.emit('message', first(50));
    await tick();
    assert.equal(normal.sent[0].id !== undefined, true);
    // disconnect frees a slot
    open[0].emit('close', 1006);
    const fourth = makeWs();
    t.handler(fourth, {});
    fourth.emit('message', first(500));
    await tick();
    assert.ok(fourth.sent[0].url);
    // idle timeout frees slots too
    clock.tick(60 * 1000);
    await tick();
    const fifth = makeWs();
    t.handler(fifth, {});
    fifth.emit('message', first(500));
    await tick();
    assert.ok(fifth.sent[0].url);
    clock.tick(60 * 1000);
    await tick();
  });

  it('frees the slot when reserve throws or is refused', async function() {
    let mode = 'throw';
    const t = makeEnv(
      { max_concurrent_large_uploads: 1 },
      {
        reserve: async () => {
          if (mode === 'throw') throw new Error('redis');
          if (mode === 'refuse') return { ok: false, reason: 'quota' };
          return { ok: true };
        }
      }
    );
    for (const m of ['throw', 'refuse', 'ok']) {
      mode = m;
      const ws = makeWs();
      t.handler(ws, {});
      ws.emit('message', first(500));
      await tick();
      if (m === 'ok') {
        assert.ok(ws.sent[0].url);
      } else {
        assert.notEqual(ws.sent[0].error, undefined);
      }
    }
  });
});
