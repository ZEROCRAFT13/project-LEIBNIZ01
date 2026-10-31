# ZERO-BIT 基幹システム

Amazon.co.jp（FBA）を主軸にPCを月100台組立・販売する会社の基幹システム。
代表1名が全役割を兼任し、組立はアルバイトが行う。
要件は `docs/spec.md`（要件定義書）にある。迷ったら仕様書を優先し、仕様書にないことは作る前に確認する。

## 技術スタック

- TypeScript / Next.js（画面とAPI）
- PostgreSQL 16（Google Cloud SQL、東京。大阪へ複製）
- Google Cloud: Cloud Run、Cloud Storage、Cloud Scheduler、Secret Manager
- ログイン: Googleアカウント（Workspace で2段階認証を必須）
- ローカルLLM: 事務所のGPUサーバー上の Ollama（`worker/` が AIゲートウェイから仕事を取りに行く）
- Claude API: 個人情報を含まない分析・計画・改善案だけ

## フォルダ

- `app/` … Next.js アプリ
- `db/migrations/` … データベース定義。番号順に流す
- `db/tests/` … データベースの動作確認（`db/README.md` 参照）
- `worker/` … ローカルLLMサーバーで動く取得・実行プログラム
- `docs/` … 仕様書など

## よく使うコマンド（リポジトリの一番上で実行）

- `npm run db:up` … Docker で PostgreSQL 16 を起動（`.env` が必要。`.env.example` をコピー）
- `npm run db:test` … テスト用DBを作り直し、マイグレーションと `db/tests/schema_test.sql` を流す。最後に `ALL TESTS PASSED` が出れば成功
- `npm run db:reset` … 開発用DB（zerobit）を作り直す（空）
- `npm run db:seed` … 開発用DBを作り直し、ダミーデータ（`db/seeds/`）を入れる。`app/.env.local` の接続先も書き込む
- `npm test` … アプリ用のテストDBを作り直し、`app/` のテスト（vitest）を流す
- `npm run dev` / `npm run build` / `npm run lint` … `app/` の Next.js

DBやテストを変えたら `npm run db:test`、アプリのコードを変えたら `npm test`・`npm run build`・`npm run lint` が通ることを確かめてから報告する。

アプリからDBへは `app/src/lib/db.ts` を使う。読み取りは `query()`、書き込みは必ず `withActor()` の中で行う（ルール7）。
ログインの確認は `app/src/lib/auth/session.ts` の `requireUser()`・`requireAssembler()`・`requireManager()` を、画面ではデータを読む前に、Server Action では最初に呼ぶ（`proxy.ts` は Cookie の有無を見るだけで、守りにはならない）。

## 必ず守るルール

1. **本物の顧客データを開発に使わない。** 開発環境、テスト、Claude Code との会話には、作ったダミーデータだけを使う。本番のデータを貼り付けない。
2. **個人情報は `pii` スキーマだけに置く。** アプリ本体（DBロール `zb_app`）のコードから `pii` を読まない。個人情報を扱う処理は `zb_pii` で接続する専用の窓口にまとめる。`core` の表に氏名・住所・電話・メールを足さない。
3. **AIの呼び出しは必ず AIゲートウェイを通す。** 個人情報を含む処理はローカルLLMに回す。Claude API に送るときは伏せ字にし、失敗したら送らない。呼び出しはすべて `core.ai_calls` に、モデルとプロンプトの版と一緒に記録する。モデル名は版まで固定して書く。
4. **外に出る操作は人の承認を通す。** お客様への送信、振込、申告、発注、価格・広告の変更が対象。新しく自動送信を足さない。例外は LINE の定型の聞き取り・案内だけ。
5. **数字はプログラムで計算する。** 在庫・原価・金額・日付は DB の値から計算し、LLM に計算させない。金額は円の整数で扱う。
6. **Amazon には SP-API と広告API だけでアクセスする。** セラーセントラルの画面の自動操作やスクレイピングを書かない。Amazon のデータを AI モデルの学習や追加学習に使わない。
7. **監査ログのために、操作するトランザクションの先頭で実行者を設定する。**
   `SET LOCAL app.actor_kind = 'user' | 'system' | 'ai'` と、人なら `SET LOCAL app.actor_user_id = '<users.id>'`。
8. **DBの変更は新しいマイグレーションファイルで行う。** 既存のファイルは書き換えない。表や制約を足したら `db/tests/` にも確認を足し、全部通ることを確かめる。
9. **秘密情報をコードに書かない。** APIキーや暗号鍵は Secret Manager、ローカルでは `.env.local`（git に入れない）。
10. **お金と在庫の計算には必ずテストを付ける。**

## 作業の進め方

- 1回の作業は小さく（表を1つ、画面を1つ、APIを1つ程度）。
- 変更したら、テストを流してから報告する。
- 本番に出す前に検証環境で確認する。
- 仕様書と違うことをしたくなったら、作る前にその理由を説明して確認を取る。

## レビュー専用のセッションで点検すること

作業したセッションとは別のセッションで、次を点検する。

- `pii` の値が、ログ、エラーメッセージ、`audit.log`、Claude API への送信内容に出ていないか
- 承認を飛ばして外に出る経路がないか
- 秘密情報がコードやログに出ていないか
- 入力の検証漏れ（SQLインジェクション、権限の確認漏れ）がないか
- バックアップから実際に戻せるか（手順書どおりに試す）
