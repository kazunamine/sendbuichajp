const path = require('path');
const cfaccess = require('./cfaccess');

const DEFAULT_CIDRS = '127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8';

function list(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ADMIN_* を process.env から直接読む（server/config.js は使わない）
function load(env = process.env) {
  const origin = (env.ADMIN_ORIGIN || 'https://send.admin.buicha.jp').replace(
    /\/+$/,
    ''
  );
  const rawTeam = String(env.ADMIN_CF_ACCESS_TEAM_DOMAIN || '').trim();
  return {
    mode: String(env.ADMIN_MODE || 'lan')
      .trim()
      .toLowerCase(),
    cfTeamDomainRaw: rawTeam,
    cfTeamDomain: cfaccess.normalizeTeamDomain(rawTeam),
    cfAud: list(env.ADMIN_CF_ACCESS_AUD),
    cfEmails: list(env.ADMIN_CF_ACCESS_EMAILS).map(e => e.toLowerCase()),
    enabled: env.ADMIN_ENABLED === 'true' || env.ADMIN_ENABLED === '1',
    port: parseInt(env.ADMIN_PORT || '2526', 10),
    listenAddress: env.ADMIN_LISTEN_ADDRESS || '0.0.0.0',
    allowedCidrs: list(
      env.ADMIN_ALLOWED_CIDRS === undefined
        ? DEFAULT_CIDRS
        : env.ADMIN_ALLOWED_CIDRS
    ),
    trustedProxies: list(env.ADMIN_TRUSTED_PROXIES),
    rpID: env.ADMIN_RP_ID || 'send.admin.buicha.jp',
    origin,
    sessionSecret: env.ADMIN_SESSION_SECRET || '',
    setupToken: env.ADMIN_SETUP_TOKEN || '',
    dataDir: path.resolve(env.ADMIN_DATA_DIR || '/app/admin-data'),
    rpName: 'ぶいちゃ便 管理画面'
  };
}

module.exports = { load, list, DEFAULT_CIDRS };
