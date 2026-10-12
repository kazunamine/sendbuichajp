const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD_LENGTH = 12;

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 128 * params.N * params.r * 2
      },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return {
    algo: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
    salt: salt.toString('base64'),
    hash: key.toString('base64')
  };
}

async function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt' || typeof password !== 'string') {
    return false;
  }
  const expected = Buffer.from(record.hash, 'base64');
  const key = await scrypt(password, Buffer.from(record.salt, 'base64'), {
    N: record.N,
    r: record.r,
    p: record.p,
    keylen: expected.length
  });
  return crypto.timingSafeEqual(key, expected);
}

function checkPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください。`;
  }
  if (password.length > 256) {
    return 'パスワードが長すぎます。';
  }
  return null;
}

function safeEqualStrings(a, b) {
  const ha = crypto
    .createHash('sha256')
    .update(String(a))
    .digest();
  const hb = crypto
    .createHash('sha256')
    .update(String(b))
    .digest();
  return crypto.timingSafeEqual(ha, hb);
}

// IP ごとの失敗回数制限（既定: 15分に10回）。成功で解除。
function createRateLimiter(max = 10, windowMs = 15 * 60 * 1000) {
  const hits = new Map();
  function prune(now) {
    for (const [k, v] of hits) {
      if (v.reset <= now) {
        hits.delete(k);
      }
    }
  }
  return {
    isBlocked(key, now = Date.now()) {
      const v = hits.get(key);
      return !!v && v.reset > now && v.count >= max;
    },
    fail(key, now = Date.now()) {
      if (hits.size > 10000) {
        prune(now);
      }
      const v = hits.get(key);
      if (!v || v.reset <= now) {
        hits.set(key, { count: 1, reset: now + windowMs });
      } else {
        v.count++;
      }
    },
    success(key) {
      hits.delete(key);
    }
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  safeEqualStrings,
  createRateLimiter,
  MIN_PASSWORD_LENGTH
};
