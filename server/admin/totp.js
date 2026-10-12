const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str)
    .replace(/=+$/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) {
      throw new Error('invalid base32');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// RFC 4226 HOTP (SHA1)
function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto
    .createHmac('sha1', secretBuf)
    .update(msg)
    .digest();
  const off = h[h.length - 1] & 0xf;
  const bin =
    ((h[off] & 0x7f) << 24) |
    (h[off + 1] << 16) |
    (h[off + 2] << 8) |
    h[off + 3];
  return String(bin % Math.pow(10, digits)).padStart(digits, '0');
}

function timeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / PERIOD);
}

function generate(secretB32, nowMs = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secretB32), timeStep(nowMs), digits);
}

// 一致したステップ番号を返す（不一致は null）。
// lastStep 以下のステップは再利用として拒否する。窓は ±window ステップ。
function verify(secretB32, code, opts = {}) {
  const nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const window = opts.window === undefined ? 1 : opts.window;
  const lastStep = opts.lastStep === undefined ? -1 : opts.lastStep;
  const digits = opts.digits || DIGITS;
  const input = String(code || '').replace(/\s+/g, '');
  if (!/^\d+$/.test(input) || input.length !== digits) {
    return null;
  }
  const secret = base32Decode(secretB32);
  const cur = timeStep(nowMs);
  let matched = null;
  // 全ステップを常に評価して処理時間を一定に保つ
  for (let s = cur - window; s <= cur + window; s++) {
    const expected = Buffer.from(hotp(secret, s, digits));
    const ok = crypto.timingSafeEqual(expected, Buffer.from(input));
    if (ok && s > lastStep && (matched === null || s > matched)) {
      matched = s;
    }
  }
  return matched;
}

function otpauthUri(secretB32, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD)
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  generate,
  verify,
  timeStep,
  otpauthUri
};
