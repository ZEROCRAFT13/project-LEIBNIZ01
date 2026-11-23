-- =====================================================================
-- FBA の在庫と販売ペースの取り込み（仕様書 F5「FBA補充」）
--   1時間ごとに SP-API から
--     ・FBA の在庫（FBA Inventory API）→ core.fba_inventory_snapshots に1回ごとの記録を足す（機種ごと）
--         fulfillable … 販売できる数
--         inbound     … これから販売できるようになる数（納品の作業中・輸送中・受領中、倉庫の移動・処理中）
--         reserved    … 注文が入って出荷を待っている数（売れたもの）
--     ・直近31日の Amazon の注文（FBA・自社出荷とも。取り消しは除く）→ core.sku_daily_metrics（機種・日本時間の日付ごと）の
--       units_ordered・sales_amount を、その期間について作り直す（件数と金額だけ。注文の中身やお客様の情報は残さない）
--   記録は integration_runs（kind = 'amazon_fba'）
--   組立を始める期限 = 欠品しそうな日 − 組立から FBA 受領までの日数（代表に聞いて 10日にした）
--   補充の目安 = 受領してから fba_cover_days 日分売れる数に足りない台数
-- =====================================================================

BEGIN;

ALTER TABLE core.integration_runs DROP CONSTRAINT integration_runs_kind_check;
ALTER TABLE core.integration_runs ADD CONSTRAINT integration_runs_kind_check
  CHECK (kind IN ('amazon_orders', 'db_backup', 'restore_test', 'amazon_fba'));

UPDATE core.settings SET value = '10' WHERE key = 'fba_lead_time_days';
INSERT INTO core.settings (key, value, description) VALUES
  ('fba_cover_days', '30', 'FBA の補充の目安：受領してから何日分売れる台数をそろえるか'),
  ('fba_warn_days', '3', '組立を始める期限の何日前から「もうすぐ」と知らせるか')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX ON core.fba_inventory_snapshots (captured_at);

COMMIT;
