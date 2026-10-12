const net = require('net');

// "::ffff:192.168.1.1" -> "192.168.1.1"。ゾーン ID も除去する。
function normalizeIp(ip) {
  if (typeof ip !== 'string') {
    return '';
  }
  let s = ip.trim();
  const zone = s.indexOf('%');
  if (zone !== -1) {
    s = s.slice(0, zone);
  }
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (m) {
    s = m[1];
  }
  return s;
}

function buildMatcher(cidrs) {
  const list = new net.BlockList();
  for (const c of cidrs) {
    const [addr, prefix] = c.split('/');
    const a = normalizeIp(addr);
    const family = net.isIP(a);
    if (!family) {
      throw new Error(`不正な CIDR/IP: ${c}`);
    }
    const max = family === 4 ? 32 : 128;
    const p = prefix === undefined ? max : Number(prefix);
    if (!Number.isInteger(p) || p < 0 || p > max) {
      throw new Error(`不正な CIDR プレフィックス: ${c}`);
    }
    list.addSubnet(a, p, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

function matches(list, ip) {
  const a = normalizeIp(ip);
  const family = net.isIP(a);
  if (!family) {
    return false;
  }
  return list.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

// 接続元 IP を決定する。
// 直接の接続元(socket.remoteAddress)が信頼プロキシの場合のみ、
// X-Forwarded-For の右端（そのプロキシが付けた値）を採用する。
// 信頼プロキシ経由なのに有効な右端が取れない場合は判定不能として
// '' を返す（フェイルクローズ。remote=プロキシ自身を採用しない）。
function clientIp(remoteAddress, xff, trustedList) {
  const remote = normalizeIp(remoteAddress);
  if (trustedList && matches(trustedList, remote)) {
    if (!xff) {
      return '';
    }
    const header = Array.isArray(xff) ? xff.join(',') : String(xff);
    const parts = header.split(',');
    const last = normalizeIp(parts[parts.length - 1]);
    return net.isIP(last) ? last : '';
  }
  return remote;
}

function createGuard(cfg) {
  const allowed = buildMatcher(cfg.allowedCidrs);
  const trusted = buildMatcher(cfg.trustedProxies);
  return function ipGuard(req, res, next) {
    const ip = clientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      trusted
    );
    req.adminIp = ip;
    if (!ip || !matches(allowed, ip)) {
      res
        .status(403)
        .type('text/plain')
        .send('Forbidden');
      return;
    }
    next();
  };
}

module.exports = {
  normalizeIp,
  buildMatcher,
  matches,
  clientIp,
  createGuard
};
