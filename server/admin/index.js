const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const adminConfig = require('./config');
const ipguard = require('./ipguard');
const session = require('./session');
const totp = require('./totp');
const auth = require('./auth');
const views = require('./views');
const { createStore } = require('./store');

const SETUP_TTL_MS = 15 * 60 * 1000;
const TOTP_ENROLL_TTL_MS = 10 * 60 * 1000;
const MAX_PASSKEYS = 20;

async function qrDataUrl(text) {
  const QRCode = require('qrcode');
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M'
  });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function createApp(cfg, deps = {}) {
  const store = deps.store || createStore(cfg.dataDir);
  const usage = deps.usage || require('../usage');
  const sweeper = deps.sweeper || require('../sweeper');
  const webauthn = deps.webauthn || require('./webauthn').createWebAuthn(cfg);
  const limiter = deps.limiter || auth.createRateLimiter(10, 15 * 60 * 1000);

  const pendingSetups = new Map(); // id -> { hash, secret, exp }
  const pendingTotp = new Map(); // sid -> { secret, exp }

  function sweepPending(map) {
    const now = Date.now();
    for (const [k, v] of map) {
      if (v.exp <= now) {
        map.delete(k);
      }
    }
  }

  const app = express();
  app.disable('x-powered-by');

  // 1. IP 制限（静的ファイルを含む全リクエスト）
  app.use(ipguard.createGuard(cfg));

  // 2. セキュリティヘッダ
  app.use(helmet());
  app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: false }));
  app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));
  app.use(
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"]
      }
    })
  );
  app.use(function(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  // 3. CSRF 対策: POST は Origin が ADMIN_ORIGIN と一致すること
  app.use(function(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.method !== 'POST' || req.headers.origin !== cfg.origin) {
        res
          .status(403)
          .type('text/plain')
          .send('Forbidden');
        return;
      }
    }
    next();
  });

  // 4. 静的ファイル
  app.use(
    '/static',
    express.static(path.join(__dirname, 'static'), { index: false })
  );
  app.get('/static/simplewebauthn-browser.js', function(req, res, next) {
    let dir;
    try {
      dir = path.dirname(
        require.resolve('@simplewebauthn/browser/package.json')
      );
    } catch (e) {
      return next(e);
    }
    res.type('application/javascript');
    res.sendFile('index.umd.min.js', {
      root: path.join(dir, 'dist', 'bundle')
    });
  });

  app.use(bodyParser.urlencoded({ extended: false, limit: '16kb' }));
  app.use(bodyParser.json({ limit: '64kb' }));

  const wrap = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  function strField(req, name) {
    const v = req.body && req.body[name];
    return typeof v === 'string' ? v : '';
  }

  function tooMany(res, json) {
    const msg =
      '試行回数が上限に達しました。しばらく待ってから再試行してください。';
    res.status(429);
    return json ? res.json({ error: msg }) : res.type('text/plain').send(msg);
  }

  // 認証ミドルウェア
  const requireAuth = wrap(async function(req, res, next) {
    const admin = await store.read();
    const wantsJson = req.is('json');
    if (!admin) {
      return res.redirect(303, '/setup');
    }
    const cookies = session.parseCookies(req.headers.cookie);
    const payload = session.verify(
      cfg.sessionSecret,
      cookies[session.COOKIE_NAME],
      'session'
    );
    if (!payload || payload.v !== admin.sessionVersion) {
      if (wantsJson) {
        return res.status(401).json({ error: 'ログインが必要です' });
      }
      return res.redirect(303, '/login');
    }
    req.admin = admin;
    req.sid = payload.sid;
    next();
  });

  async function consumeTotp(code) {
    let step = null;
    await store.update(function(cur) {
      if (!cur) {
        return undefined;
      }
      step = totp.verify(cur.totp.secret, code, {
        lastStep: cur.totp.lastStep
      });
      if (step === null) {
        return undefined;
      }
      return Object.assign({}, cur, {
        totp: Object.assign({}, cur.totp, { lastStep: step })
      });
    });
    return step !== null;
  }

  // ---------- セットアップ ----------
  app.get(
    '/setup',
    wrap(async (req, res) => {
      if (await store.read()) {
        return res.redirect(303, '/login');
      }
      res.send(
        views.setupPage({
          minLen: auth.MIN_PASSWORD_LENGTH,
          error: cfg.setupToken
            ? null
            : 'ADMIN_SETUP_TOKEN が未設定のため、セットアップできません。'
        })
      );
    })
  );

  app.post(
    '/setup',
    wrap(async (req, res) => {
      if (await store.read()) {
        return res
          .status(403)
          .type('text/plain')
          .send('Forbidden');
      }
      const render = (status, error) =>
        res
          .status(status)
          .send(views.setupPage({ minLen: auth.MIN_PASSWORD_LENGTH, error }));
      if (!cfg.setupToken) {
        return render(
          403,
          'ADMIN_SETUP_TOKEN が未設定のため、セットアップできません。'
        );
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res);
      }
      if (!auth.safeEqualStrings(strField(req, 'token'), cfg.setupToken)) {
        limiter.fail(req.adminIp);
        return render(401, 'セットアップトークンが正しくありません。');
      }
      const password = strField(req, 'password');
      const policy = auth.checkPasswordPolicy(password);
      if (policy) {
        return render(400, policy);
      }
      if (password !== strField(req, 'password2')) {
        return render(400, 'パスワード(確認)が一致しません。');
      }
      sweepPending(pendingSetups);
      const id = crypto.randomBytes(16).toString('hex');
      pendingSetups.set(id, {
        hash: await auth.hashPassword(password),
        secret: totp.generateSecret(),
        exp: Date.now() + SETUP_TTL_MS
      });
      session.setCookie(
        res,
        session.PRE_COOKIE_NAME,
        session.sign(cfg.sessionSecret, {
          p: 'setup',
          id,
          exp: Date.now() + SETUP_TTL_MS
        }),
        SETUP_TTL_MS
      );
      res.redirect(303, '/setup/totp');
    })
  );

  function pendingSetupFor(req) {
    const cookies = session.parseCookies(req.headers.cookie);
    const payload = session.verify(
      cfg.sessionSecret,
      cookies[session.PRE_COOKIE_NAME],
      'setup'
    );
    const pending = payload && pendingSetups.get(payload.id);
    if (!pending || pending.exp <= Date.now()) {
      return null;
    }
    return { id: payload.id, pending };
  }

  async function renderSetupTotp(res, status, found, error) {
    const uri = totp.otpauthUri(found.pending.secret, 'admin', 'ぶいちゃ便');
    res.status(status).send(
      views.setupTotpPage({
        qrDataUrl: await qrDataUrl(uri),
        secret: found.pending.secret,
        error
      })
    );
  }

  app.get(
    '/setup/totp',
    wrap(async (req, res) => {
      if (await store.read()) {
        return res.redirect(303, '/login');
      }
      const found = pendingSetupFor(req);
      if (!found) {
        return res.redirect(303, '/setup');
      }
      await renderSetupTotp(res, 200, found);
    })
  );

  app.post(
    '/setup/totp',
    wrap(async (req, res) => {
      if (await store.read()) {
        return res
          .status(403)
          .type('text/plain')
          .send('Forbidden');
      }
      const found = pendingSetupFor(req);
      if (!found) {
        return res.redirect(303, '/setup');
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res);
      }
      const step = totp.verify(found.pending.secret, strField(req, 'code'));
      if (step === null) {
        limiter.fail(req.adminIp);
        return renderSetupTotp(res, 401, found, 'コードが正しくありません。');
      }
      let created = false;
      await store.update(function(cur) {
        if (cur) {
          return undefined;
        }
        created = true;
        return {
          version: 1,
          createdAt: Date.now(),
          password: found.pending.hash,
          totp: { secret: found.pending.secret, lastStep: step },
          passkeys: [],
          webauthnUserId: crypto.randomBytes(32).toString('base64url'),
          sessionVersion: 1
        };
      });
      pendingSetups.delete(found.id);
      if (!created) {
        return res
          .status(403)
          .type('text/plain')
          .send('Forbidden');
      }
      limiter.success(req.adminIp);
      session.issueSession(cfg.sessionSecret, res, 1);
      res.redirect(303, '/security');
    })
  );

  // ---------- ログイン ----------
  app.get(
    '/login',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin) {
        return res.redirect(303, '/setup');
      }
      res.send(
        views.loginPage({ hasPasskeys: (admin.passkeys || []).length > 0 })
      );
    })
  );

  app.post(
    '/login',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin) {
        return res.redirect(303, '/setup');
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res);
      }
      const ok = await auth.verifyPassword(
        strField(req, 'password'),
        admin.password
      );
      if (!ok) {
        limiter.fail(req.adminIp);
        return res.status(401).send(
          views.loginPage({
            error: 'ログインに失敗しました。',
            hasPasskeys: (admin.passkeys || []).length > 0
          })
        );
      }
      session.issuePre(cfg.sessionSecret, res, admin.sessionVersion);
      res.redirect(303, '/login/totp');
    })
  );

  function preAuthValid(req, admin) {
    const cookies = session.parseCookies(req.headers.cookie);
    const payload = session.verify(
      cfg.sessionSecret,
      cookies[session.PRE_COOKIE_NAME],
      'pre2fa'
    );
    return !!payload && payload.v === admin.sessionVersion;
  }

  app.get(
    '/login/totp',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin || !preAuthValid(req, admin)) {
        return res.redirect(303, '/login');
      }
      res.send(views.loginTotpPage({}));
    })
  );

  app.post(
    '/login/totp',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin || !preAuthValid(req, admin)) {
        return res.redirect(303, '/login');
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res);
      }
      if (!(await consumeTotp(strField(req, 'code')))) {
        limiter.fail(req.adminIp);
        return res
          .status(401)
          .send(views.loginTotpPage({ error: 'コードが正しくありません。' }));
      }
      limiter.success(req.adminIp);
      session.issueSession(cfg.sessionSecret, res, admin.sessionVersion);
      res.redirect(303, '/');
    })
  );

  app.post(
    '/login/passkey/options',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin || !(admin.passkeys || []).length) {
        return res.status(404).json({ error: 'パスキーが登録されていません' });
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res, true);
      }
      res.json(await webauthn.authenticationOptions(req.adminIp));
    })
  );

  app.post(
    '/login/passkey/verify',
    wrap(async (req, res) => {
      const admin = await store.read();
      if (!admin) {
        return res.status(404).json({ error: '未セットアップです' });
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res, true);
      }
      const fail = () => {
        limiter.fail(req.adminIp);
        return res.status(401).json({ error: 'パスキー認証に失敗しました' });
      };
      let result = null;
      try {
        result = await webauthn.verifyAuthentication(
          strField(req, 'challengeId'),
          req.body.response,
          admin,
          req.adminIp
        );
      } catch (e) {
        console.error('admin: passkey verification error:', e.message);
      }
      if (!result) {
        return fail();
      }
      await store.update(function(cur) {
        const pk = cur && cur.passkeys.find(p => p.id === result.passkey.id);
        if (!pk) {
          return undefined;
        }
        pk.counter = result.newCounter;
        pk.lastUsedAt = Date.now();
        return cur;
      });
      limiter.success(req.adminIp);
      session.issueSession(cfg.sessionSecret, res, admin.sessionVersion);
      res.json({ ok: true });
    })
  );

  app.post('/logout', function(req, res) {
    session.clearCookie(res, session.COOKIE_NAME);
    session.clearCookie(res, session.PRE_COOKIE_NAME);
    res.redirect(303, '/login');
  });

  // ---------- ダッシュボード ----------
  async function renderDashboard(res, extra = {}) {
    let capacity;
    try {
      capacity = await usage.getCapacity();
    } catch (e) {
      console.error('admin: getCapacity failed:', e.message);
      return res
        .status(500)
        .send(
          views.simplePage(
            'エラー',
            '使用量の取得に失敗しました。ログを確認してください。'
          )
        );
    }
    res.send(views.dashboardPage(Object.assign({ capacity }, extra)));
  }

  app.get(
    '/',
    requireAuth,
    wrap((req, res) => renderDashboard(res))
  );

  app.post(
    '/action/large-mode',
    requireAuth,
    wrap(async (req, res) => {
      const enabled = strField(req, 'enabled') === '1';
      try {
        await usage.setLargeModeManual(enabled);
      } catch (e) {
        console.error('admin: setLargeModeManual failed:', e.message);
        return renderDashboard(res, { error: '切り替えに失敗しました。' });
      }
      await renderDashboard(res, {
        message: `大容量モードを ${enabled ? 'ON' : 'OFF'} にしました。`
      });
    })
  );

  app.post(
    '/action/s3-usage',
    requireAuth,
    wrap(async (req, res) => {
      let s3Usage;
      try {
        s3Usage = await usage.getS3Usage();
      } catch (e) {
        console.error('admin: getS3Usage failed:', e.message);
        return renderDashboard(res, { error: 'S3 実測に失敗しました。' });
      }
      await renderDashboard(res, { s3Usage });
    })
  );

  app.post(
    '/action/sweep',
    requireAuth,
    wrap(async (req, res) => {
      let result;
      try {
        result = await sweeper.runOnce();
      } catch (e) {
        console.error('admin: sweeper.runOnce failed:', e.message);
        return renderDashboard(res, { error: '掃除に失敗しました。' });
      }
      await renderDashboard(res, {
        message: '掃除を実行しました。',
        sweepResult: result
      });
    })
  );

  // ---------- ファイル一覧 ----------
  async function renderFiles(res, extra = {}) {
    let files;
    try {
      files = await usage.listFiles();
    } catch (e) {
      console.error('admin: listFiles failed:', e.message);
      return res
        .status(500)
        .send(views.simplePage('エラー', 'ファイル一覧の取得に失敗しました。'));
    }
    files = files
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.send(views.filesPage(Object.assign({ files }, extra)));
  }

  app.get(
    '/files',
    requireAuth,
    wrap((req, res) => renderFiles(res))
  );

  app.post(
    '/files/delete',
    requireAuth,
    wrap(async (req, res) => {
      const id = strField(req, 'id');
      if (!/^[0-9a-fA-F]{10,16}$/.test(id)) {
        return renderFiles(res, { error: 'ID が不正です。' });
      }
      try {
        await usage.deleteFile(id);
      } catch (e) {
        console.error('admin: deleteFile failed:', e.message);
        return renderFiles(res, { error: '削除に失敗しました。' });
      }
      await renderFiles(res, { message: `${id} を削除しました。` });
    })
  );

  // ---------- セキュリティ設定 ----------
  function renderSecurity(res, admin, extra = {}) {
    res.send(
      views.securityPage(
        Object.assign({ admin, minLen: auth.MIN_PASSWORD_LENGTH }, extra)
      )
    );
  }

  app.get(
    '/security',
    requireAuth,
    wrap((req, res) => renderSecurity(res, req.admin))
  );

  // 再認証（現在のパスワード）。失敗は同じレート制限に算入する。
  // json=true の場合は JSON でエラーを返す（パスキー登録 API 用）。
  async function reauth(req, res, json = false) {
    if (limiter.isBlocked(req.adminIp)) {
      tooMany(res, json);
      return false;
    }
    const ok = await auth.verifyPassword(
      strField(req, 'current'),
      req.admin.password
    );
    if (!ok) {
      limiter.fail(req.adminIp);
      if (json) {
        res.status(401).json({ error: '現在のパスワードが正しくありません。' });
        return false;
      }
      res.status(401).send(
        views.securityPage({
          admin: req.admin,
          minLen: auth.MIN_PASSWORD_LENGTH,
          error: '現在のパスワードが正しくありません。'
        })
      );
      return false;
    }
    limiter.success(req.adminIp);
    return true;
  }

  app.post(
    '/security/password',
    requireAuth,
    wrap(async (req, res) => {
      if (!(await reauth(req, res))) {
        return;
      }
      const password = strField(req, 'password');
      const policy = auth.checkPasswordPolicy(password);
      const bad =
        policy ||
        (password !== strField(req, 'password2')
          ? 'パスワード(確認)が一致しません。'
          : null);
      if (bad) {
        return res.status(400).send(
          views.securityPage({
            admin: req.admin,
            minLen: auth.MIN_PASSWORD_LENGTH,
            error: bad
          })
        );
      }
      const hash = await auth.hashPassword(password);
      const next = await store.update(cur =>
        Object.assign({}, cur, {
          password: hash,
          sessionVersion: cur.sessionVersion + 1
        })
      );
      session.issueSession(cfg.sessionSecret, res, next.sessionVersion);
      renderSecurity(res, next, { message: 'パスワードを変更しました。' });
    })
  );

  app.post(
    '/security/totp/start',
    requireAuth,
    wrap(async (req, res) => {
      if (!(await reauth(req, res))) {
        return;
      }
      sweepPending(pendingTotp);
      const secret = totp.generateSecret();
      pendingTotp.set(req.sid, {
        secret,
        exp: Date.now() + TOTP_ENROLL_TTL_MS
      });
      renderSecurity(res, req.admin, {
        totpEnroll: {
          secret,
          qrDataUrl: await qrDataUrl(
            totp.otpauthUri(secret, 'admin', 'ぶいちゃ便')
          )
        }
      });
    })
  );

  app.post(
    '/security/totp/confirm',
    requireAuth,
    wrap(async (req, res) => {
      const pending = pendingTotp.get(req.sid);
      if (!pending || pending.exp <= Date.now()) {
        pendingTotp.delete(req.sid);
        return renderSecurity(res, req.admin, {
          error: '登録の有効期限が切れました。最初からやり直してください。'
        });
      }
      if (limiter.isBlocked(req.adminIp)) {
        return tooMany(res);
      }
      const step = totp.verify(pending.secret, strField(req, 'code'));
      if (step === null) {
        limiter.fail(req.adminIp);
        return res.status(401).send(
          views.securityPage({
            admin: req.admin,
            minLen: auth.MIN_PASSWORD_LENGTH,
            error: 'コードが正しくありません。',
            totpEnroll: {
              secret: pending.secret,
              qrDataUrl: await qrDataUrl(
                totp.otpauthUri(pending.secret, 'admin', 'ぶいちゃ便')
              )
            }
          })
        );
      }
      limiter.success(req.adminIp);
      pendingTotp.delete(req.sid);
      const next = await store.update(cur =>
        Object.assign({}, cur, {
          totp: { secret: pending.secret, lastStep: step },
          sessionVersion: cur.sessionVersion + 1
        })
      );
      session.issueSession(cfg.sessionSecret, res, next.sessionVersion);
      renderSecurity(res, next, { message: 'TOTP を再登録しました。' });
    })
  );

  app.post(
    '/security/passkey/options',
    requireAuth,
    wrap(async (req, res) => {
      if (!(await reauth(req, res, true))) {
        return;
      }
      res.json(await webauthn.registrationOptions(req.admin, req.sid));
    })
  );

  app.post(
    '/security/passkey/verify',
    requireAuth,
    wrap(async (req, res) => {
      if (!(await reauth(req, res, true))) {
        return;
      }
      const name = strField(req, 'name')
        .trim()
        .slice(0, 40);
      if (!name) {
        return res.status(400).json({ error: '名前を入力してください' });
      }
      if ((req.admin.passkeys || []).length >= MAX_PASSKEYS) {
        return res.status(400).json({ error: 'パスキーの上限に達しています' });
      }
      let info = null;
      try {
        info = await webauthn.verifyRegistration(
          strField(req, 'challengeId'),
          req.body.response,
          req.sid
        );
      } catch (e) {
        console.error('admin: passkey registration error:', e.message);
      }
      if (!info) {
        return res.status(400).json({ error: 'パスキーの登録に失敗しました' });
      }
      let dup = false;
      await store.update(function(cur) {
        if (cur.passkeys.some(p => p.id === info.id)) {
          dup = true;
          return undefined;
        }
        cur.passkeys.push({
          id: info.id,
          name,
          publicKey: info.publicKey,
          counter: info.counter,
          transports: info.transports,
          createdAt: Date.now()
        });
        return cur;
      });
      if (dup) {
        return res.status(400).json({ error: 'このパスキーは登録済みです' });
      }
      res.json({ ok: true });
    })
  );

  app.post(
    '/security/passkey/delete',
    requireAuth,
    wrap(async (req, res) => {
      if (!(await reauth(req, res))) {
        return;
      }
      const id = strField(req, 'id');
      // 削除後は他端末のセッションを失効させる（現在の端末は再発行）。
      // パスワード+TOTP でログインできるため、最後の1つでもロックアウトしない。
      const next = await store.update(cur =>
        Object.assign({}, cur, {
          passkeys: cur.passkeys.filter(p => p.id !== id),
          sessionVersion: cur.sessionVersion + 1
        })
      );
      session.issueSession(cfg.sessionSecret, res, next.sessionVersion);
      renderSecurity(res, next, { message: 'パスキーを削除しました。' });
    })
  );

  app.post(
    '/security/logout-all',
    requireAuth,
    wrap(async (req, res) => {
      await store.update(cur =>
        Object.assign({}, cur, { sessionVersion: cur.sessionVersion + 1 })
      );
      session.clearCookie(res, session.COOKIE_NAME);
      session.clearCookie(res, session.PRE_COOKIE_NAME);
      res.redirect(303, '/login');
    })
  );

  app.use(function(req, res) {
    res
      .status(404)
      .type('text/plain')
      .send('Not Found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use(function(err, req, res, next) {
    console.error('admin: unhandled error:', err && err.message);
    if (res.headersSent) {
      return;
    }
    res
      .status(500)
      .type('text/plain')
      .send('Internal Server Error');
  });

  return app;
}

function start(env = process.env) {
  const cfg = adminConfig.load(env);
  if (!cfg.sessionSecret) {
    console.error(
      'admin: ADMIN_SESSION_SECRET が未設定のため管理画面を起動しません。'
    );
    return null;
  }
  if (cfg.sessionSecret.length < 32) {
    console.error(
      'admin: ADMIN_SESSION_SECRET は32文字以上にしてください。管理画面を起動しません。'
    );
    return null;
  }
  if (cfg.trustedProxies.length === 0) {
    console.warn(
      'admin: 信頼プロキシ未設定: リバースプロキシ経由の場合はプロキシの IP が許可 CIDR に含まれると全リクエストが許可されます'
    );
  }
  let app;
  try {
    app = createApp(cfg);
  } catch (e) {
    console.error('admin: 管理画面の初期化に失敗しました:', e.message);
    return null;
  }
  const server = app.listen(cfg.port, cfg.listenAddress, function() {
    console.log(`admin: listening on ${cfg.listenAddress}:${cfg.port}`);
  });
  server.on('error', e => console.error('admin: server error:', e.message));
  return server;
}

module.exports = { start, createApp };
