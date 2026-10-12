const assert = require('assert');
const sinon = require('sinon');
const ipguard = require('../../server/admin/ipguard');

const DEFAULT = ['127.0.0.1/32', '::1/128', '192.168.0.0/16', '10.0.0.0/8'];

describe('admin ipguard', function() {
  describe('normalizeIp', function() {
    it('unmaps IPv4-mapped IPv6', function() {
      assert.strictEqual(
        ipguard.normalizeIp('::ffff:192.168.1.5'),
        '192.168.1.5'
      );
      assert.strictEqual(ipguard.normalizeIp('::FFFF:10.0.0.1'), '10.0.0.1');
    });
    it('leaves other addresses alone', function() {
      assert.strictEqual(ipguard.normalizeIp('::1'), '::1');
      assert.strictEqual(ipguard.normalizeIp(' 1.2.3.4 '), '1.2.3.4');
      assert.strictEqual(ipguard.normalizeIp(undefined), '');
    });
  });

  describe('CIDR matching', function() {
    const list = ipguard.buildMatcher(DEFAULT);
    it('allows addresses inside the ranges', function() {
      assert(ipguard.matches(list, '127.0.0.1'));
      assert(ipguard.matches(list, '::1'));
      assert(ipguard.matches(list, '192.168.1.100'));
      assert(ipguard.matches(list, '10.255.0.1'));
      assert(ipguard.matches(list, '::ffff:192.168.0.9'));
    });
    it('rejects addresses outside the ranges', function() {
      assert(!ipguard.matches(list, '192.169.0.1'));
      assert(!ipguard.matches(list, '172.16.0.1'));
      assert(!ipguard.matches(list, '8.8.8.8'));
      assert(!ipguard.matches(list, '::ffff:8.8.8.8'));
      assert(!ipguard.matches(list, '2001:db8::1'));
      assert(!ipguard.matches(list, 'garbage'));
      assert(!ipguard.matches(list, ''));
    });
    it('throws on invalid CIDR', function() {
      assert.throws(() => ipguard.buildMatcher(['300.0.0.0/8']));
      assert.throws(() => ipguard.buildMatcher(['10.0.0.0/33']));
    });
  });

  describe('clientIp (X-Forwarded-For)', function() {
    const trusted = ipguard.buildMatcher(['192.168.1.100']);
    it('ignores XFF from untrusted peers', function() {
      assert.strictEqual(
        ipguard.clientIp('192.168.1.50', '8.8.8.8', trusted),
        '192.168.1.50'
      );
    });
    it('uses the rightmost XFF entry from a trusted proxy', function() {
      assert.strictEqual(
        ipguard.clientIp('::ffff:192.168.1.100', '10.0.0.1, 8.8.8.8', trusted),
        '8.8.8.8'
      );
      assert.strictEqual(
        ipguard.clientIp('192.168.1.100', '192.168.1.7', trusted),
        '192.168.1.7'
      );
    });
    it('returns empty (deny) when a trusted proxy sends no XFF', function() {
      assert.strictEqual(
        ipguard.clientIp('192.168.1.100', undefined, trusted),
        ''
      );
      assert.strictEqual(ipguard.clientIp('192.168.1.100', '', trusted), '');
    });
    it('returns empty (deny) for a garbage XFF from a trusted proxy', function() {
      assert.strictEqual(
        ipguard.clientIp('192.168.1.100', 'nonsense', trusted),
        ''
      );
    });
    it('trusts nobody when the list is empty', function() {
      const none = ipguard.buildMatcher([]);
      assert.strictEqual(
        ipguard.clientIp('1.2.3.4', '5.6.7.8', none),
        '1.2.3.4'
      );
    });
  });

  describe('middleware', function() {
    function run(remote, xff, cfg) {
      const guard = ipguard.createGuard(cfg);
      const req = { socket: { remoteAddress: remote }, headers: {} };
      if (xff) {
        req.headers['x-forwarded-for'] = xff;
      }
      const res = {};
      res.status = sinon.stub().returns(res);
      res.type = sinon.stub().returns(res);
      res.send = sinon.stub().returns(res);
      const next = sinon.stub();
      guard(req, res, next);
      return { req, res, next };
    }
    const cfg = {
      allowedCidrs: DEFAULT,
      trustedProxies: ['192.168.1.100']
    };
    it('passes allowed clients', function() {
      const r = run('::ffff:192.168.1.5', null, cfg);
      assert(r.next.calledOnce);
      assert.strictEqual(r.req.adminIp, '192.168.1.5');
    });
    it('returns 403 for outside clients', function() {
      const r = run('8.8.8.8', null, cfg);
      assert(r.next.notCalled);
      assert(r.res.status.calledWith(403));
    });
    it('returns 403 when a proxied client is outside the CIDRs', function() {
      const r = run('192.168.1.100', '203.0.113.9', cfg);
      assert(r.next.notCalled);
      assert(r.res.status.calledWith(403));
    });
    it('returns 403 when a trusted proxy sends no XFF (fail closed)', function() {
      const r = run('192.168.1.100', null, cfg);
      assert(r.next.notCalled);
      assert(r.res.status.calledWith(403));
    });
    it('does not let a spoofed XFF from an untrusted peer bypass the check', function() {
      const r = run('8.8.8.8', '192.168.1.5', cfg);
      assert(r.next.notCalled);
      assert(r.res.status.calledWith(403));
    });
  });
});
