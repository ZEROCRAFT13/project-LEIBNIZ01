-- =====================================================================
-- db/migrations のすべてを流したあとの動作確認
-- 空のデータベースにマイグレーションを番号順に流したあと、管理者（postgres）で実行する。
-- 失敗するはずの操作は expect_error で包み、本当に止まることを確かめる。
-- 最後に「ALL TESTS PASSED」と出れば成功。
-- =====================================================================
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'OK（止まった）: % → %', p_label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'NG: % が止まらなかった', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'NG: %', p_label;
  END IF;
  RAISE NOTICE 'OK: %', p_label;
END $$;

-- ---------- 準備（管理者として） ----------
INSERT INTO core.users (email, display_name, kind) VALUES
  ('owner@example.jp', '代表', 'owner'),
  ('sato@example.jp',  '佐藤（バイト）', 'part_time');
INSERT INTO core.role_assignments (role_code, user_id)
SELECT code, 1 FROM core.roles WHERE code <> 'assembler';
INSERT INTO core.role_assignments (role_code, user_id) VALUES ('assembler', 2);

INSERT INTO core.part_models (category, maker, model_no, name, keep_box) VALUES
  ('cpu',    'AMD',    '100-100001404WOF', 'Ryzen 7 9700X',          false),
  ('gpu',    'MakerA', 'RTX5070-A12G',     'GeForce RTX 5070 (A)',   true),
  ('gpu',    'MakerB', 'RTX5070-B12G',     'GeForce RTX 5070 (B)',   true),
  ('gpu',    'MakerA', 'RTX5060-A8G',      'GeForce RTX 5060 (A)',   true),
  ('memory', 'MakerM', 'DDR5-5600-16x2',   'DDR5-5600 32GB',         true);

INSERT INTO core.skus (code, name, list_price) VALUES
  ('ZB-G5070-R7', 'ゲーミングPC 5070/R7', 349800),
  ('ZB-G5060-R5', 'ゲーミングPC 5060/R5', 239800);

INSERT INTO core.sku_slots (sku_id, slot, category, sort_order) VALUES
  (1, 'CPU', 'cpu', 1), (1, 'GPU', 'gpu', 2), (1, 'MEMORY', 'memory', 3);
INSERT INTO core.sku_slot_options (slot_id, part_model_id) VALUES
  (1, 1), (2, 2), (2, 3), (3, 5);

INSERT INTO core.suppliers (name, kind, invoice_reg_no) VALUES ('テストショップ', 'shop', 'T1234567890123');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.suppliers (name, invoice_reg_no) VALUES ('番号まちがい', 'T123')$$,
  'インボイス登録番号の形式チェック');

INSERT INTO core.purchases (supplier_id, supplier_order_no, ordered_on, total_amount, tax_amount, payment_method)
VALUES (1, 'SO-1', '2026-10-01', 300000, 27272, 'card');
INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax) VALUES
  (1, 1, 'Ryzen 7 9700X', 1, 52800, 4800),
  (1, 2, 'RTX 5070 A',    2, 98780, 8980),
  (1, 4, 'RTX 5060 A',    1, 54780, 4980);
INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax, box_kept, box_location) VALUES
  (1, 1, 'CPU-001', 48000, 4800, false, NULL),
  (2, 2, 'GPU-A-001', 89800, 8980, true, 'B-07'),
  (4, 3, 'GPU-60-001', 49800, 4980, true, 'B-08'),
  (2, 2, 'GPU-A-002', 89800, 8980, true, 'B-09');

SELECT pg_temp.expect_error(
  $$INSERT INTO core.part_items (part_model_id, serial_no, cost_excl_tax, box_kept) VALUES (2, 'X', 1, true)$$,
  '元箱を保管するなら棚番が必要');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.part_items (part_model_id, serial_no, cost_excl_tax) VALUES (2, 'GPU-A-001', 1)$$,
  '同じ型番・同じシリアルの二重登録');

-- ---------- ここからアプリ（zb_app）として ----------
SET ROLE zb_app;
SET app.actor_kind = 'user';
SET app.actor_user_id = '2';

INSERT INTO core.units (sku_id, assembled_by) VALUES (1, 2), (1, 2), (2, 2);
SELECT pg_temp.check(
  (SELECT array_agg(mgmt_no ORDER BY id) FROM core.units)
    = ARRAY['ZB-' || to_char(core.today_jst(),'YYMM') || '-0001',
            'ZB-' || to_char(core.today_jst(),'YYMM') || '-0002',
            'ZB-' || to_char(core.today_jst(),'YYMM') || '-0003'],
  '管理番号が年月ごとの連番で発行される');
SELECT pg_temp.check(
  (SELECT bool_and(length(qr_token) >= 24) AND count(DISTINCT qr_token) = 3 FROM core.units),
  'QRトークンが個体ごとに別の値で発行される');

-- 組立: 構成表どおりなら通り、部品は「取付済み」になる
INSERT INTO core.unit_parts (unit_id, part_item_id, slot, installed_by) VALUES (1, 1, 'CPU', 2), (1, 2, 'GPU', 2);
SELECT pg_temp.check(
  (SELECT bool_and(status = 'installed') FROM core.part_items WHERE id IN (1, 2)),
  '取り付けた部品の状態が installed になる');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.unit_parts (unit_id, part_item_id, slot, installed_by) VALUES (2, 3, 'GPU', 2)$$,
  '構成表にない型番（RTX 5060）を 5070 機に取り付け');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.unit_parts (unit_id, part_item_id, slot, installed_by) VALUES (2, 2, 'GPU', 2)$$,
  '別の個体に取付済みの部品を二重に取り付け');
INSERT INTO core.unit_parts (unit_id, part_item_id, slot, installed_by, override_reason)
VALUES (2, 3, 'GPU', 2, '検証用に一時的に取り付け');
SELECT pg_temp.check(true, '理由を書けば構成表外の部品も取り付けられる');

-- 修理で部品を外すと在庫に戻る
UPDATE core.unit_parts SET removed_at = now(), removed_by = 1, remove_reason = '検証終了'
 WHERE part_item_id = 3 AND removed_at IS NULL;
SELECT pg_temp.check((SELECT status FROM core.part_items WHERE id = 3) = 'in_stock', '外した部品は in_stock に戻る');

-- 検品は組立と別の人
SELECT pg_temp.expect_error(
  $$UPDATE core.units SET inspected_by = 2, inspected_at = now() WHERE id = 1$$,
  '組立者が自分で検品');
UPDATE core.units SET inspected_by = 1, inspected_at = now(), status = 'at_fba',
                      shipped_at = '2026-10-05', ship_destination = 'fba' WHERE id = 1;
UPDATE core.units SET status = 'at_fba', shipped_at = '2026-10-05', ship_destination = 'fba' WHERE id = 2;

-- FBA注文: 製品登録のときに注文番号で個体と紐づける
INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount)
VALUES ('amazon', '250-0000000-0001', true, '2026-10-20 10:00+09', 349800);
INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price) VALUES (1, 1, 'ZB-G5070-R7', 1, 349800);

INSERT INTO core.order_units (order_id, unit_id, link_method) VALUES (1, 1, 'product_registration');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.order_units (order_id, unit_id, link_method) VALUES (1, 2, 'product_registration')$$,
  '1台の注文に2台目の個体を紐づけ');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.order_units (order_id, unit_id, link_method) VALUES (1, 3, 'product_registration')$$,
  '注文と違うSKUの個体を紐づけ');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount) VALUES ('direct', 'D-1', true, now(), 1)$$,
  '直販の注文をFBAにする');

RESET ROLE;
SET ROLE zb_pii;
INSERT INTO core.customers (is_corporate) VALUES (false);
INSERT INTO pii.customer_profiles (customer_id, name_enc, email_enc, email_hash)
VALUES (1, '\x01'::bytea, '\x02'::bytea, '\x03'::bytea);
RESET ROLE;

SET ROLE zb_app;
SELECT pg_temp.check((SELECT customer_no FROM core.customers WHERE id = 1) = 'C-000001', '顧客番号が発行される');
INSERT INTO core.product_registrations (unit_id, customer_id, order_id, verification) VALUES (1, 1, 1, 'verified');
UPDATE core.units SET warranty_months = 24 WHERE id = 1;
SELECT pg_temp.check(
  (SELECT warranty_start = '2026-10-20' AND warranty_end = '2028-10-20' AND registered
     FROM core.v_unit_warranty WHERE unit_id = 1),
  '保証は注文日から起算し、登録で2年になる');
SELECT pg_temp.check(
  (SELECT warranty_start = '2026-10-05' FROM core.v_unit_warranty WHERE unit_id = 2),
  '注文が分からない個体は自社の出荷日から起算');

-- DBの時刻設定が UTC でも、日本時間の深夜の注文は日本の日付で数える（0003）
SET TIME ZONE 'UTC';
INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount)
VALUES ('amazon', '250-0000000-0002', true, '2026-09-30 01:00+09', 349800);
INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price)
SELECT id, 1, 'ZB-G5070-R7', 1, 349800 FROM core.orders WHERE external_order_no = '250-0000000-0002';
INSERT INTO core.order_units (order_id, unit_id, link_method)
SELECT id, 2, 'support' FROM core.orders WHERE external_order_no = '250-0000000-0002';
SELECT pg_temp.check(
  (SELECT warranty_start = '2026-09-30' FROM core.v_unit_warranty WHERE unit_id = 2),
  '日本時間 9/30 1:00 の注文は、DBがUTCでも 9/30 起算になる');
SELECT pg_temp.check(core.next_mgmt_no('2026-10-01') LIKE 'ZB-2610-%', '管理番号の年月は渡した日付（日本時間）で決まる');
RESET TIME ZONE;

-- 個人情報はアプリ本体から見えない
SELECT pg_temp.expect_error($$SELECT * FROM pii.customer_profiles$$, 'アプリ本体が個人情報の表を読む');

-- 受信箱: AIの下書きは承認なしに送信済みにできない
INSERT INTO core.conversations (channel, external_thread_id, unit_id, reply_due_at)
VALUES ('amazon', 'thread-1', 1, now() + interval '24 hours');
INSERT INTO core.ai_calls (route, model, model_version, purpose, contains_pii, status)
VALUES ('local', 'local-model', 'sha256:abc', 'amazon_reply_draft', true, 'ok');
INSERT INTO core.messages (conversation_id, direction, author_kind, status) VALUES (1, 'in', 'customer', 'received');
INSERT INTO core.messages (conversation_id, direction, author_kind, status, ai_call_id) VALUES (1, 'out', 'ai_draft', 'draft', 1);
SELECT pg_temp.expect_error(
  $$UPDATE core.messages SET status = 'sent', sent_at = now() WHERE id = 2$$,
  'AIの下書きを承認なしで送信');
UPDATE core.messages SET status = 'sent', approved_by = 1, approved_at = now(), sent_at = now() WHERE id = 2;
SELECT pg_temp.check(true, '承認すれば送信済みにできる');

-- 個人情報を伏せずに Claude へ送った記録は作れない
SELECT pg_temp.expect_error(
  $$INSERT INTO core.ai_calls (route, model, model_version, purpose, contains_pii, masked, status)
    VALUES ('claude', 'claude-opus-5-5', 'claude-opus-5-5', 'test', true, false, 'ok')$$,
  '個人情報を伏せずに Claude へ送信');
INSERT INTO core.ai_calls (route, model, model_version, purpose, contains_pii, masked, status)
VALUES ('claude', 'claude-opus-5-5', 'claude-opus-5-5', 'plan_review', true, true, 'ok');
SELECT pg_temp.check(true, '伏せ字にしていれば Claude へ送れる');

-- タスク: 期限を過ぎて完了するなら理由が必要
INSERT INTO core.tasks (title, role_code, assignee_user_id, source_kind, due_at)
VALUES ('Amazonへ返信', 'support', 1, 'inbox', now() - interval '1 hour'),
       ('納品書を印刷', 'factory_manager', 1, 'manual', now() + interval '1 day');
SELECT pg_temp.check(
  (SELECT array_agg(overdue ORDER BY id) = ARRAY[true, false] FROM core.v_task_board),
  '期限を過ぎた未完了タスクは overdue になる');
SELECT pg_temp.expect_error(
  $$UPDATE core.tasks SET status = 'done', completed_at = now(), completed_by_kind = 'user', completed_by_user_id = 1 WHERE id = 1$$,
  '期限超過のタスクを理由なしで完了');
UPDATE core.tasks SET status = 'done', completed_at = now(), completed_by_kind = 'user',
                      completed_by_user_id = 1, delay_reason = '集荷の対応で遅れた' WHERE id = 1;
INSERT INTO core.task_events (task_id, actor_kind, actor_user_id, event) VALUES (1, 'user', 1, 'completed');
SELECT pg_temp.expect_error($$UPDATE core.task_events SET event = 'x'$$, 'タスクの記録を書き換え');

-- 記帳: 要確認には理由が必要。同じ元データから同じ科目を二重に作れない
INSERT INTO core.deals (source_type, source_id, deal_date, amount, department, account_item)
VALUES ('purchase', 1, '2026-10-01', 300000, 'manufacturing', '仕入高');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.deals (source_type, source_id, deal_date, amount, department, account_item)
    VALUES ('purchase', 1, '2026-10-01', 300000, 'manufacturing', '仕入高')$$,
  '同じ仕入れを二重に記帳');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.deals (source_type, deal_date, amount, department, account_item, status)
    VALUES ('manual', '2026-10-02', 100, 'admin', '消耗品費', 'needs_review')$$,
  '理由なしで要確認にする');

-- ローカルLLMが仕事を取る: 優先度の高いものから、二重に取られない
INSERT INTO core.ai_jobs (kind, route, subject_type, subject_id, priority) VALUES
  ('read_receipt', 'local', 'document', 1, 0),
  ('draft_reply',  'local', 'conversation', 1, 10);
SELECT pg_temp.check((SELECT kind FROM core.claim_ai_job('gpu-1')) = 'draft_reply', '優先度の高い仕事から取る');
SELECT pg_temp.check((SELECT kind FROM core.claim_ai_job('gpu-1')) = 'read_receipt', '次は残りの仕事を取る');
SELECT pg_temp.check((SELECT count(*) FROM core.claim_ai_job('gpu-1')) = 0, '取られた仕事は二重に取られない');

-- FBA在庫の残り日数と組立開始の期限
INSERT INTO core.fba_inventory_snapshots (captured_at, sku_id, fulfillable, inbound) VALUES (now(), 1, 2, 0);
INSERT INTO core.sku_daily_metrics (metric_date, sku_id, channel, units_ordered)
SELECT core.today_jst() - g, 1, 'amazon', CASE WHEN g % 7 = 0 THEN 0 ELSE 1 END
FROM generate_series(0, 13) AS g;
SELECT pg_temp.check(
  (SELECT per_day = 0.86 AND days_left = 2.3 AND start_assembly_by = core.today_jst() + 2 - 5
     FROM core.v_fba_runway WHERE sku_code = 'ZB-G5070-R7'),
  'FBA在庫: 1日0.86台、残り2.3日、組立開始の期限は3日前（すでに遅れ）');

RESET ROLE;

-- ---------- 監査ログ ----------
SELECT pg_temp.check(
  (SELECT count(*) > 30 FROM audit.log),
  '操作が監査ログに残っている');
SELECT pg_temp.check(
  (SELECT actor_kind = 'user' AND actor_user_id = 2 FROM audit.log
    WHERE table_name = 'core.unit_parts' AND action = 'INSERT' ORDER BY id LIMIT 1),
  '誰が操作したかが記録される');
SELECT pg_temp.check(
  (SELECT before IS NULL AND after IS NULL AND 'name_enc' = ANY(changed_columns)
     FROM audit.log WHERE table_name = 'pii.customer_profiles' LIMIT 1),
  '個人情報の表は、監査ログに値を残さず列名だけ残す');
SELECT pg_temp.expect_error($$UPDATE audit.log SET actor_kind = 'x'$$, '管理者でも監査ログを書き換え');
SELECT pg_temp.expect_error($$DELETE FROM audit.log$$, '管理者でも監査ログを削除');
SET ROLE zb_app;
SELECT pg_temp.expect_error($$SELECT * FROM audit.log$$, 'アプリ本体が監査ログを直接読む');
SELECT pg_temp.expect_error(
  $$INSERT INTO audit.log (actor_kind, table_name, action) VALUES ('user', 'x', 'INSERT')$$,
  'アプリ本体が監査ログに直接書く');
RESET ROLE;

-- ---------- ログイン（0004_auth） ----------
SET ROLE zb_app;
SELECT set_config('app.actor_kind', 'user', false), set_config('app.actor_user_id', '1', false);

-- バイトはメールアドレスなしで登録できる。代表・社員はメールが必要で、小文字にそろえる
INSERT INTO core.users (display_name, kind) VALUES ('鈴木（バイト）', 'part_time');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.users (display_name, kind) VALUES ('社員A', 'staff')$$,
  'メールアドレスなしで社員を登録');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.users (email, display_name, kind) VALUES ('Staff@Example.jp', '社員B', 'staff')$$,
  '大文字まじりのメールアドレスで登録');

-- 組立端末: 登録前は鍵がなく、登録したら登録コードを消す
INSERT INTO auth.devices (name, enroll_code_hash, enroll_expires_at, registered_by)
VALUES ('組立台1', '\x01', now() + interval '10 minutes', 1);
SELECT pg_temp.expect_error(
  $$INSERT INTO auth.devices (name, token_hash, registered_by) VALUES ('鍵だけ', '\x02', 1)$$,
  '登録日なしで端末の鍵を入れる');
UPDATE auth.devices SET token_hash = '\x03', enrolled_at = now(),
                        enroll_code_hash = NULL, enroll_expires_at = NULL WHERE id = 1;

-- PIN とセッション
INSERT INTO auth.worker_pins (user_id, pin_hash, set_by) VALUES (2, 'scrypt$16384$8$1$c2FsdA$aGFzaA', 1);
SELECT pg_temp.expect_error(
  $$INSERT INTO auth.worker_pins (user_id, pin_hash, set_by) VALUES (3, '1234', 1)$$,
  'PINをハッシュにせずに保存');
INSERT INTO auth.sessions (token_hash, kind, user_id, device_id, expires_at)
VALUES ('\x10', 'worker', 2, 1, now() + interval '12 hours'),
       ('\x11', 'user', 1, NULL, now() + interval '7 days');
SELECT pg_temp.expect_error(
  $$INSERT INTO auth.sessions (token_hash, kind, user_id, expires_at) VALUES ('\x12', 'worker', 2, now() + interval '1 hour')$$,
  '端末なしで組立担当のセッションを作る');
SELECT pg_temp.expect_error($$DELETE FROM auth.sessions$$, 'アプリ本体がセッションを削除');
SELECT pg_temp.expect_error($$DELETE FROM auth.devices$$, 'アプリ本体が端末を削除');

-- ログインの記録は追記だけ
INSERT INTO auth.login_events (event, user_id, device_id) VALUES ('pin_login', 2, 1);
SELECT pg_temp.expect_error($$UPDATE auth.login_events SET event = 'logout'$$, 'ログインの記録を書き換え');
SELECT pg_temp.expect_error($$DELETE FROM auth.login_events$$, 'ログインの記録を削除');
RESET ROLE;
SELECT pg_temp.expect_error($$UPDATE auth.login_events SET detail = 'x'$$, '管理者でもログインの記録を書き換え');

SELECT pg_temp.check(
  (SELECT before IS NULL AND after IS NULL AND 'pin_hash' = ANY(changed_columns) AND actor_user_id = 1
     FROM audit.log WHERE table_name = 'auth.worker_pins' LIMIT 1),
  'PINの設定は、誰がやったかを残し、ハッシュの値は監査ログに残さない');
SELECT pg_temp.check(
  (SELECT count(*) = 0 FROM audit.log
    WHERE table_name LIKE 'auth.%' AND (before IS NOT NULL OR after IS NOT NULL)),
  'ログインの表は、監査ログに値を残さない');
SELECT pg_temp.check(
  (SELECT after ? 'kind' FROM audit.log WHERE table_name = 'core.users' ORDER BY id DESC LIMIT 1),
  '業務データの表は、これまでどおり監査ログに値を残す');

SET ROLE zb_auditor;
SELECT pg_temp.check((SELECT count(*) = 1 FROM auth.login_events), '監査用はログインの記録を読める');
SELECT pg_temp.expect_error($$SELECT token_hash FROM auth.devices$$, '監査用が端末の鍵を読む');
SELECT pg_temp.expect_error($$SELECT * FROM auth.sessions$$, '監査用がセッションを読む');
RESET ROLE;
SET ROLE zb_pii;
SELECT pg_temp.expect_error($$SELECT * FROM auth.sessions$$, '個人情報の窓口がセッションを読む');
RESET ROLE;

-- ---------- 入荷（0005_receiving） ----------
SET ROLE zb_app;
SELECT pg_temp.check((SELECT status = 'received' FROM core.purchases WHERE id = 1),
  '全部の明細を入荷した仕入れは「入荷済み」になる');

INSERT INTO core.purchases (supplier_id, supplier_order_no, ordered_on, total_amount, tax_amount, payment_method)
VALUES (1, 'SO-RCV', '2026-10-20', 106160, 9650, 'card');
INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax)
SELECT id, 1, 'Ryzen 7 9700X', 2, 52800, 4800 FROM core.purchases WHERE supplier_order_no = 'SO-RCV';
INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax)
SELECT id, NULL, '送料', 1, 560, 50 FROM core.purchases WHERE supplier_order_no = 'SO-RCV';
CREATE TEMP VIEW rcv AS
  SELECT p.id AS purchase_id, p.status, l.id AS line_id
    FROM core.purchases p JOIN core.purchase_lines l ON l.purchase_id = p.id AND l.part_model_id IS NOT NULL
   WHERE p.supplier_order_no = 'SO-RCV';
SELECT pg_temp.check((SELECT status = 'ordered' FROM rcv), '入荷前は「注文済み」');

INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
SELECT 1, line_id, 'RCV-001', 48000, 4800 FROM rcv;
SELECT pg_temp.check((SELECT status = 'partially_received' FROM rcv), '一部だけ入荷すると「一部入荷」');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
    SELECT 2, line_id, 'RCV-GPU', 89800, 8980 FROM rcv$$,
  '明細と違う型番の部品を入荷');
INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
SELECT 1, line_id, 'RCV-002', 48000, 4800 FROM rcv;
SELECT pg_temp.check((SELECT status = 'received' FROM rcv), '数がそろうと「入荷済み」（送料の明細は待たない）');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
    SELECT 1, line_id, 'RCV-003', 48000, 4800 FROM rcv$$,
  '仕入れの数より多く入荷');

DELETE FROM core.part_items WHERE serial_no = 'RCV-002';
SELECT pg_temp.check((SELECT status = 'partially_received' FROM rcv), '入荷を取り消すと「一部入荷」に戻る');

UPDATE core.purchases SET status = 'cancelled' WHERE supplier_order_no = 'SO-RCV';
SELECT pg_temp.expect_error(
  $$INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
    SELECT 1, line_id, 'RCV-004', 48000, 4800 FROM rcv$$,
  '取り消した仕入れに入荷');
DELETE FROM core.part_items WHERE serial_no = 'RCV-001';
SELECT pg_temp.check((SELECT status = 'cancelled' FROM rcv), '取り消した仕入れの状態は自動で変わらない');
RESET ROLE;

-- ---------- 発送・輸送中（0006_purchase_shipments） ----------
SET ROLE zb_app;
INSERT INTO core.purchases (supplier_id, supplier_order_no, ordered_on, total_amount, tax_amount, payment_method)
VALUES (1, 'SO-SHIP', '2026-10-25', 52800, 4800, 'card');
INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax)
SELECT id, 1, 'Ryzen 7 9700X', 1, 52800, 4800 FROM core.purchases WHERE supplier_order_no = 'SO-SHIP';
CREATE TEMP VIEW shp AS
  SELECT p.id AS purchase_id, p.status, l.id AS line_id
    FROM core.purchases p JOIN core.purchase_lines l ON l.purchase_id = p.id
   WHERE p.supplier_order_no = 'SO-SHIP';
SELECT pg_temp.check((SELECT status = 'ordered' FROM shp), '発送前は「注文済み」');

INSERT INTO core.purchase_shipments (purchase_id, carrier, tracking_no)
SELECT purchase_id, 'yamato', '123456789012' FROM shp;
SELECT pg_temp.check((SELECT status = 'in_transit' FROM shp), '発送を登録すると「輸送中」');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.purchase_shipments (purchase_id, carrier, tracking_no) SELECT purchase_id, 'yamato', '123456789012' FROM shp$$,
  '同じ運送会社の同じ追跡番号を二重に登録');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.purchase_shipments (purchase_id, carrier, tracking_no) SELECT purchase_id, 'sagawa', '1234-5678-9012' FROM shp$$,
  'ハイフンつきの追跡番号をそのまま保存');

INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax)
SELECT 1, line_id, 'SHIP-001', 48000, 4800 FROM shp;
SELECT pg_temp.check((SELECT status = 'received' FROM shp), '輸送中でも、全部入荷すれば「入荷済み」');
DELETE FROM core.part_items WHERE serial_no = 'SHIP-001';
SELECT pg_temp.check((SELECT status = 'in_transit' FROM shp), '入荷を取り消すと「輸送中」に戻る');
DELETE FROM core.purchase_shipments WHERE tracking_no = '123456789012';
SELECT pg_temp.check((SELECT status = 'ordered' FROM shp), '発送を消すと「注文済み」に戻る');
RESET ROLE;
SET ROLE zb_auditor;
SELECT pg_temp.check((SELECT count(*) >= 0 FROM core.purchase_shipments), '監査用は発送を読める');
RESET ROLE;

-- ---------- 書類の取り込み（0007_document_intake） ----------
SET ROLE zb_app;
INSERT INTO core.documents (kind, storage_uri, sha256, mime_type, byte_size, source, original_name)
VALUES ('receipt', 'local:aa/aaaa.pdf', repeat('a', 64), 'application/pdf', 1234, 'folder', '領収書.pdf');
SELECT pg_temp.check((SELECT review_status = 'needs_review' FROM core.documents WHERE sha256 = repeat('a', 64)),
  '取り込んだ書類は「要確認」から始まる');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.documents (kind, storage_uri, sha256, mime_type, byte_size, source)
    VALUES ('receipt', 'local:aa/other.pdf', repeat('a', 64), 'application/pdf', 1234, 'upload')$$,
  '同じ中身のファイルを二重に取り込む');
SELECT pg_temp.expect_error(
  $$UPDATE core.documents SET review_status = 'done' WHERE sha256 = repeat('a', 64)$$,
  '日付・取引先・金額がないまま領収書を確認済みにする');
UPDATE core.documents SET issued_on = '2026-10-30', counterparty = 'テストショップ', amount = 52800,
                          invoice_reg_no = 'T1234567890123', review_status = 'done'
 WHERE sha256 = repeat('a', 64);
SELECT pg_temp.check((SELECT review_status = 'done' FROM core.documents WHERE sha256 = repeat('a', 64)),
  '項目がそろえば確認済みにできる');
SELECT pg_temp.expect_error(
  $$UPDATE core.documents SET storage_uri = 'local:bb/bbbb.pdf' WHERE sha256 = repeat('a', 64)$$,
  '取り込んだファイルを差し替える');
SELECT pg_temp.expect_error($$DELETE FROM core.documents$$, 'アプリ本体が書類を削除');
INSERT INTO core.document_links (document_id, entity_type, entity_id)
SELECT id, 'purchase', 1 FROM core.documents WHERE sha256 = repeat('a', 64);
DELETE FROM core.document_links WHERE entity_type = 'purchase' AND entity_id = 1;
RESET ROLE;
SELECT pg_temp.expect_error($$DELETE FROM core.documents$$, '管理者でも書類を削除');
SELECT pg_temp.check(
  (SELECT 'counterparty' = ANY(changed_columns) AND actor_user_id = 1 FROM audit.log
    WHERE table_name = 'core.documents' AND action = 'UPDATE' ORDER BY id DESC LIMIT 1),
  '書類の項目を直した履歴が監査ログに残る（電子帳簿保存法の訂正の履歴）');
SELECT pg_temp.check(
  (SELECT count(*) = 2 FROM audit.log WHERE table_name = 'core.document_links'),
  '書類のひもづけの付け外しが監査ログに残る');

-- ---------- 仕入れの下書き（0008_purchase_drafts） ----------
SET ROLE zb_app;
INSERT INTO core.purchase_drafts (source, parser, supplier_id, supplier_order_no, lines)
VALUES ('paste', 'dospara', 1, 'EC0000000099', '[]');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.purchase_drafts (source, parser, supplier_order_no, lines) VALUES ('paste', 'dospara', 'EC0000000099', '[]')$$,
  '同じ注文の下書きを二重に作る');
SELECT pg_temp.expect_error(
  $$UPDATE core.purchase_drafts SET status = 'confirmed' WHERE supplier_order_no = 'EC0000000099'$$,
  '仕入れなしで下書きを確定にする');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.purchase_drafts (source, parser, lines) VALUES ('paste', 'dospara', '{}')$$,
  '明細が配列でない下書き');
UPDATE core.purchase_drafts SET status = 'discarded' WHERE supplier_order_no = 'EC0000000099';
INSERT INTO core.purchase_drafts (source, parser, supplier_order_no, lines) VALUES ('paste', 'dospara', 'EC0000000099', '[]');
SELECT pg_temp.check((SELECT count(*) = 2 FROM core.purchase_drafts WHERE supplier_order_no = 'EC0000000099'),
  '捨てた下書きと同じ注文なら、作り直せる');
SELECT pg_temp.expect_error($$DELETE FROM core.purchase_drafts$$, 'アプリ本体が下書きを削除（捨てるだけ）');

INSERT INTO core.supplier_item_aliases (supplier_id, item_key, part_model_id) VALUES (1, 'ryzen 7 9700x box', 1);
SELECT pg_temp.expect_error(
  $$INSERT INTO core.supplier_item_aliases (supplier_id, item_key, part_model_id) VALUES (1, 'ryzen 7 9700x box', 2)$$,
  '同じショップの同じ商品名に、型番を2つ対応させる');
RESET ROLE;

-- ---------- 下書きの消費税（0009_purchase_draft_tax） ----------
SET ROLE zb_app;
INSERT INTO core.purchase_drafts (source, parser, supplier_order_no, lines, total_amount, tax_amount)
VALUES ('paste', 'joshin', '66000001', '[]', 119840, 10894);
SELECT pg_temp.expect_error(
  $$INSERT INTO core.purchase_drafts (source, parser, supplier_order_no, lines, total_amount, tax_amount)
    VALUES ('paste', 'joshin', '66000002', '[]', 1000, 2000)$$,
  '消費税が合計より大きい下書き');
RESET ROLE;

-- ---------- 機種の構成表（0010_sku_composition） ----------
SET ROLE zb_app;
SELECT pg_temp.expect_error($$INSERT INTO core.skus (code, name) VALUES ('zb lower', 'x')$$, '形のおかしい機種コード');
INSERT INTO core.skus (code, name) VALUES ('ZB-TEST-1', 'テスト機種');
INSERT INTO core.sku_slots (sku_id, slot, category) SELECT id, 'GPU', 'gpu' FROM core.skus WHERE code = 'ZB-TEST-1';
SELECT pg_temp.expect_error(
  $$INSERT INTO core.sku_slots (sku_id, slot, category) SELECT id, 'gpu slot', 'gpu' FROM core.skus WHERE code = 'ZB-TEST-1'$$,
  '形のおかしい枠の名前');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.sku_slot_options (slot_id, part_model_id)
    SELECT s.id, 5 FROM core.sku_slots s JOIN core.skus k ON k.id = s.sku_id WHERE k.code = 'ZB-TEST-1'$$,
  'GPU の枠にメモリを入れる');
INSERT INTO core.sku_slot_options (slot_id, part_model_id)
SELECT s.id, 2 FROM core.sku_slots s JOIN core.skus k ON k.id = s.sku_id WHERE k.code = 'ZB-TEST-1';
SELECT pg_temp.expect_error($$UPDATE core.part_models SET category = 'other' WHERE id = 2$$,
  '構成表で使っている型番の種類を変える');

INSERT INTO core.units (sku_id, status) SELECT id, 'assembling' FROM core.skus WHERE code = 'ZB-TEST-1';
SELECT pg_temp.expect_error(
  $$DELETE FROM core.sku_slots WHERE sku_id = (SELECT id FROM core.skus WHERE code = 'ZB-TEST-1')$$,
  '組立中の個体がある機種の枠を消す');
UPDATE core.sku_slots SET qty = 2 WHERE sku_id = (SELECT id FROM core.skus WHERE code = 'ZB-TEST-1');
SELECT pg_temp.check((SELECT qty = 2 FROM core.sku_slots WHERE sku_id = (SELECT id FROM core.skus WHERE code = 'ZB-TEST-1')),
  '組立中でも枠の数は変えられる');
DELETE FROM core.sku_slot_options
 WHERE slot_id = (SELECT s.id FROM core.sku_slots s JOIN core.skus k ON k.id = s.sku_id WHERE k.code = 'ZB-TEST-1');
RESET ROLE;
SELECT pg_temp.check(
  (SELECT count(*) = 2 FROM audit.log WHERE table_name = 'core.sku_slot_options'
     AND row_id = (SELECT s.id::text FROM core.sku_slots s JOIN core.skus k ON k.id = s.sku_id WHERE k.code = 'ZB-TEST-1')),
  '使ってよい型番の追加・削除が監査ログに残る');

-- ---------- 付けなくてもよい枠・自由枠・個体のメモ（0011） ----------
SET ROLE zb_app;
INSERT INTO core.sku_slots (sku_id, slot, category, qty, required, any_part) VALUES (1, 'EXTRA', 'other', 5, false, true);
SELECT pg_temp.expect_error(
  $$INSERT INTO core.sku_slots (sku_id, slot, category, any_part) VALUES (1, 'EXTRA2', 'gpu', true)$$,
  '自由枠の種類を other 以外にする');
SELECT pg_temp.expect_error(
  $$INSERT INTO core.sku_slot_options (slot_id, part_model_id)
    SELECT id, 2 FROM core.sku_slots WHERE sku_id = 1 AND slot = 'EXTRA'$$,
  '自由枠に使ってよい型番を決める');
INSERT INTO core.part_items (part_model_id, serial_no, cost_excl_tax) VALUES (4, 'FREE-001', 1000);
INSERT INTO core.unit_parts (unit_id, part_item_id, slot, installed_by)
SELECT 2, id, 'EXTRA', 2 FROM core.part_items WHERE serial_no = 'FREE-001';
SELECT pg_temp.check(
  (SELECT status = 'installed' FROM core.part_items WHERE serial_no = 'FREE-001'),
  '自由枠には、構成表にない型番でも理由なしで付けられる');
SELECT pg_temp.check(
  (SELECT bool_and(required) FROM core.sku_slots WHERE slot <> 'EXTRA'),
  'これまでの枠は「必ず付ける」のまま');

INSERT INTO core.unit_notes (unit_id, note, created_by) VALUES (2, 'LEDテープを追加', 2);
SELECT pg_temp.expect_error($$INSERT INTO core.unit_notes (unit_id, note) VALUES (2, '   ')$$, '空のメモ');
SELECT pg_temp.expect_error($$DELETE FROM core.unit_notes$$, 'アプリ本体がメモを削除（取り消しにする）');
UPDATE core.unit_notes SET removed_at = now(), removed_by = 1 WHERE note = 'LEDテープを追加';
RESET ROLE;
SELECT pg_temp.check(
  (SELECT count(*) = 2 FROM audit.log WHERE table_name = 'core.unit_notes'),
  'メモの追加と取り消しが監査ログに残る');

\echo ALL TESTS PASSED
