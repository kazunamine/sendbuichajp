// サーバレンダリングの素朴な HTML。ユーザ由来の値は必ず esc() を通す。
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}

function formatTime(t) {
  if (typeof t !== 'number' || !isFinite(t) || t <= 0) {
    return '-';
  }
  // 秒/ミリ秒どちらでも表示できるようにする
  const ms = t < 1e11 ? t * 1000 : t;
  return new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function layout({ title, body, nav, message, error, scripts }) {
  const navHtml = nav
    ? `<nav><a href="/">ダッシュボード</a><a href="/files">ファイル一覧</a><a href="/security">セキュリティ設定</a>
<form method="post" action="/logout" class="inline"><button type="submit" class="link">ログアウト</button></form></nav>`
    : '';
  const msg = message ? `<p class="msg ok">${esc(message)}</p>` : '';
  const err = error ? `<p class="msg err">${esc(error)}</p>` : '';
  const scriptTags = (scripts || [])
    .concat(['/static/admin.js'])
    .map(s => `<script src="${esc(s)}"></script>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} - ぶいちゃ便 管理</title>
<link rel="stylesheet" href="/static/admin.css">
</head>
<body>
<header><h1>ぶいちゃ便 管理画面</h1>${navHtml}</header>
<main>
<h2>${esc(title)}</h2>
${msg}${err}
${body}
</main>
${scriptTags}
</body>
</html>`;
}

function setupPage({ error, minLen }) {
  return layout({
    title: '初期セットアップ',
    error,
    body: `<p>管理者アカウントを作成します。セットアップトークンとパスワードを入力し、次の画面で2段階認証(TOTP)を登録してください。</p>
<form method="post" action="/setup">
<label>セットアップトークン<input type="password" name="token" autocomplete="off" required></label>
<label>パスワード(${esc(
      minLen
    )}文字以上)<input type="password" name="password" autocomplete="new-password" minlength="${esc(
      minLen
    )}" required></label>
<label>パスワード(確認)<input type="password" name="password2" autocomplete="new-password" required></label>
<button type="submit">次へ</button>
</form>`
  });
}

function totpEnrollBlock({ qrDataUrl, secret, action, extra }) {
  return `<p>認証アプリ(Google Authenticator 等)で QR を読み取り、表示される6桁のコードを入力してください。</p>
<p><img class="qr" src="${esc(
    qrDataUrl
  )}" alt="TOTP 登録用 QR コード" width="240" height="240"></p>
<p>読み取れない場合の手入力用キー: <code>${esc(secret)}</code></p>
<form method="post" action="${esc(action)}">
${extra || ''}
<label>6桁のコード<input name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" required></label>
<button type="submit">登録を完了</button>
</form>`;
}

function setupTotpPage({ qrDataUrl, secret, error }) {
  return layout({
    title: '初期セットアップ: 2段階認証の登録',
    error,
    body: totpEnrollBlock({ qrDataUrl, secret, action: '/setup/totp' })
  });
}

function loginPage({ error, hasPasskeys }) {
  const passkey = hasPasskeys
    ? `<hr><h3>パスキーでログイン</h3>
<p><button type="button" id="passkey-login">パスキーでログイン</button></p>
<p id="passkey-status" class="msg"></p>`
    : '';
  return layout({
    title: 'ログイン',
    error,
    scripts: hasPasskeys ? ['/static/simplewebauthn-browser.js'] : [],
    body: `<form method="post" action="/login">
<label>パスワード<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">次へ(2段階認証)</button>
</form>${passkey}`
  });
}

function loginTotpPage({ error }) {
  return layout({
    title: 'ログイン: 2段階認証',
    error,
    body: `<form method="post" action="/login/totp">
<label>認証アプリの6桁コード<input name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" autofocus required></label>
<button type="submit">ログイン</button>
</form>
<p><a href="/login">最初からやり直す</a></p>`
  });
}

function postButton(action, label, fields, opts = {}) {
  const hidden = Object.keys(fields || {})
    .map(
      k => `<input type="hidden" name="${esc(k)}" value="${esc(fields[k])}">`
    )
    .join('');
  const confirm = opts.confirm ? ` data-confirm="${esc(opts.confirm)}"` : '';
  const pw = opts.reauth
    ? '<input type="password" name="current" autocomplete="current-password" placeholder="現在のパスワード" aria-label="現在のパスワード" required> '
    : '';
  return `<form method="post" action="${esc(
    action
  )}" class="inline"${confirm}>${hidden}${pw}<button type="submit"${
    opts.danger ? ' class="danger"' : ''
  }>${esc(label)}</button></form>`;
}

function dashboardPage({ capacity, message, error, s3Usage, sweepResult }) {
  const c = capacity;
  const pct =
    c.quotaBytes > 0
      ? Math.min(100, Math.max(0, (c.usedBytes / c.quotaBytes) * 100))
      : 0;
  const s3 = s3Usage
    ? `<p>S3 実測: ${esc(s3Usage.objects)} オブジェクト / ${esc(
        formatBytes(s3Usage.bytes)
      )} (${esc(s3Usage.bytes)} bytes)</p>`
    : '';
  const sweep =
    sweepResult === undefined || sweepResult === null
      ? ''
      : `<pre>${esc(
          typeof sweepResult === 'string'
            ? sweepResult
            : JSON.stringify(sweepResult, null, 2)
        )}</pre>`;
  const effective = c.largeModeEnabled ? '有効(受付中)' : '無効(停止中)';
  return layout({
    title: 'ダッシュボード',
    nav: true,
    message,
    error,
    body: `<section>
<h3>保存容量</h3>
<p>${esc(formatBytes(c.usedBytes))} / ${esc(formatBytes(c.quotaBytes))} (${esc(
      pct.toFixed(1)
    )}%)</p>
<progress max="100" value="${esc(pct.toFixed(1))}"></progress>
<p>残容量: ${esc(formatBytes(c.remainingBytes))} / 新規アップロード: ${
      c.uploadsAccepted ? '受付中' : '停止中'
    }</p>
${s3}
${postButton('/action/s3-usage', 'S3 実測(重い処理)', {})}
</section>
<section>
<h3>大容量モード(${esc(formatBytes(c.normalMaxFileSize))} 超〜${esc(
      formatBytes(c.largeMaxFileSize)
    )})</h3>
<p>実効状態: <strong>${effective}</strong> / 手動トグル: <strong>${
      c.largeModeManual ? 'ON' : 'OFF'
    }</strong></p>
<p class="note">実効状態は「手動トグルON」かつ「残容量 ≧ 大容量上限」のときのみ有効になります。</p>
${postButton('/action/large-mode', 'ON にする', { enabled: '1' })}
${postButton('/action/large-mode', 'OFF にする', { enabled: '0' })}
</section>
<section>
<h3>掃除</h3>
<p>期限切れ・DL上限到達・削除済みファイルの実体を今すぐ掃除します。</p>
${postButton('/action/sweep', '今すぐ掃除', {})}
${sweep}
</section>`
  });
}

function filesPage({ files, message, error }) {
  const rows = files
    .map(
      f => `<tr>
<td><code>${esc(f.id)}</code></td>
<td class="num">${esc(formatBytes(f.size))}</td>
<td>${esc(formatTime(f.createdAt))}</td>
<td>${esc(formatTime(f.expiresAt))}</td>
<td class="num">${esc(f.dl)} / ${esc(f.dlimit)}</td>
<td>${f.large ? '大容量' : '-'}</td>
<td>${postButton(
        '/files/delete',
        '削除',
        { id: f.id },
        {
          danger: true,
          confirm: `ファイル ${f.id} を削除します。よろしいですか？`
        }
      )}</td>
</tr>`
    )
    .join('\n');
  return layout({
    title: 'ファイル一覧',
    nav: true,
    message,
    error,
    body: `<p class="note">ファイルの内容・ファイル名はエンドツーエンド暗号化されているため、管理画面からは見えません。</p>
<p>${esc(files.length)} 件</p>
<div class="scroll"><table>
<thead><tr><th>ID</th><th>サイズ</th><th>作成</th><th>期限</th><th>DL数/上限</th><th>大容量</th><th></th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">ファイルはありません。</td></tr>'}
</tbody></table></div>`
  });
}

function securityPage({ admin, message, error, totpEnroll, minLen }) {
  const passkeys = (admin.passkeys || [])
    .map(
      p =>
        `<tr><td>${esc(p.name)}</td><td>${esc(
          formatTime(p.createdAt)
        )}</td><td>${postButton(
          '/security/passkey/delete',
          '削除',
          { id: p.id },
          {
            danger: true,
            reauth: true,
            confirm: `パスキー「${p.name}」を削除します。よろしいですか？`
          }
        )}</td></tr>`
    )
    .join('\n');
  const totpBlock = totpEnroll
    ? totpEnrollBlock({
        qrDataUrl: totpEnroll.qrDataUrl,
        secret: totpEnroll.secret,
        action: '/security/totp/confirm'
      })
    : `<form method="post" action="/security/totp/start">
<label>現在のパスワード<input type="password" name="current" autocomplete="current-password" required></label>
<button type="submit">TOTP を再登録</button>
</form>`;
  return layout({
    title: 'セキュリティ設定',
    nav: true,
    message,
    error,
    scripts: ['/static/simplewebauthn-browser.js'],
    body: `<section>
<h3>パスワード変更</h3>
<form method="post" action="/security/password">
<label>現在のパスワード<input type="password" name="current" autocomplete="current-password" required></label>
<label>新しいパスワード(${esc(
      minLen
    )}文字以上)<input type="password" name="password" autocomplete="new-password" minlength="${esc(
      minLen
    )}" required></label>
<label>新しいパスワード(確認)<input type="password" name="password2" autocomplete="new-password" required></label>
<button type="submit">変更</button>
</form>
<p class="note">変更すると他の端末のログインは無効になります。</p>
</section>
<section>
<h3>2段階認証(TOTP)の再登録</h3>
${totpBlock}
</section>
<section>
<h3>パスキー</h3>
<table><thead><tr><th>名前</th><th>登録日時</th><th></th></tr></thead><tbody>
${passkeys || '<tr><td colspan="3">登録されたパスキーはありません。</td></tr>'}
</tbody></table>
<div class="row">
<input id="passkey-name" maxlength="40" placeholder="名前(例: MacBook)">
<input id="passkey-current" type="password" autocomplete="current-password" placeholder="現在のパスワード" aria-label="現在のパスワード">
<button type="button" id="passkey-register">パスキーを登録</button>
</div>
<p id="passkey-status" class="msg"></p>
<p class="note">パスキーの登録・削除には現在のパスワードが必要です。パスキーを削除すると他の端末のログインは無効になります。</p>
</section>
<section>
<h3>全端末からログアウト</h3>
<form method="post" action="/security/logout-all" data-confirm="すべての端末(この端末を含む)からログアウトします。よろしいですか？">
<button type="submit" class="danger">全端末からログアウト</button>
</form>
</section>`
  });
}

// Cloudflare Access モード用: ヘッダに検証済みメールと Access 側ログアウトを表示する。
// email / logoutUrl は必ず esc() を通す。
function injectAccessBanner(html, { email, logoutUrl }) {
  const banner = `<p class="access">Cloudflare: ${esc(email)} <a href="${esc(
    logoutUrl
  )}">Cloudflare からログアウト</a></p>`;
  const i = html.indexOf('</h1>');
  if (i === -1) {
    return html;
  }
  return html.slice(0, i + 5) + banner + html.slice(i + 5);
}

function simplePage(title, text) {
  return layout({ title, body: `<p>${esc(text)}</p>` });
}

module.exports = {
  esc,
  formatBytes,
  formatTime,
  layout,
  injectAccessBanner,
  setupPage,
  setupTotpPage,
  loginPage,
  loginTotpPage,
  dashboardPage,
  filesPage,
  securityPage,
  simplePage
};
