const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { createApp, start } = require('../../server/admin/index');
const adminConfig = require('../../server/admin/config');
const cfaccess = require('../../server/admin/cfaccess');
const { createStore } = require('../../server/admin/store');
const auth = require('../../server/admin/auth');

const TEAM = 'buicha.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'aud-tag-1';
const EMAIL = 'Me@Example.com';
const ORIGIN = 'https://send-admin.example';
const SECRET = 's'.repeat(40);
const NOW_MS = 1700000000000;
const NOW = Math.floor(NOW_MS / 1000);

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function newKey(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), {
    kid,
    alg: 'RS256',
    use: 'sig'
  });
  return { kid, privateKey, jwk };
}

function claims(over) {
  return Object.assign(
    {
      iss: ISS,
      aud: [AUD],
      email: 'me@example.com',
      exp: NOW + 600,
      iat: NOW - 10,
      nbf: NOW - 10
    },
    over
  );
}

function sign(key, payload, headerOver) {
  const header = Object.assign(
    { alg: 'RS256', kid: key.kid, typ: 'JWT' },
    headerOver
  );
  const input = `${b64url(JSON.stringify(header))}.${b64url(
    JSON.stringify(payload)
  )}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key.privateKey);
  return `${input}.${b64url(sig)}`;
}

describe('admin cloudflare-access mode', function() {
  let dir;
  let server;
  let port;
  let keyA;
  let jwks;
  let fetchJwks;
  let nowMs;

  function request(headers, urlPath = '/login') {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
        res => {
          let body = '';
          res.on('data', c => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body, headers: res.headers })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function boot(over = {}, cfDeps = {}) {
    const app = createApp(
      Object.assign(
        {
          enabled: true,
          mode: 'cloudflare-access',
          allowedCidrs: [],
          trustedProxies: ['127.0.0.1/32'],
          cfTeamDomain: TEAM,
          cfAud: [AUD, 'other-aud'],
          cfEmails: ['me@example.com'],
          origin: ORIGIN,
          rpID: 'send-admin.example',
          sessionSecret: SECRET,
          dataDir: dir
        },
        over
      ),
      {
        store: createStore(dir),
        usage: {},
        sweeper: {},
        webauthn: {},
        cfAccess: Object.assign({ fetchJwks, now: () => nowMs }, cfDeps)
      }
    );
    await new Promise(r => {
      server = app.listen(0, '127.0.0.1', r);
    });
    port = server.address().port;
  }

  beforeEach(async function() {
    sinon.stub(console, 'warn');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-cf-'));
    await createStore(dir).write({
      version: 1,
      password: await auth.hashPassword('correct horse battery'),
      totp: { secret: 'AAAA', lastStep: 0 },
      passkeys: [],
      webauthnUserId: 'uid',
      sessionVersion: 1
    });
    keyA = newKey('kid-a');
    jwks = { keys: [keyA.jwk] };
    nowMs = NOW_MS;
    fetchJwks = sinon.spy(async () => jwks);
  });

  afterEach(function() {
    console.warn.restore();
    if (server) {
      server.close();
      server = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hdr = t => ({ 'Cf-Access-Jwt-Assertion': t });

  it('accepts a valid JWT and shows the escaped email + Access logout', async function() {
    await boot();
    const r = await request(hdr(sign(keyA, claims())));
    assert.strictEqual(r.status, 200);
    assert(r.body.includes('Cloudflare: me@example.com'));
    assert(r.body.includes('href="/cdn-cgi/access/logout"'));
    assert(
      fetchJwks.calledOnceWithExactly(`https://${TEAM}/cdn-cgi/access/certs`)
    );
  });

  it('escapes the email in the header', async function() {
    const evil = '<img src=x onerror=1>@example.com';
    await boot({ cfEmails: [evil] });
    const r = await request(hdr(sign(keyA, claims({ email: evil }))));
    assert.strictEqual(r.status, 200);
    assert(!r.body.includes('<img src=x'));
    assert(r.body.includes('&lt;img src=x'));
  });

  it('still requires app authentication after Access', async function() {
    await boot();
    const r = await request(hdr(sign(keyA, claims())), '/');
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/login');
  });

  it('accepts aud as a plain string and email case-insensitively', async function() {
    await boot();
    const t = sign(keyA, claims({ aud: 'other-aud', email: EMAIL }));
    assert.strictEqual((await request(hdr(t))).status, 200);
  });

  it('rejects a request without the header', async function() {
    await boot();
    assert.strictEqual((await request({})).status, 403);
  });

  it('does not trust the CF_Authorization cookie', async function() {
    await boot();
    const r = await request({
      Cookie: `CF_Authorization=${sign(keyA, claims())}`
    });
    assert.strictEqual(r.status, 403);
    assert(fetchJwks.notCalled);
  });

  it('rejects a valid JWT from a non-trusted peer', async function() {
    await boot({ trustedProxies: ['192.168.1.100/32'] });
    const r = await request(hdr(sign(keyA, claims())));
    assert.strictEqual(r.status, 403);
    assert(fetchJwks.notCalled);
  });

  it('does not use allowedCidrs for the decision', async function() {
    await boot({ allowedCidrs: [] });
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 200);
    await new Promise(r => server.close(r));
    await boot({ allowedCidrs: ['0.0.0.0/0'], trustedProxies: ['10.9.9.9'] });
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 403);
  });

  it('rejects alg=none', async function() {
    await boot();
    const input = `${b64url(
      JSON.stringify({ alg: 'none', kid: 'kid-a' })
    )}.${b64url(JSON.stringify(claims()))}`;
    assert.strictEqual((await request(hdr(`${input}.`))).status, 403);
    assert.strictEqual((await request(hdr(input))).status, 403);
  });

  it('rejects HS256 (key confusion)', async function() {
    await boot();
    const input = `${b64url(
      JSON.stringify({ alg: 'HS256', kid: 'kid-a' })
    )}.${b64url(JSON.stringify(claims()))}`;
    const mac = crypto
      .createHmac('sha256', JSON.stringify(keyA.jwk))
      .update(input)
      .digest();
    assert.strictEqual(
      (await request(hdr(`${input}.${b64url(mac)}`))).status,
      403
    );
  });

  it('rejects a bad signature', async function() {
    await boot();
    const other = newKey('kid-a');
    assert.strictEqual((await request(hdr(sign(other, claims())))).status, 403);
  });

  it('rejects garbage tokens', async function() {
    await boot();
    for (const t of ['x', 'a.b.c', '...', 'a.b.c.d']) {
      assert.strictEqual((await request(hdr(t))).status, 403);
    }
  });

  it('rejects aud mismatch', async function() {
    await boot();
    for (const aud of ['nope', ['nope'], [], undefined, 5]) {
      const t = sign(keyA, claims({ aud }));
      assert.strictEqual((await request(hdr(t))).status, 403);
    }
  });

  it('rejects iss mismatch', async function() {
    await boot();
    const t = sign(keyA, claims({ iss: 'https://evil.cloudflareaccess.com' }));
    assert.strictEqual((await request(hdr(t))).status, 403);
  });

  it('rejects expired tokens and tokens without exp', async function() {
    await boot();
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ exp: NOW - 1 }))))).status,
      403
    );
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ exp: NOW }))))).status,
      403
    );
    const c = claims();
    delete c.exp;
    assert.strictEqual((await request(hdr(sign(keyA, c)))).status, 403);
  });

  it('tolerates nbf/iat up to 60 seconds in the future only', async function() {
    await boot();
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ nbf: NOW + 60, iat: NOW + 60 })))))
        .status,
      200
    );
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ nbf: NOW + 61 }))))).status,
      403
    );
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ iat: NOW + 61 }))))).status,
      403
    );
  });

  it('rejects emails that are not allowed or missing', async function() {
    await boot();
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ email: 'x@example.com' })))))
        .status,
      403
    );
    const c = claims();
    delete c.email;
    assert.strictEqual((await request(hdr(sign(keyA, c)))).status, 403);
  });

  it('refetches JWKS for an unknown kid (rotation) after the min interval', async function() {
    await boot();
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 200);
    const keyB = newKey('kid-b');
    jwks = { keys: [keyA.jwk, keyB.jwk] };
    // 30 秒未満は再取得しない
    nowMs += 29 * 1000;
    assert.strictEqual(
      (await request(hdr(sign(keyB, claims({ exp: NOW + 900 }))))).status,
      403
    );
    assert.strictEqual(fetchJwks.callCount, 1);
    nowMs += 2 * 1000;
    assert.strictEqual(
      (await request(hdr(sign(keyB, claims({ exp: NOW + 900 }))))).status,
      200
    );
    assert.strictEqual(fetchJwks.callCount, 2);
  });

  it('rejects when the kid is still unknown after refetch', async function() {
    await boot();
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 200);
    nowMs += 31 * 1000;
    const ghost = newKey('kid-ghost');
    assert.strictEqual(
      (await request(hdr(sign(ghost, claims({ exp: NOW + 900 }))))).status,
      403
    );
    assert.strictEqual(fetchJwks.callCount, 2);
    // 直後の連続リクエストは再取得しない
    assert.strictEqual(
      (await request(hdr(sign(ghost, claims({ exp: NOW + 900 }))))).status,
      403
    );
    assert.strictEqual(fetchJwks.callCount, 2);
  });

  it('caches JWKS for 10 minutes then refetches', async function() {
    await boot();
    const t = sign(keyA, claims({ exp: NOW + 3600 }));
    assert.strictEqual((await request(hdr(t))).status, 200);
    nowMs += 9 * 60 * 1000;
    assert.strictEqual((await request(hdr(t))).status, 200);
    assert.strictEqual(fetchJwks.callCount, 1);
    nowMs += 2 * 60 * 1000;
    assert.strictEqual((await request(hdr(t))).status, 200);
    assert.strictEqual(fetchJwks.callCount, 2);
  });

  it('fails closed when the JWKS fetch fails', async function() {
    fetchJwks = sinon.spy(async () => {
      throw new Error('network down');
    });
    await boot();
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 403);
  });

  it('fails closed when the JWKS is malformed or has no usable key', async function() {
    jwks = { nokeys: true };
    await boot();
    assert.strictEqual((await request(hdr(sign(keyA, claims())))).status, 403);
    nowMs += 31 * 1000;
    jwks = { keys: [{ kty: 'RSA', kid: 'kid-a', n: '!!', e: 'AQAB' }] };
    assert.strictEqual(
      (await request(hdr(sign(keyA, claims({ exp: NOW + 900 }))))).status,
      403
    );
  });

  it('recovers after a failed fetch once the interval has passed', async function() {
    let fail = true;
    fetchJwks = sinon.spy(async () => {
      if (fail) {
        throw new Error('down');
      }
      return jwks;
    });
    await boot();
    const t = sign(keyA, claims({ exp: NOW + 900 }));
    assert.strictEqual((await request(hdr(t))).status, 403);
    fail = false;
    assert.strictEqual((await request(hdr(t))).status, 403); // 30 秒以内
    nowMs += 31 * 1000;
    assert.strictEqual((await request(hdr(t))).status, 200);
  });

  describe('req.adminIp', function() {
    function run(headers, remote = '127.0.0.1') {
      const guard = cfaccess.createGuard(
        {
          trustedProxies: ['127.0.0.1/32'],
          cfTeamDomain: TEAM,
          cfAud: [AUD],
          cfEmails: ['me@example.com']
        },
        { fetchJwks, now: () => nowMs }
      );
      const req = { socket: { remoteAddress: remote }, headers };
      return new Promise(resolve => {
        const res = {
          status() {
            return this;
          },
          type() {
            return this;
          },
          send() {
            resolve({ req, next: false });
          }
        };
        guard(req, res, () => resolve({ req, next: true }));
      });
    }
    const jwt = () => sign(keyA, claims());

    it('uses Cf-Connecting-IP when valid', async function() {
      const r = await run({
        'cf-access-jwt-assertion': jwt(),
        'cf-connecting-ip': '203.0.113.7'
      });
      assert(r.next);
      assert.strictEqual(r.req.adminIp, '203.0.113.7');
      assert.strictEqual(r.req.accessEmail, 'me@example.com');
    });
    it('falls back to the remote address when invalid or absent', async function() {
      let r = await run({
        'cf-access-jwt-assertion': jwt(),
        'cf-connecting-ip': 'not-an-ip'
      });
      assert.strictEqual(r.req.adminIp, '127.0.0.1');
      r = await run({ 'cf-access-jwt-assertion': jwt() }, '::ffff:127.0.0.1');
      assert(r.next);
      assert.strictEqual(r.req.adminIp, '127.0.0.1');
    });
    it('ignores Cf-Connecting-IP from untrusted peers', async function() {
      const r = await run(
        {
          'cf-access-jwt-assertion': jwt(),
          'cf-connecting-ip': '203.0.113.7'
        },
        '192.168.1.50'
      );
      assert(!r.next);
      assert.notStrictEqual(r.req.adminIp, '203.0.113.7');
    });
  });

  describe('lan mode is unchanged', function() {
    it('allows LAN clients without any JWT', async function() {
      await boot({
        mode: 'lan',
        allowedCidrs: ['127.0.0.1/32'],
        trustedProxies: []
      });
      assert.strictEqual((await request({})).status, 200);
    });
    it('defaults to lan when mode is absent', async function() {
      await boot({ mode: undefined, allowedCidrs: ['127.0.0.1/32'] });
      assert.strictEqual(
        (await request({ 'X-Forwarded-For': '127.0.0.1' })).status,
        200
      );
    });
    it('shows no Cloudflare banner', async function() {
      await boot({
        mode: 'lan',
        allowedCidrs: ['127.0.0.1/32'],
        trustedProxies: []
      });
      assert(!(await request({})).body.includes('Cloudflare'));
    });
  });

  describe('config and startup', function() {
    const base = {
      ADMIN_SESSION_SECRET: 's'.repeat(40),
      ADMIN_MODE: 'cloudflare-access',
      ADMIN_CF_ACCESS_TEAM_DOMAIN: TEAM,
      ADMIN_CF_ACCESS_AUD: 'a1, a2',
      ADMIN_CF_ACCESS_EMAILS: 'Me@Example.com',
      ADMIN_TRUSTED_PROXIES: '192.168.1.100',
      ADMIN_DATA_DIR: ''
    };

    beforeEach(function() {
      sinon.stub(console, 'error');
      sinon.stub(console, 'log');
      base.ADMIN_DATA_DIR = dir;
    });
    afterEach(function() {
      console.error.restore();
      console.log.restore();
    });

    it('defaults to lan and normalizes the Access settings', function() {
      assert.strictEqual(adminConfig.load({}).mode, 'lan');
      for (const v of [
        TEAM,
        `https://${TEAM}`,
        `https://${TEAM}/`,
        ` ${TEAM.toUpperCase()} `
      ]) {
        const cfg = adminConfig.load(
          Object.assign({}, base, { ADMIN_CF_ACCESS_TEAM_DOMAIN: v })
        );
        assert.strictEqual(cfg.cfTeamDomain, TEAM);
      }
      const cfg = adminConfig.load(base);
      assert.deepStrictEqual(cfg.cfAud, ['a1', 'a2']);
      assert.deepStrictEqual(cfg.cfEmails, ['me@example.com']);
      assert.strictEqual(
        adminConfig.load({ ADMIN_CF_ACCESS_TEAM_DOMAIN: 'http://x/ y' })
          .cfTeamDomain,
        ''
      );
    });

    for (const key of [
      'ADMIN_CF_ACCESS_TEAM_DOMAIN',
      'ADMIN_CF_ACCESS_AUD',
      'ADMIN_CF_ACCESS_EMAILS',
      'ADMIN_TRUSTED_PROXIES'
    ]) {
      it(`refuses to start without ${key}`, function() {
        const env = Object.assign({}, base, { [key]: '' });
        assert.strictEqual(start(env), null);
        assert(console.error.calledOnce);
        assert(console.error.firstCall.args[0].includes(key));
      });
    }

    it('refuses to start with an unknown mode', function() {
      assert.strictEqual(
        start(Object.assign({}, base, { ADMIN_MODE: 'open' })),
        null
      );
    });

    it('createApp throws when the Access settings are incomplete', function() {
      const cfg = adminConfig.load(base);
      cfg.cfAud = [];
      assert.throws(() => createApp(cfg, { store: {} }), /cloudflare-access/);
    });
  });
});
