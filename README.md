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
npm run db:seed      # 開発用DBを作り、ダミーデータを入れる
npm run app:install  # 画面（Next.js）の部品を入れる
npm run dev          # http://localhost:3000 で画面が開く
```

画面の例（ダミーデータ）

- ログイン：http://localhost:3000 を開くとログイン画面になる。開発中は「代表 としてログイン」（開発用ログイン）で入れる
- 個体トレース：http://localhost:3000/trace/ZB-2609-0118
- 仕入れ・入荷：http://localhost:3000/purchases →「仕入れを登録する」で明細を入れ、次の画面で箱のシリアルを入れて Enter（バーコードリーダーでも同じ）。元箱を保管する部品（GPU・メモリ・電源）は棚番も入れる。発送の連絡が来たら追跡番号を登録しておくと、荷物が届いたときに一覧の上の欄で送り状のバーコードを読むだけでその仕入れが開く
- メールから仕入れの下書き：「仕入れ」→「下書き」で、ドスパラ・Joshin web・Amazon.co.jp の注文確認メールの本文を貼り付けると明細を読み取る。部品を選んで確定すると仕入れになり、選んだ型番は次から自動で選ばれる
- 書類：`npm run docs:samples` でダミーの領収書などを取り込みフォルダ（`inbox`）に置き、画面の「書類」→「取り込みフォルダから取り込む」。注文番号が書いてあれば仕入れに自動でひもづく。日付・金額を入れて「確認済みにする」
- 組立：組立台の端末を登録してから、名前とPINで入る（下の「組立用の端末を試す」）。代表のままでも http://localhost:3000/assembly から使える。`ZB-2610-0045` を開いて `PS85-2301` と `KEY-ZZ9P` を入力すると組立が完了する

## ログインのしくみ

| 人 | 入り方 | 使える画面 |
| --- | --- | --- |
| 代表・社員 | 会社の Google アカウント（Workspace）。2段階認証は Workspace の管理画面で必須にする | 役割に合わせて全部 |
| バイト | 代表が登録した組立用の端末で、名前を押して4桁のPIN。メールアドレスは作らない | 組立だけ（12時間で自動ログアウト） |

- 組立用の端末の登録：代表が自分のPCで「設定 → 組立用の端末」で登録コード（8桁・10分有効）を出し、組立台の端末で `/login/device` を開いて入れる。共用の端末で代表が Google にログインする必要はない
- PINを5回続けて間違えるとロック。「設定 → バイトとPIN」で解除・決め直し・バイトの追加・辞めた人の停止ができる
- 端末をなくしたら「設定 → 組立用の端末」で無効にする。その端末のログインはすべて切れる

### 組立用の端末を試す（開発中）

1. PCのブラウザで「代表 としてログイン」→「設定 → 組立用の端末」→ 名前を付けて「登録コードを出す」
2. 別のブラウザ（またはシークレットウィンドウ）で http://localhost:3000/login/device を開き、コードを入れる
3. 名前を押してPINを入れる。ダミーのPINは **佐藤 = 1357、高橋 = 2468**

同じWi-Fiのスマホから試すときは、PCのIPアドレス（例 `http://192.168.1.10:3000`）で開く。

### ログインの準備（Google、最初に1回）

開発用ログイン（`app/.env.local` の `ZB_DEV_LOGIN=1`。`npm run db:seed` が書き込む）は `npm run dev` のときだけ動き、本番のビルドでは出ません。本物の Google ログインを使うには:

1. Google Cloud コンソールでプロジェクトを選び、「APIとサービス → OAuth 同意画面」を **内部（Internal）** で作る（会社の Workspace の人しか使えなくなる）
2. 「認証情報 → 認証情報を作成 → OAuth クライアント ID」で、種類は **ウェブ アプリケーション**、承認済みのリダイレクト URI に `http://localhost:3000/auth/callback` を入れる（本番を作るときは本番のURLも足す）
3. 出てきたクライアント ID とシークレットを `app/.env.local` に書く（見本は `app/.env.example`。git には入らない）

   ```
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxx
   AUTH_ALLOWED_DOMAIN=会社のドメイン（例 zerobit.co.jp）
   APP_URL=http://localhost:3000
   ```
4. 自分のアカウントを登録する（ダミーの代表のメールを自分のものに替える）

   ```sh
   npm run db:psql
   UPDATE core.users SET email = 'あなた@会社のドメイン' WHERE email = 'owner@zerobit.example';
   ```
   `npm run db:seed` をやり直すとダミーに戻るので、そのときはもう一度実行する
5. Google Workspace の管理コンソールで、2段階認証プロセスを「適用」にする
6. `npm run dev` を起動し直して「Googleでログイン」

## よく使うコマンド

| コマンド | すること |
| --- | --- |
| `npm run db:up` | PostgreSQL を起動する |
| `npm run db:down` | PostgreSQL を止める（データは残る） |
| `npm run db:test` | テスト用DBを作り直して、マイグレーションとテストを流す |
| `npm run db:reset` | 開発用DB（zerobit）を作り直して、マイグレーションを流す（空） |
| `npm run db:seed` | 開発用DBを作り直して、ダミーデータを入れる |
| `npm test` | アプリのテスト（テスト用DBを作り直してから流す） |
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
