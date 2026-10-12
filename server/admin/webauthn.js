const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createWebAuthn(cfg) {
  // challengeId -> { challenge, purpose, owner, exp }（単回使用、メモリ保持）
  const challenges = new Map();

  function put(challenge, purpose, owner) {
    const now = Date.now();
    for (const [k, v] of challenges) {
      if (v.exp <= now) {
        challenges.delete(k);
      }
    }
    const id = crypto.randomBytes(16).toString('hex');
    challenges.set(id, {
      challenge,
      purpose,
      owner,
      exp: now + CHALLENGE_TTL_MS
    });
    return id;
  }

  function take(id, purpose, owner) {
    const v = challenges.get(id);
    challenges.delete(id);
    if (!v || v.exp <= Date.now() || v.purpose !== purpose) {
      return null;
    }
    if (v.owner !== owner) {
      return null;
    }
    return v.challenge;
  }

  const idToBuf = id => Buffer.from(id, 'base64url');

  return {
    async registrationOptions(admin, owner) {
      const options = await generateRegistrationOptions({
        rpName: cfg.rpName,
        rpID: cfg.rpID,
        userID: admin.webauthnUserId,
        userName: 'admin',
        attestationType: 'none',
        excludeCredentials: (admin.passkeys || []).map(p => ({
          id: idToBuf(p.id),
          type: 'public-key',
          transports: p.transports
        })),
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        }
      });
      return { challengeId: put(options.challenge, 'reg', owner), options };
    },

    // 成功時 { id, publicKey, counter, transports } を返す。失敗時 null。
    async verifyRegistration(challengeId, response, owner) {
      const expectedChallenge = take(challengeId, 'reg', owner);
      if (!expectedChallenge) {
        return null;
      }
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpID,
        requireUserVerification: true
      });
      if (!v.verified || !v.registrationInfo) {
        return null;
      }
      const info = v.registrationInfo;
      return {
        id: Buffer.from(info.credentialID).toString('base64url'),
        publicKey: Buffer.from(info.credentialPublicKey).toString('base64url'),
        counter: info.counter,
        transports:
          response.response && Array.isArray(response.response.transports)
            ? response.response.transports
            : undefined
      };
    },

    async authenticationOptions(owner) {
      // discoverable credential 前提（allowCredentials は空）
      const options = await generateAuthenticationOptions({
        rpID: cfg.rpID,
        userVerification: 'required'
      });
      return { challengeId: put(options.challenge, 'auth', owner), options };
    },

    // 成功時 { passkey, newCounter } を返す。失敗時 null。
    async verifyAuthentication(challengeId, response, admin, owner) {
      const expectedChallenge = take(challengeId, 'auth', owner);
      if (!expectedChallenge || !response || typeof response.id !== 'string') {
        return null;
      }
      const passkey = (admin.passkeys || []).find(p => p.id === response.id);
      if (!passkey) {
        return null;
      }
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpID,
        requireUserVerification: true,
        authenticator: {
          credentialID: idToBuf(passkey.id),
          credentialPublicKey: idToBuf(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports
        }
      });
      if (!v.verified) {
        return null;
      }
      return { passkey, newCounter: v.authenticationInfo.newCounter };
    }
  };
}

module.exports = { createWebAuthn };
