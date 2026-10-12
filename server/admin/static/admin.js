/* eslint-env browser */
(function() {
  'use strict';

  // data-confirm 付きフォームは送信前に確認する
  document.addEventListener('submit', function(e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) {
      e.preventDefault();
    }
  });

  function status(text, isError) {
    var el = document.getElementById('passkey-status');
    if (el) {
      el.textContent = text;
      el.className = 'msg ' + (isError ? 'err' : 'ok');
    }
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function(r) {
      return r.json().then(function(j) {
        if (!r.ok) {
          throw new Error(j.error || 'エラーが発生しました');
        }
        return j;
      });
    });
  }

  var lib = window.SimpleWebAuthnBrowser;

  var loginBtn = document.getElementById('passkey-login');
  if (loginBtn && lib) {
    loginBtn.addEventListener('click', function() {
      var challengeId;
      status('認証中...', false);
      post('/login/passkey/options')
        .then(function(r) {
          challengeId = r.challengeId;
          return lib.startAuthentication(r.options);
        })
        .then(function(resp) {
          return post('/login/passkey/verify', {
            challengeId: challengeId,
            response: resp
          });
        })
        .then(function() {
          window.location.href = '/';
        })
        .catch(function(err) {
          status(err.message || 'ログインに失敗しました', true);
        });
    });
  }

  var regBtn = document.getElementById('passkey-register');
  if (regBtn && lib) {
    regBtn.addEventListener('click', function() {
      var nameEl = document.getElementById('passkey-name');
      var name = nameEl ? nameEl.value.trim() : '';
      var curEl = document.getElementById('passkey-current');
      var current = curEl ? curEl.value : '';
      if (!name) {
        status('パスキーの名前を入力してください', true);
        return;
      }
      if (!current) {
        status('現在のパスワードを入力してください', true);
        return;
      }
      var challengeId;
      status('登録中...', false);
      post('/security/passkey/options', { current: current })
        .then(function(r) {
          challengeId = r.challengeId;
          return lib.startRegistration(r.options);
        })
        .then(function(resp) {
          return post('/security/passkey/verify', {
            challengeId: challengeId,
            name: name,
            current: current,
            response: resp
          });
        })
        .then(function() {
          window.location.reload();
        })
        .catch(function(err) {
          status(err.message || '登録に失敗しました', true);
        });
    });
  }
})();
