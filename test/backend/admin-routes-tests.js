const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../server/admin/index');
const { createStore } = require('../../server/admin/store');
const session = require('../../server/admin/session');
const auth = require('../../server/admin/auth');

const SECRET = 's'.repeat(48);
const ORIGIN = 'https://send-admin.example';
const PASSWORD = 'correct horse battery';

describe('admin routes (reauth / sessionVersion)', function() {
  let dir, server, port, store, regCalls;

  function request(urlPath, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: Object.assign(
            {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
              Origin: ORIGIN
            },
            extraHeaders
          )
        },
        res => {
          let text = '';
          res.on('data', c => (text += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, text })
          );
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  function cookie(version) {
    const token = session.sign(SECRET, {
      p: 'session',
      sid: 'sid1',
      v: version,
      exp: Date.now() + 60000
    });
    return `${session.COOKIE_NAME}=${encodeURIComponent(token)}`;
  }

  beforeEach(async function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-routes-'));
    store = createStore(dir);
    await store.write({
      version: 1,
      password: await auth.hashPassword(PASSWORD),
      totp: { secret: 'AAAA', lastStep: 0 },
      passkeys: [
        { id: 'pk1', name: 'one', publicKey: 'x', counter: 0 },
        { id: 'pk2', name: 'two', publicKey: 'y', counter: 0 }
      ],
      webauthnUserId: 'uid',
      sessionVersion: 5
    });
    regCalls = 0;
    const app = createApp(
      {
        enabled: true,
        allowedCidrs: ['127.0.0.1/32'],
        trustedProxies: [],
        origin: ORIGIN,
        rpID: 'send-admin.example',
        sessionSecret: SECRET,
        dataDir: dir
      },
      {
        store,
        usage: {},
        sweeper: {},
        webauthn: {
          registrationOptions: async () => {
            regCalls++;
            return { challengeId: 'c', options: {} };
          },
          verifyRegistration: async () => null
        }
      }
    );
    await new Promise(r => {
      server = app.listen(0, '127.0.0.1', r);
    });
    port = server.address().port;
  });

  afterEach(function() {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passkey options requires the current password', async function() {
    const c = { Cookie: cookie(5) };
    let r = await request('/security/passkey/options', {}, c);
    assert.strictEqual(r.status, 401);
    r = await request('/security/passkey/options', { current: 'wrong' }, c);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(regCalls, 0);
    r = await request('/security/passkey/options', { current: PASSWORD }, c);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(regCalls, 1);
  });

  it('passkey verify requires the current password', async function() {
    const c = { Cookie: cookie(5) };
    let r = await request('/security/passkey/verify', { name: 'n' }, c);
    assert.strictEqual(r.status, 401);
    r = await request(
      '/security/passkey/verify',
      { name: 'n', current: PASSWORD },
      c
    );
    // 再認証は通り、(モックの) 登録検証で失敗する
    assert.strictEqual(r.status, 400);
  });

  it('passkey delete requires the current password', async function() {
    const c = { Cookie: cookie(5) };
    const r = await request('/security/passkey/delete', { id: 'pk1' }, c);
    assert.strictEqual(r.status, 401);
    const admin = await store.read();
    assert.strictEqual(admin.passkeys.length, 2);
    assert.strictEqual(admin.sessionVersion, 5);
  });

  it('passkey delete bumps sessionVersion and revokes old sessions', async function() {
    const c = { Cookie: cookie(5) };
    const r = await request(
      '/security/passkey/delete',
      { id: 'pk1', current: PASSWORD },
      c
    );
    assert.strictEqual(r.status, 200);
    const admin = await store.read();
    assert.strictEqual(admin.sessionVersion, 6);
    assert.deepStrictEqual(
      admin.passkeys.map(p => p.id),
      ['pk2']
    );
    // 現在の端末には新しいセッションが発行される
    const set = [].concat(r.headers['set-cookie']).join('\n');
    assert(set.includes(session.COOKIE_NAME + '='));
    // 旧セッションは失効
    const old = await request(
      '/security/passkey/options',
      { current: PASSWORD },
      c
    );
    assert.strictEqual(old.status, 401);
  });

  it('deleting the last passkey keeps password+TOTP login possible', async function() {
    const c = { Cookie: cookie(5) };
    await request(
      '/security/passkey/delete',
      { id: 'pk1', current: PASSWORD },
      c
    );
    await request(
      '/security/passkey/delete',
      { id: 'pk2', current: PASSWORD },
      {
        Cookie: cookie(6)
      }
    );
    const admin = await store.read();
    assert.strictEqual(admin.passkeys.length, 0);
    assert(await auth.verifyPassword(PASSWORD, admin.password));
    assert(admin.totp.secret);
    // パスワードログイン (第1段階) は引き続き成功する
    const r = await request('/login', { password: PASSWORD });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/login/totp');
  });

  it('logout-all bumps sessionVersion and requires Origin', async function() {
    const c = { Cookie: cookie(5) };
    let r = await request(
      '/security/logout-all',
      {},
      Object.assign({ Origin: 'https://evil.example' }, c)
    );
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await store.read()).sessionVersion, 5);
    r = await request('/security/logout-all', {}, c);
    assert.strictEqual(r.status, 303);
    assert.strictEqual((await store.read()).sessionVersion, 6);
    r = await request('/security/passkey/options', { current: PASSWORD }, c);
    assert.strictEqual(r.status, 401);
  });
});
