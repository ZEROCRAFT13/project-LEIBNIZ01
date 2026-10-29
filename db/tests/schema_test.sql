-- =====================================================================
-- 0001_init.sql / 0002_roles.sql の動作確認
-- 空のデータベースに2つを流したあと、管理者（postgres）で実行する。
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
  (1, 2, 'RTX 5070 A',    1, 98780, 8980),
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
    = ARRAY['ZB-' || to_char(current_date,'YYMM') || '-0001',
            'ZB-' || to_char(current_date,'YYMM') || '-0002',
            'ZB-' || to_char(current_date,'YYMM') || '-0003'],
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
SELECT current_date - g, 1, 'amazon', CASE WHEN g % 7 = 0 THEN 0 ELSE 1 END
FROM generate_series(0, 13) AS g;
SELECT pg_temp.check(
  (SELECT per_day = 0.86 AND days_left = 2.3 AND start_assembly_by = current_date + 2 - 5
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

\echo ALL TESTS PASSED
