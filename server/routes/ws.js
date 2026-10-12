const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const Limiter = require('../limiter');
const fxa = require('../fxa');
const usage = require('../usage');
const { encryptedSize } = require('../../app/utils');

const { Transform } = require('stream');

const log = mozlog('send.upload');

// number of large uploads currently holding a slot
let activeLargeUploads = 0;

module.exports = function(ws, req) {
  let fileStream;
  let reservedId = null;
  let holdsLargeSlot = false;
  let idleTimer = null;
  let aborted = false;
  let receivedBytes = 0;

  function releaseLargeSlot() {
    if (holdsLargeSlot) {
      holdsLargeSlot = false;
      activeLargeUploads--;
    }
  }

  function stopIdleTimer() {
    if (idleTimer !== null) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  async function releaseReservation() {
    if (reservedId) {
      const id = reservedId;
      reservedId = null;
      try {
        await usage.release(id);
      } catch (err) {
        log.error('release', err);
      }
    }
  }

  // Closes uploads that do not send enough data per window, so that a
  // declared (and reserved) size cannot be held forever.
  function startIdleTimer() {
    const windowMs = config.upload_idle_timeout_seconds * 1000;
    const minBytes = config.upload_min_bytes_per_window;
    let lastBytes = receivedBytes;
    idleTimer = setInterval(() => {
      if (receivedBytes - lastBytes >= minBytes) {
        lastBytes = receivedBytes;
        return;
      }
      log.warn('upload idle timeout', reservedId);
      aborted = true;
      stopIdleTimer();
      releaseLargeSlot();
      if (fileStream !== undefined) {
        fileStream.destroy(new Error('idle'));
      }
      releaseReservation();
      try {
        ws.terminate ? ws.terminate() : ws.close();
      } catch (err) {
        log.error('idle close', err);
      }
    }, windowMs);
  }

  ws.on('close', e => {
    stopIdleTimer();
    releaseLargeSlot();
    if (e !== 1000 && fileStream !== undefined) {
      fileStream.destroy();
    }
  });

  ws.on('message', data => {
    // counted only after the first message (see below)
    if (idleTimer !== null && data && data.length !== undefined) {
      receivedBytes += data.length;
    }
  });

  ws.once('message', async function(message) {
    startIdleTimer();
    try {
      const newId = crypto.randomBytes(8).toString('hex');
      const owner = crypto.randomBytes(10).toString('hex');

      const fileInfo = JSON.parse(message);
      const largeThreshold = config.large_file_threshold;
      const largeMaxFileSize = config.max_file_size;
      const fileSize = fileInfo.fileSize;
      const hasFileSize = fileSize !== undefined && fileSize !== null;
      if (
        hasFileSize &&
        (typeof fileSize !== 'number' ||
          !Number.isFinite(fileSize) ||
          fileSize < 0)
      ) {
        ws.send(JSON.stringify({ error: 400 }));
        return ws.close();
      }
      if (hasFileSize && fileSize > largeMaxFileSize) {
        ws.send(JSON.stringify({ error: 413 }));
        return ws.close();
      }
      const isLarge = hasFileSize && fileSize > largeThreshold;
      // large uploads always get the fixed (short) expiry
      const timeLimit = isLarge
        ? config.large_expire_seconds
        : fileInfo.timeLimit || config.default_expire_seconds;
      const dlimit = fileInfo.dlimit || config.default_downloads;
      const metadata = fileInfo.fileMetadata;
      const auth = fileInfo.authorization;
      const user = await fxa.verify(fileInfo.bearer);
      const maxExpireSeconds = config.max_expire_seconds;
      const maxDownloads = config.max_downloads;

      if (config.fxa_required && !user) {
        ws.send(
          JSON.stringify({
            error: 401
          })
        );
        return ws.close();
      }
      if (
        !metadata ||
        !auth ||
        timeLimit <= 0 ||
        (!isLarge && timeLimit > maxExpireSeconds) ||
        dlimit > maxDownloads
      ) {
        ws.send(
          JSON.stringify({
            error: 400
          })
        );
        return ws.close();
      }

      const meta = {
        owner,
        metadata,
        dlimit,
        auth: auth.split(' ')[1],
        nonce: crypto.randomBytes(16).toString('base64')
      };

      // upper bound of what we accept (and reserve) for this upload
      const maxEncrypted = encryptedSize(
        hasFileSize ? fileSize : largeThreshold
      );
      if (aborted) {
        return;
      }
      if (isLarge) {
        if (activeLargeUploads >= config.max_concurrent_large_uploads) {
          ws.send(JSON.stringify({ error: 507 }));
          return ws.close();
        }
        // no await between check and increment
        activeLargeUploads++;
        holdsLargeSlot = true;
      }
      const reservation = await usage.reserve(newId, {
        encryptedBytes: maxEncrypted,
        large: isLarge,
        expireSeconds: timeLimit
      });
      if (!reservation.ok) {
        ws.send(JSON.stringify({ error: 507 }));
        return ws.close();
      }
      reservedId = newId;
      if (aborted) {
        // timed out while reserving
        await releaseReservation();
        return;
      }

      const url = `${config.deriveBaseUrl(req)}/download/${newId}/`;

      ws.send(
        JSON.stringify({
          url,
          ownerToken: meta.owner,
          id: newId
        })
      );
      const limiter = new Limiter(maxEncrypted);
      const eof = new Transform({
        transform: function(chunk, encoding, callback) {
          if (chunk.length === 1 && chunk[0] === 0) {
            this.push(null);
          } else {
            this.push(chunk);
          }
          callback();
        }
      });
      const wsStream = ws.constructor.createWebSocketStream(ws);

      fileStream = wsStream.pipe(eof).pipe(limiter); // limiter needs to be the last in the chain

      await storage.set(newId, fileStream, meta, timeLimit);
      if (aborted) {
        throw new Error('idle');
      }
      await usage.commit(newId, limiter.length, timeLimit);
      reservedId = null;

      if (ws.readyState === 1) {
        // if the socket is closed by a cancelled upload the stream
        // ends without an error so we need to check the state
        // before sending a reply.

        // TODO: we should handle cancelled uploads differently
        // in order to avoid having to check socket state and clean
        // up storage, possibly with an exception that we can catch.
        ws.send(JSON.stringify({ ok: true }));
      }
    } catch (e) {
      log.error('upload', e);
      await releaseReservation();
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            error: e === 'limit' || (e && e.message === 'limit') ? 413 : 500
          })
        );
      }
    } finally {
      stopIdleTimer();
      releaseLargeSlot();
    }
    ws.close();
  });
};
