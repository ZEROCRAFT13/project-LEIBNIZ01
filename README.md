# project-LEIBNIZ01（ZERO-BIT 基幹システム）

Amazon.co.jp（FBA）を主軸にPCを組立・販売する会社の基幹システムです。
要件は [docs/spec.md](docs/spec.md)、開発のルールは [CLAUDE.md](CLAUDE.md) にあります。

## はじめての準備（Windows）

1. 次の3つをインストールする
   - Git（Git for Windows）
   - Node.js 22 以上（LTS版）
   - Docker Desktop（インストール後に一度起動しておく）
2. このフォルダで、`.env.example` をコピーして `.env` という名前にする
   （中の `POSTGRES_PASSWORD` は自分のパソコンだけで使う値に変えてよい）
3. 次を順に実行する（PowerShell でも Claude Code に頼んでもよい）

```sh
npm run db:up        # Docker で PostgreSQL 16 を起動
npm run db:test      # マイグレーションとテストを流す → 最後に「ALL TESTS PASSED」
npm run db:reset     # 開発用DBを作る
npm run app:install  # 画面（Next.js）の部品を入れる
npm run dev          # http://localhost:3000 で画面が開く
```

## よく使うコマンド

| コマンド | すること |
| --- | --- |
| `npm run db:up` | PostgreSQL を起動する |
| `npm run db:down` | PostgreSQL を止める（データは残る） |
| `npm run db:test` | テスト用DBを作り直して、マイグレーションとテストを流す |
| `npm run db:reset` | 開発用DB（zerobit）を作り直して、マイグレーションを流す |
| `npm run db:psql` | 開発用DBに psql でつなぐ |
| `npm run dev` | 画面を開発モードで起動する |
| `npm run build` | 画面を本番用にビルドする |
| `npm run lint` | コードの書き方をチェックする |

## フォルダ

| フォルダ | 中身 |
| --- | --- |
| `app/` | Next.js（画面とAPI） |
| `db/` | データベースの定義とテスト（[db/README.md](db/README.md)） |
| `docs/` | 要件定義書 |
| `scripts/` | 開発用のスクリプト |
