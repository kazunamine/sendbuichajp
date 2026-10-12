const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../../server/admin/session');
const auth = require('../../server/admin/auth');
const { createStore } = require('../../server/admin/store');

const SECRET = 'x'.repeat(48);

describe('admin session', function() {
  const now = 1700000000000;
  const payload = { p: 'session', sid: 'abc', v: 1, exp: now + 1000 };

  it('verifies a signed token', function() {
    const token = session.sign(SECRET, payload);
    assert.deepStrictEqual(
      session.verify(SECRET, token, 'session', now),
      payload
    );
  });

  it('rejects a tampered payload', function() {
    const token = session.sign(SECRET, payload);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(Object.assign({}, payload, { exp: now + 99999999 }))
    ).toString('base64url');
    assert.strictEqual(
      session.verify(SECRET, `${forged}.${sig}`, 'session', now),
      null
    );
  });

  it('rejects a wrong secret, wrong purpose, expiry and junk', function() {
    const token = session.sign(SECRET, payload);
    assert.strictEqual(
      session.verify('y'.repeat(48), token, 'session', now),
      null
    );
    assert.strictEqual(session.verify(SECRET, token, 'pre2fa', now), null);
    assert.strictEqual(
      session.verify(SECRET, token, 'session', now + 1000),
      null
    );
    assert.strictEqual(session.verify(SECRET, 'a.b.c', 'session', now), null);
    assert.strictEqual(session.verify(SECRET, 'abc', 'session', now), null);
    assert.strictEqual(session.verify(SECRET, undefined, 'session', now), null);
    assert.strictEqual(session.verify(SECRET, 'x.y', 'session', now), null);
  });

  it('parses cookies', function() {
    assert.deepStrictEqual(session.parseCookies('a=1; b=hello%20w; c'), {
      a: '1',
      b: 'hello w'
    });
  });

  it('sets HttpOnly/Secure/SameSite=Strict cookies for 12 hours', function() {
    const headers = [];
    const res = { append: (k, v) => headers.push([k, v]) };
    session.issueSession(SECRET, res, 1, now);
    const set = headers.find(h =>
      h[1].startsWith(session.COOKIE_NAME + '=')
    )[1];
    assert(set.includes('HttpOnly'));
    assert(set.includes('Secure'));
    assert(set.includes('SameSite=Strict'));
    assert(set.includes('Max-Age=43200'));
  });
});

describe('admin auth', function() {
  it('hashes and verifies passwords', async function() {
    const rec = await auth.hashPassword('correct horse battery');
    assert.strictEqual(rec.algo, 'scrypt');
    assert(await auth.verifyPassword('correct horse battery', rec));
    assert(!(await auth.verifyPassword('wrong', rec)));
    const rec2 = await auth.hashPassword('correct horse battery');
    assert.notStrictEqual(rec.salt, rec2.salt);
  });

  it('rate limits failures per key', function() {
    const rl = auth.createRateLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      assert(!rl.isBlocked('a', 0));
      rl.fail('a', 0);
    }
    assert(rl.isBlocked('a', 10));
    assert(!rl.isBlocked('b', 10));
    assert(!rl.isBlocked('a', 1001));
    rl.fail('b', 0);
    rl.success('b');
    assert(!rl.isBlocked('b', 0));
  });
});

describe('admin store', function() {
  it('writes admin.json atomically with mode 600', async function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-store-'));
    const store = createStore(path.join(dir, 'data'));
    assert.strictEqual(await store.read(), null);
    await store.update(() => ({ n: 1 }));
    await Promise.all([
      store.update(cur => ({ n: cur.n + 1 })),
      store.update(cur => ({ n: cur.n + 1 }))
    ]);
    assert.deepStrictEqual(await store.read(), { n: 3 });
    assert.strictEqual(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'data')), [
      'admin.json'
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
