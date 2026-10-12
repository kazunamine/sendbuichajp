# NOTICE

ぶいちゃ便！ (https://send.buicha.jp) は [timvisee/send](https://github.com/timvisee/send)（v3.4.27 ベース、
元は Mozilla Firefox Send）を改変したものです。Mozilla Public License 2.0 (MPL-2.0) の下で配布されています。

## 改変者

kazunamine / Buicha.jp

## 主な改変箇所

- フロントエンド（`app/`, `public/`）: デザイン刷新、日本語化、自前ホストのフォント
- 大容量モード（10 GiB 超〜300 GiB、有効期限 24 時間固定）と、クライアントからのファイルサイズ通知
- 保存容量 2TB の上限管理と、残容量不足時の自動停止（`server/usage.js`, `server/storage/`）
- 期限切れ・削除済みファイルの S3 実体を削除する掃除処理（`server/sweeper.js`）
- LAN 限定の管理画面（パスワード + TOTP + パスキー）（`server/admin/`）
- 利用規約・プライバシーポリシーページ（`app/legal/`, `server/routes/`）
- `Dockerfile`、GitHub Actions、`docker-compose.yml`、`README.md` の更新

正確な差分は、本リポジトリの git 履歴と上流との比較で確認できます。

## ソースコードの入手先

- 本改変版: https://github.com/kazunamine/sendbuichajp （`buicha` ブランチ）
- 上流: https://github.com/timvisee/send

## ライセンス

MPL-2.0。全文は [LICENSE](LICENSE) を参照してください。
同梱のサードパーティ素材（フォントは OFL など）はそれぞれのライセンスに従います。
