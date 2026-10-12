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

// Node 16.13 の net.BlockList は /32 や /128 のサブネットが全アドレスに
// 一致する不具合があるため、BlockList を使わず自前で判定する。
function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let n = BigInt(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
      return null;
    }
    n = (n << BigInt(8)) | BigInt(Number(part));
  }
  return n;
}

// net.isIP(s) === 6 を通った文字列を 128bit の BigInt にする。
function parseIPv6(s) {
  let str = s.toLowerCase();
  // 末尾の埋め込み IPv4 (例 ::1.2.3.4) を 16bit x2 に展開
  const lastColon = str.lastIndexOf(':');
  if (str.indexOf('.', lastColon) !== -1) {
    const v4 = parseIPv4(str.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    str =
      str.slice(0, lastColon + 1) +
      (v4 >> BigInt(16)).toString(16) +
      ':' +
      (v4 & BigInt(0xffff)).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) {
      return null;
    }
    groups = head.concat(new Array(fill).fill('0'), tail);
  } else {
    groups = head;
  }
  if (groups.length !== 8) {
    return null;
  }
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null;
    }
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

// 正規化済みの IP 文字列を { family, value } にする。不正なら null。
function parseIp(a) {
  const family = net.isIP(a);
  if (family === 4) {
    const value = parseIPv4(a);
    return value === null ? null : { family: 4, value };
  }
  if (family === 6) {
    const value = parseIPv6(a);
    return value === null ? null : { family: 6, value };
  }
  return null;
}

function buildMatcher(cidrs) {
  const rules = [];
  for (const c of cidrs) {
    const [addr, prefix] = c.split('/');
    const a = normalizeIp(addr);
    const parsed = parseIp(a);
    if (!parsed) {
      throw new Error(`不正な CIDR/IP: ${c}`);
    }
    const bits = parsed.family === 4 ? 32 : 128;
    if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) {
      throw new Error(`不正な CIDR プレフィックス: ${c}`);
    }
    const p = prefix === undefined ? bits : Number(prefix);
    if (!Number.isInteger(p) || p < 0 || p > bits) {
      throw new Error(`不正な CIDR プレフィックス: ${c}`);
    }
    const shift = BigInt(bits - p);
    rules.push({
      family: parsed.family,
      shift,
      network: parsed.value >> shift
    });
  }
  return { rules };
}

function matches(list, ip) {
  const parsed = parseIp(normalizeIp(ip));
  if (!parsed) {
    return false;
  }
  return list.rules.some(
    r => r.family === parsed.family && parsed.value >> r.shift === r.network
  );
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
