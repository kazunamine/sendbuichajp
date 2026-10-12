const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const config = {
  l10n_dev: false // prod configuration
};
const pkg = {
  availableLanguages: ['ja', 'en-US', 'fr', 'it', 'es-ES']
};

function request(acceptLang) {
  return {
    headers: {
      'accept-language': acceptLang
    }
  };
}

const langMiddleware = proxyquire('../../server/middleware/language', {
  '../config': config,
  '../../package.json': pkg
});

describe('Language Middleware', function() {
  it('defaults to ja when no header is present', function() {
    const req = request();
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'ja');
    sinon.assert.calledOnce(next);
  });

  it('sets req.language to ja when accept-language > 255 chars', function() {
    const accept = Array(257).join('a');
    assert.equal(accept.length, 256);
    const req = request(accept);
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'ja');
    sinon.assert.calledOnce(next);
  });

  it('defaults to ja when no offered language matches', function() {
    const req = request('fa,cs');
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'ja');
    sinon.assert.calledOnce(next);
  });

  it('returns en-US for an English accept-language', function() {
    const req = request('en-US,en;q=0.9');
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'en-US');
    sinon.assert.calledOnce(next);
  });

  it('prefers higher q values between offered languages', function() {
    const req = request('fa;q=0.5, en;q=0.9, ja;q=0.8');
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'en-US');
    sinon.assert.calledOnce(next);
  });

  it('does not offer languages other than ja and en-US', function() {
    const req = request('fr,it,es-MX');
    const next = sinon.stub();
    langMiddleware(req, null, next);
    assert.equal(req.language, 'ja');
    sinon.assert.calledOnce(next);
  });
});
