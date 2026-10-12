const crypto = require('crypto');

const COOKIE_NAME = 'admin_session';
const PRE_COOKIE_NAME = 'admin_pre';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PRE_TTL_MS = 5 * 60 * 1000;

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function mac(secret, data) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest();
}

// payload は JSON 化可能なオブジェクト。p は用途（'session' / 'pre2fa'）。
function sign(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(secret, body))}`;
}

function verify(secret, token, purpose, nowMs = Date.now()) {
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, sig] = parts;
  const given = Buffer.from(sig, 'base64url');
  const expected = mac(secret, body);
  if (given.length !== expected.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(given, expected)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || payload.p !== purpose) {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowMs) {
    return null;
  }
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) {
      continue;
    }
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (e) {
        // 不正なクッキーは無視
      }
    }
  }
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(
      value
    )}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(
      maxAgeMs / 1000
    )}`
  );
}

function clearCookie(res, name) {
  res.append(
    'Set-Cookie',
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  );
}

function issueSession(secret, res, version, nowMs = Date.now()) {
  const sid = crypto.randomBytes(16).toString('hex');
  const token = sign(secret, {
    p: 'session',
    sid,
    v: version,
    exp: nowMs + SESSION_TTL_MS
  });
  setCookie(res, COOKIE_NAME, token, SESSION_TTL_MS);
  clearCookie(res, PRE_COOKIE_NAME);
  return sid;
}

function issuePre(secret, res, version, nowMs = Date.now()) {
  const token = sign(secret, {
    p: 'pre2fa',
    v: version,
    exp: nowMs + PRE_TTL_MS
  });
  setCookie(res, PRE_COOKIE_NAME, token, PRE_TTL_MS);
}

module.exports = {
  COOKIE_NAME,
  PRE_COOKIE_NAME,
  SESSION_TTL_MS,
  PRE_TTL_MS,
  sign,
  verify,
  parseCookies,
  setCookie,
  clearCookie,
  issueSession,
  issuePre
};
