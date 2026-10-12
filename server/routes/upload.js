const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const Limiter = require('../limiter');
const usage = require('../usage');
const { encryptedSize } = require('../../app/utils');

const log = mozlog('send.upload');

module.exports = async function(req, res) {
  const newId = crypto.randomBytes(8).toString('hex');
  const metadata = req.header('X-File-Metadata');
  const auth = req.header('Authorization');
  if (!metadata || !auth) {
    return res.sendStatus(400);
  }
  const owner = crypto.randomBytes(10).toString('hex');
  const meta = {
    owner,
    metadata,
    auth: auth.split(' ')[1],
    nonce: crypto.randomBytes(16).toString('base64')
  };

  let reserved = false;
  try {
    // legacy endpoint: no declared size, so the normal-mode limit applies
    const maxEncrypted = encryptedSize(config.large_file_threshold);
    const reservation = await usage.reserve(newId, {
      encryptedBytes: maxEncrypted,
      large: false,
      expireSeconds: config.default_expire_seconds
    });
    if (!reservation.ok) {
      return res.sendStatus(507);
    }
    reserved = true;
    const limiter = new Limiter(maxEncrypted);
    const fileStream = req.pipe(limiter);
    //this hasn't been updated to expiration time setting yet
    //if you want to fallback to this code add this
    await storage.set(newId, fileStream, meta, config.default_expire_seconds);
    await usage.commit(newId, limiter.length, config.default_expire_seconds);
    reserved = false;
    const url = `${config.deriveBaseUrl(req)}/download/${newId}/`;
    res.set('WWW-Authenticate', `send-v1 ${meta.nonce}`);
    res.json({
      url,
      owner: meta.owner,
      id: newId
    });
  } catch (e) {
    if (reserved) {
      try {
        await usage.release(newId);
      } catch (err) {
        log.error('release', err);
      }
    }
    if (e.message === 'limit') {
      return res.sendStatus(413);
    }
    log.error('upload', e);
    res.sendStatus(500);
  }
};
