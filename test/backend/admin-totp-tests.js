const assert = require('assert');
const totp = require('../../server/admin/totp');

// RFC 6238 Appendix B (SHA1)。シークレットは ASCII "12345678901234567890"。
// 桁数は 8 のベクタだが、6桁はその下位6桁と一致する。
const SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130']
];

describe('admin totp', function() {
  it('matches RFC 6238 test vectors (8 digits)', function() {
    for (const [t, code] of VECTORS) {
      assert.strictEqual(totp.generate(SECRET, t * 1000, 8), code);
    }
  });

  it('matches RFC 6238 test vectors (6 digits)', function() {
    for (const [t, code] of VECTORS) {
      assert.strictEqual(totp.generate(SECRET, t * 1000), code.slice(2));
    }
  });

  it('base32 round-trips', function() {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
    assert.strictEqual(totp.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  });

  it('accepts +-1 step but not +-2', function() {
    const now = 1111111109 * 1000;
    const step = totp.timeStep(now);
    const code = s => totp.generate(SECRET, s * 30 * 1000);
    assert.strictEqual(totp.verify(SECRET, code(step), { nowMs: now }), step);
    assert.strictEqual(
      totp.verify(SECRET, code(step - 1), { nowMs: now }),
      step - 1
    );
    assert.strictEqual(
      totp.verify(SECRET, code(step + 1), { nowMs: now }),
      step + 1
    );
    assert.strictEqual(
      totp.verify(SECRET, code(step - 2), { nowMs: now }),
      null
    );
    assert.strictEqual(
      totp.verify(SECRET, code(step + 2), { nowMs: now }),
      null
    );
  });

  it('rejects reuse of the same or an older step', function() {
    const now = 1111111109 * 1000;
    const step = totp.timeStep(now);
    const code = totp.generate(SECRET, now);
    assert.strictEqual(totp.verify(SECRET, code, { nowMs: now }), step);
    assert.strictEqual(
      totp.verify(SECRET, code, { nowMs: now, lastStep: step }),
      null
    );
  });

  it('rejects malformed codes', function() {
    const now = 59000;
    assert.strictEqual(totp.verify(SECRET, '', { nowMs: now }), null);
    assert.strictEqual(totp.verify(SECRET, 'abcdef', { nowMs: now }), null);
    assert.strictEqual(totp.verify(SECRET, '1234567', { nowMs: now }), null);
    assert.strictEqual(totp.verify(SECRET, undefined, { nowMs: now }), null);
  });

  it('accepts codes with spaces', function() {
    const now = 59000;
    const code = totp.generate(SECRET, now);
    assert.notStrictEqual(
      totp.verify(SECRET, code.slice(0, 3) + ' ' + code.slice(3), {
        nowMs: now
      }),
      null
    );
  });

  it('builds an otpauth URI', function() {
    const uri = totp.otpauthUri('ABC', 'admin', 'ぶいちゃ便');
    assert(uri.startsWith('otpauth://totp/'));
    assert(uri.includes('secret=ABC'));
    assert(uri.includes('period=30'));
  });
});
