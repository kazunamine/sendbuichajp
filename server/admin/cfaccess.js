const crypto = require('crypto');
const https = require('https');
const net = require('net');
const ipguard = require('./ipguard');

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;
const MAX_JWT_LENGTH = 8192;
const CLOCK_SKEW_SEC = 60;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const LOGOUT_PATH = '/cdn-cgi/access/logout';

// "https://team.cloudflareaccess.com/" -> "team.cloudflareaccess.com"
// 不正なら '' を返す。
function normalizeTeamDomain(value) {
  let s = String(value || '')
    .trim()
    .toLowerCase();
  s = s.replace(/^https:\/\//, '').replace(/\/+$/, '');
  const labels = s.split('.');
  return s.length <= 253 &&
    labels.length >= 2 &&
    labels.every(l => HOST_LABEL.test(l))
    ? s
    : '';
}

// Node 標準 https で JWKS を取得する。リダイレクトは追わない。
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: JWKS_TIMEOUT_MS, headers: { Accept: 'application/json' } },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`JWKS HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > JWKS_MAX_BYTES) {
            req.destroy(new Error('JWKS too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('JWKS parse error'));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('JWKS timeout')));
    req.on('error', reject);
  });
}

// JWKS のメモリキャッシュ。
// - TTL 10 分。未知の kid の時のみ即時再取得（ただし取得試行は最短30秒間隔）。
// - 取得失敗は例外（呼び出し側で拒否 = フェイルクローズ）。
function createKeyStore({ jwksUrl, fetchJwks, now }) {
  let keys = new Map();
  let fetchedAt = 0;
  let lastAttempt = null;
  let inflight = null;

  async function refresh() {
    lastAttempt = now();
    const body = await fetchJwks(jwksUrl);
    if (!body || !Array.isArray(body.keys)) {
      throw new Error('JWKS format error');
    }
    const next = new Map();
    for (const jwk of body.keys) {
      if (
        !jwk ||
        jwk.kty !== 'RSA' ||
        typeof jwk.kid !== 'string' ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        (jwk.alg !== undefined && jwk.alg !== 'RS256')
      ) {
        continue;
      }
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch (e) {
        // 不正な鍵は無視
      }
    }
    keys = next;
    fetchedAt = now();
  }

  function startRefresh() {
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  // 公開鍵 (KeyObject) を返す。見つからなければ null、取得失敗は throw。
  async function getKey(kid) {
    const t = now();
    const fresh = fetchedAt !== 0 && t - fetchedAt < JWKS_TTL_MS;
    if (fresh && keys.has(kid)) {
      return keys.get(kid);
    }
    if (inflight) {
      await inflight;
    } else if (lastAttempt === null || t - lastAttempt >= JWKS_MIN_REFETCH_MS) {
      await startRefresh();
    } else if (!fresh) {
      throw new Error('JWKS unavailable');
    }
    const after = now();
    if (fetchedAt === 0 || after - fetchedAt >= JWKS_TTL_MS) {
      throw new Error('JWKS unavailable');
    }
    return keys.get(kid) || null;
  }

  return { getKey };
}

function decodeJson(part) {
  if (!B64URL.test(part)) {
    return null;
  }
  try {
    const v = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

// JWT を検証して payload を返す。失敗は Error を throw。
async function verifyJwt(token, opts, keyStore, nowMs) {
  if (typeof token !== 'string' || token.length > MAX_JWT_LENGTH) {
    throw new Error('bad token');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2] || !parts.every(p => B64URL.test(p))) {
    throw new Error('bad token format');
  }
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload) {
    throw new Error('bad token encoding');
  }
  if (header.alg !== 'RS256') {
    throw new Error('alg not allowed');
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new Error('kid missing');
  }
  const key = await keyStore.getKey(header.kid);
  if (!key) {
    throw new Error('unknown kid');
  }
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64')
  );
  if (!ok) {
    throw new Error('bad signature');
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (payload.iss !== `https://${opts.teamDomain}`) {
    throw new Error('iss mismatch');
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.some(a => typeof a === 'string' && opts.aud.includes(a))) {
    throw new Error('aud mismatch');
  }
  if (typeof payload.exp !== 'number' || !(payload.exp > nowSec)) {
    throw new Error('expired');
  }
  for (const claim of ['nbf', 'iat']) {
    if (payload[claim] !== undefined) {
      if (
        typeof payload[claim] !== 'number' ||
        payload[claim] > nowSec + CLOCK_SKEW_SEC
      ) {
        throw new Error(`${claim} in the future`);
      }
    }
  }
  if (
    typeof payload.email !== 'string' ||
    !opts.emails.includes(payload.email.trim().toLowerCase())
  ) {
    throw new Error('email not allowed');
  }
  return payload;
}

function forbid(res) {
  res
    .status(403)
    .type('text/plain')
    .send('Forbidden');
}

// cfg: { trustedProxies, cfTeamDomain, cfAud, cfEmails }
// deps: { fetchJwks, now } テスト用差し替え
function createGuard(cfg, deps = {}) {
  const teamDomain = normalizeTeamDomain(cfg.cfTeamDomain);
  const aud = cfg.cfAud || [];
  const emails = (cfg.cfEmails || []).map(e => e.toLowerCase());
  if (!teamDomain || aud.length === 0 || emails.length === 0) {
    throw new Error(
      'cloudflare-access: TEAM_DOMAIN / AUD / EMAILS が不正または未設定です'
    );
  }
  if (!cfg.trustedProxies || cfg.trustedProxies.length === 0) {
    throw new Error('cloudflare-access: ADMIN_TRUSTED_PROXIES が未設定です');
  }
  const trusted = ipguard.buildMatcher(cfg.trustedProxies);
  const now = deps.now || Date.now;
  const keyStore = createKeyStore({
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    fetchJwks: deps.fetchJwks || fetchJson,
    now
  });
  const opts = { teamDomain, aud, emails };

  return async function cfAccessGuard(req, res, next) {
    const remote = ipguard.normalizeIp(req.socket.remoteAddress);
    // LAN の IP は信頼しない: 信頼プロキシ (cloudflared) 以外は拒否
    if (!remote || !ipguard.matches(trusted, remote)) {
      return forbid(res);
    }
    const cfIp = ipguard.normalizeIp(req.headers['cf-connecting-ip']);
    req.adminIp = net.isIP(cfIp) ? cfIp : remote;

    const token = req.headers['cf-access-jwt-assertion'];
    if (!token || typeof token !== 'string') {
      return forbid(res);
    }
    try {
      const payload = await verifyJwt(token, opts, keyStore, now());
      req.accessEmail = payload.email.trim().toLowerCase();
    } catch (e) {
      console.warn('admin: cloudflare access rejected:', e.message);
      return forbid(res);
    }
    next();
  };
}

module.exports = {
  LOGOUT_PATH,
  normalizeTeamDomain,
  createGuard,
  createKeyStore,
  verifyJwt
};
