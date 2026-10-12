# ぶいちゃ便！ (sendbuichajp)

ぶいちゃ便！ (send.buicha.jp) は [timvisee/send](https://github.com/timvisee/send) を改変したものです。
ライセンスは MPL-2.0 です（[LICENSE](LICENSE) / [NOTICE.md](NOTICE.md)）。

上流は Mozilla の Firefox Send をコミュニティが維持しているフォークで、エンドツーエンド暗号化でファイルを共有できます。

## 主な変更点

- デザイン刷新・日本語化
- 大容量モード: 10 GiB 超〜300 GiB のファイルを送信可能（有効期限は 24 時間固定）
- 保存容量 2TB の上限と、残容量が足りないときの大容量モード自動停止
- 期限切れファイルの掃除（S3 実体も削除）
- LAN 限定の管理画面（パスワード + TOTP + パスキー）
- 利用規約・プライバシーポリシーページ

## 要件

- Node.js 16.x
- Redis
- S3 互換ストレージ

## 環境変数

上流の全設定は [server/config.js](server/config.js) を参照してください。ここでは本フォークで追加・変更したものを示します。

### 大容量・容量管理

| 変数 | 既定値 | 説明 |
|---|---|---|
| `MAX_FILE_SIZE` | `322122547200` | 1 アップロードの最大サイズ (300 GiB) |
| `BUICHA_LARGE_FILE_THRESHOLD` | `10737418240` | 大容量扱いになる閾値 (10 GiB) |
| `BUICHA_LARGE_EXPIRE_SECONDS` | `86400` | 大容量ファイルの有効期限 (秒) |
| `BUICHA_STORAGE_QUOTA_BYTES` | `2000000000000` | 全体保存量の上限 (2TB) |
| `BUICHA_SWEEP_INTERVAL_SECONDS` | `600` | 掃除処理の間隔 (秒) |
| `BUICHA_SWEEP_ORPHAN_MIN_AGE_SECONDS` | `691200` | 追跡外 S3 オブジェクトを削除する最小経過時間 (8 日) |
| `BUICHA_UPLOAD_IDLE_TIMEOUT_SECONDS` | `60` | この時間内に `BUICHA_UPLOAD_MIN_BYTES_PER_WINDOW` 以上の受信が無いアップロードは切断し、予約を解放 |
| `BUICHA_UPLOAD_MIN_BYTES_PER_WINDOW` | `1048576` | 上記の時間内に必要な最小受信バイト数 (1 MiB) |
| `BUICHA_MAX_CONCURRENT_LARGE_UPLOADS` | `3` | 大容量アップロードの同時実行数の上限 |
| `BUICHA_RECONCILE_INTERVAL_SECONDS` | `21600` | 既存 S3 オブジェクトの追跡登録を再実行する間隔 (秒、6 時間) |
| `BUICHA_SWEEP_ORPHAN_MAX_PER_RUN` | `50` | 1 回の掃除で孤立オブジェクト候補がこの数を超えた場合は削除を中止して警告（redis 消失時の安全弁） |
| `BUICHA_SWEEP_ORPHAN_DRY_RUN` | `false` | `true` にすると孤立オブジェクトを削除せずログのみ出力 |

### フッター

| 変数 | 既定値 | 説明 |
|---|---|---|
| `FOOTER_SOURCE_URL` | `https://github.com/kazunamine/sendbuichajp` | フッターに表示するソースコードの URL |

### 管理画面

| 変数 | 既定値 | 説明 |
|---|---|---|
| `ADMIN_ENABLED` | `false` | 管理画面を有効化 |
| `ADMIN_PORT` | `2526` | 管理画面のポート |
| `ADMIN_LISTEN_ADDRESS` | `0.0.0.0` | 待ち受けアドレス |
| `ADMIN_MODE` | `lan` | `lan`（IP 制限のみ）または `cloudflare-access`（Cloudflare Access の JWT を毎回検証） |
| `ADMIN_ALLOWED_CIDRS` | `127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8` | 接続を許可する CIDR（`lan` モードのみ。`cloudflare-access` では使いません） |
| `ADMIN_TRUSTED_PROXIES` | (空) | X-Forwarded-For を信用するプロキシ IP（`cloudflare-access` では接続を許可する唯一の接続元で必須） |
| `ADMIN_CF_ACCESS_TEAM_DOMAIN` | (空) | Access のチームドメイン 例 `buicha.cloudflareaccess.com`（`https://` 有無どちらでも可）。`cloudflare-access` で必須 |
| `ADMIN_CF_ACCESS_AUD` | (空) | Access アプリの AUD タグ（カンマ区切りで複数可）。`cloudflare-access` で必須 |
| `ADMIN_CF_ACCESS_EMAILS` | (空) | 許可するメールアドレス（カンマ区切り、大文字小文字無視）。`cloudflare-access` で必須 |
| `ADMIN_RP_ID` | `send-admin.buicha.jp` | パスキーの RP ID |
| `ADMIN_ORIGIN` | `https://send-admin.buicha.jp` | 管理画面のオリジン |
| `ADMIN_SESSION_SECRET` | (必須) | セッション署名用の秘密値。未設定だと管理画面は起動しません |
| `ADMIN_SETUP_TOKEN` | (空) | 初回セットアップ用トークン。管理者未作成時のみ有効 |
| `ADMIN_DATA_DIR` | `/app/admin-data` | 管理者資格情報の保存先（ボリューム必須） |

## ビルドと起動

```sh
# Docker (例: docker-compose.yml の change-me / your-* を置き換えてから)
docker compose up -d --build

# イメージのみビルド
docker build -t sendbuichajp .
```

GitHub Actions が `ghcr.io/kazunamine/sendbuichajp` にイメージを公開します。
公開アプリは容器内 1443、管理画面は 2526 です（compose 例では 2525:1443 と 2526:2526）。
`/app/admin-data` は必ずボリュームにしてください。

## 管理画面の公開方法の注意

- 管理画面は LAN 専用のホスト名（例: `send-admin.buicha.jp` を LAN 内 DNS で解決）で提供してください。
- パスキー (WebAuthn) は安全なコンテキストが必要なため、HTTPS 必須です。`ADMIN_RP_ID` と `ADMIN_ORIGIN` はそのホスト名に合わせてください。
- インターネット公開側のリバースプロキシに 2526 を出さないでください。
- プロキシ経由の場合は `ADMIN_TRUSTED_PROXIES` にそのプロキシの IP のみを指定してください。

## Cloudflare Access モード（ゼロトラスト）

`ADMIN_MODE=cloudflare-access` では、LAN の IP を信頼せず、Cloudflare Access が発行する JWT（`Cf-Access-Jwt-Assertion` ヘッダ）を毎リクエスト検証します。

構成: ブラウザ → Cloudflare Access（Google ログイン＋メール＋自宅 IP）→ Cloudflare Tunnel（nas の cloudflared）→ `192.168.1.150:2526`

動作:

1. 接続元が `ADMIN_TRUSTED_PROXIES`（cloudflared のホスト IP。例 `192.168.1.100`）以外なら 403。LAN からの直アクセスも拒否します。`ADMIN_ALLOWED_CIDRS` は使いません（IP 条件は Access 側で行います）。
2. `Cf-Access-Jwt-Assertion` ヘッダのみを信頼します（`CF_Authorization` Cookie は使いません）。無ければ 403。
3. RS256 のみ許可。`https://<チームドメイン>/cdn-cgi/access/certs` の公開鍵で署名を検証し（キャッシュ 10 分、未知の kid のときのみ再取得で最短 30 秒間隔、取得失敗は拒否）、`iss` / `aud` / `exp` / `nbf` / `iat` / `email` を検証します。
4. 検証後も、既存のアプリ認証（パスワード＋TOTP / パスキー）を引き続き要求します（二重の認証）。
5. レート制限・ログ用のクライアント IP は `Cf-Connecting-IP`（信頼プロキシ経由のみ）を使います。
6. 管理画面ヘッダに `Cloudflare: <メール>` と、Access 側のログアウト（同一ホストの `/cdn-cgi/access/logout`）へのリンクを表示します。
7. `TEAM_DOMAIN` / `AUD` / `EMAILS` / `TRUSTED_PROXIES` のいずれかが空だと管理画面は起動しません。

Cloudflare 側の設定:

- Zero Trust > Networks > Tunnels で、cloudflared の Public hostname（例 `send-admin.buicha.jp`）を `http://192.168.1.150:2526` に向ける。
- Zero Trust > Access > Applications で上記ホスト名の Self-hosted アプリを作成し、AUD タグ（アプリの設定画面の Overview > Application Audience (AUD) Tag）を `ADMIN_CF_ACCESS_AUD` に設定する。チームドメインは Zero Trust の Settings > Custom Pages 等に表示される `<team>.cloudflareaccess.com`。
- Access ポリシー（Allow）: 認証方法は Google ログイン、Include に許可するメール、Require に自宅の IP（Selectors > IP ranges）を設定する。
- `ADMIN_ORIGIN` / `ADMIN_RP_ID` は公開ホスト名に合わせる（パスキーと CSRF 対策のため）。

## 運用上の注意

- redis は必ず永続化してください（`appendonly yes` とボリューム）。redis が消えると全ファイルがダウンロード不能になり、S3 上の実体は孤立オブジェクトとして掃除対象になります。
- `ADMIN_SETUP_TOKEN` は初回セットアップ完了後に環境変数から削除してください。推測困難な長いランダム値を使ってください（例: `openssl rand -hex 32`）。
- `ADMIN_SESSION_SECRET` は 32 文字以上が必須です。
- `admin-data` を bind mount する場合は、コンテナの app ユーザー (uid 1000) が書き込める権限にしてください。
- `ADMIN_TRUSTED_PROXIES` にはリバースプロキシの IP を必ず設定してください。プロキシから `X-Forwarded-For` が来ない場合、管理画面は 403 になります。

## 開発

```sh
npm install
npm start     # http://localhost:8080
```

| コマンド | 説明 |
|---|---|
| `npm run lint` | CSS / JS の lint |
| `npm run test:backend` | バックエンドテスト |
| `npm run build` | 本番アセットのビルド |
| `npm run prod` | 本番設定で起動 |

上流のドキュメント: [docs/](docs/)

## ライセンス

[Mozilla Public License 2.0](LICENSE)。改変の概要は [NOTICE.md](NOTICE.md) を参照してください。
上流: https://github.com/timvisee/send ／ [qrcode.js](https://github.com/kazuhikoarase/qrcode-generator) は MIT。
