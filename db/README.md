# データベース

PostgreSQL 16 用の定義です。仕様書9章「主要データ」を表にしたものです。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `migrations/0001_init.sql` | 表・制約・トリガー・ビュー（フェーズ0〜1の範囲） |
| `migrations/0002_roles.sql` | DBの利用者（`zb_app`・`zb_pii`・`zb_auditor`）と権限 |
| `migrations/0003_tokyo_dates.sql` | 日付を日本時間で数える |
| `migrations/0004_auth.sql` | ログイン（`auth` 区画）。バイトはメールアドレスなしで登録できる |
| `migrations/0005_receiving.sql` | 入荷。仕入れの数より多く入荷できない・型番違いを止める。仕入れの状態を自動で決める |
| `migrations/0006_purchase_shipments.sql` | 仕入れの発送（運送会社・追跡番号、何個口でも）。発送があれば「輸送中」 |
| `migrations/0007_document_intake.sql` | 書類の取り込み。同じファイルを二重に入れない、ファイルは変えられず消せない、領収書は日付・取引先・金額がそろうまで要確認 |
| `migrations/0008_purchase_drafts.sql` | 仕入れの下書き（メールから読み取った項目だけ。本文は残さない）と、ショップの商品名と型番の対応 |
| `migrations/0009_purchase_draft_tax.sql` | 下書きに「うち消費税」（メールに書いてあればその額を使う） |
| `migrations/0010_sku_composition.sql` | 構成表を画面から直すための決まり（枠と同じ種類の型番だけ、組立中の機種の枠は消せない、使ってよい型番の付け外しを監査ログへ） |
| `migrations/0011_optional_slots_and_notes.sql` | 枠の「付けなくてもよい」と「自由枠」、個体のメモ（unit_notes） |
| `migrations/0012_label_printed.sql` | 個体の管理番号シールを刷った時刻（units.label_printed_at）。まだ刷っていない個体を一覧に出す |
| `seeds/` | 開発用のダミーデータ（`npm run db:seed`） |
| `tests/schema_test.sql` | 動作確認（106項目）。最後に `ALL TESTS PASSED` と出れば成功 |

## 3つの区画

| 区画 | 中身 | 読める人 |
| --- | --- | --- |
| `core` | 業務データ。顧客は番号だけを持つ | アプリ本体（`zb_app`） |
| `pii` | 顧客の氏名・住所・電話・メール・LINE ID、メッセージ本文。暗号化して保存 | 個人情報の窓口（`zb_pii`）だけ |
| `audit` | 監査ログ。追記のみで、管理者でも書き換え・削除できない | 監査用（`zb_auditor`）だけ |
| `auth` | ログイン。セッション・組立用の端末・PIN（どれもハッシュだけ）、ログインの記録（追記のみ） | アプリ本体（消せない）。監査用はログインの記録だけ |

## 表の地図

- **人と役割**: `users`, `roles`, `role_assignments`（いつから誰がその役割か）
- **部品とSKU**: `part_models`（型番）, `skus`, `sku_slots`（構成の枠）, `sku_slot_options`（枠に使ってよい型番）
- **仕入れ**: `suppliers`, `purchases`, `purchase_lines`, `purchase_shipments`（発送・追跡番号）, `purchase_drafts`（メールから作る下書き）, `supplier_item_aliases`（ショップの商品名→型番）
- **在庫**: `part_items`（部品1個ずつ）, `units`（個体＝管理番号）, `unit_parts`（個体に入っている部品と交換履歴）, `inspections`, `asset_transfers`（区分の振替）
- **FBA**: `fba_shipments`, `fba_shipment_units`, `fba_inventory_snapshots`
- **販売**: `customers`, `orders`, `order_lines`, `order_units`（注文と個体の紐づけ）, `product_registrations`（QRの製品登録）
- **受信箱**: `conversations`, `messages`（本文は `pii.message_bodies`）
- **修理**: `repair_tickets`, `rma_cases`
- **書類**: `documents`（電子帳簿保存法の検索項目つき）, `document_links`
- **会計**: `amazon_settlements`, `statement_lines`（カード・口座の明細）, `deals`（freeeへ送る取引）
- **指標**: `sku_daily_metrics`（セッション・販売数・広告）
- **タスク**: `tasks`, `task_events`（追記のみ）, `approvals`
- **AI**: `prompts`（版つき）, `ai_calls`（呼び出し記録）, `ai_jobs`（ローカルLLMが取りに来る仕事）
- **設定**: `settings`（FBAリードタイムなど）
- **ログイン**（`auth`）: `sessions`, `devices`（組立用の端末）, `worker_pins`, `login_events`（追記のみ）

## データベースが自動で止めること

- 構成表にない型番の取り付け（理由を書けば通る）
- 仕入れの明細の数より多い入荷、明細と違う型番の入荷、取り消した仕入れへの入荷
- 取り込んだ書類のファイルの差し替え・削除（管理者でもできない）
- 構成表の枠に種類のちがう型番を入れること、組立中の個体がある機種の枠を消すこと
- 1つの部品を2台に取り付けること
- 組立した人が自分で検品すること
- 注文と違うSKUの個体や、注文台数を超える個体を、注文に紐づけること
- AIの下書きを、人の承認なしに送信済みにすること
- 個人情報を伏せずに Claude へ送った記録を作ること
- 期限を過ぎたタスクを、遅れた理由なしに完了すること
- 同じ元データから同じ勘定科目の取引を二重に作ること
- 監査ログとタスクの記録の書き換え・削除

## 自動で作られるもの

- 管理番号 `ZB-年月-連番`（`core.next_mgmt_no()`）と、QR用のトークン
- 顧客番号 `C-000001`
- 保証期間（`core.v_unit_warranty`）: 注文日が分かれば注文日から、分からなければ自社の出荷日から数える。製品登録で24か月になる
- タスクの期限超過（`core.v_task_board`）
- FBA在庫の残り日数と組立を始める期限（`core.v_fba_runway`）

## 動作確認のしかた

リポジトリの一番上で次を実行します（Docker の PostgreSQL 16 を使います）。

```sh
npm run db:up     # 初回とパソコンの再起動後
npm run db:test   # テスト用DB（zerobit_test）を作り直して、マイグレーションとテストを流す
```

テストは毎回作り直す `zerobit_test` に書き込むので、開発用DB（`zerobit`）のデータには影響しません。本番では流さないでください。

手で流す場合は、空のデータベースに `migrations/` を番号順に流し、最後に `tests/schema_test.sql` を流します。

## まだ入っていないもの（フェーズ2で追加）

請求書・支払い予定・振込、法人の年間カレンダー、中期経営計画と指標、撮影用資産の売却の管理、直販サイトとの連携。
