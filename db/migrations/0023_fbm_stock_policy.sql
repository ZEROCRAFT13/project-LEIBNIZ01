-- =====================================================================
-- 自社出荷の作り方と、Amazon の出品数の反映（仕様書 F5）
--   skus.fbm_policy … 自社出荷で売る機種の作り方。代表に聞いて、機種ごとに選べるようにした
--     stock    … 作り置き。出荷待ちを fbm_stock_target 台に保つ（減ったら工場長の ToDo）。Amazon の出品数＝出荷待ちの台数
--     to_order … 注文を受けてから組む。Amazon の出品数＝出荷待ち＋部品の在庫で組める台数（fbm_max_to_order 台まで）
--   「両方」の機種は、FBA に販売できる在庫があるあいだ自社出荷の出品数を 0 にする（計算はアプリ）
--   出品数を Amazon に送るのは、画面で数を見て承認したときだけ（ルール4）。記録は outbound_actions（kind = 'amazon_listing_qty'）
-- =====================================================================

BEGIN;

ALTER TABLE core.skus
  ADD COLUMN fbm_policy text NOT NULL DEFAULT 'stock' CHECK (fbm_policy IN ('stock', 'to_order')),
  ADD COLUMN fbm_stock_target integer NOT NULL DEFAULT 1 CHECK (fbm_stock_target BETWEEN 0 AND 50),
  ADD COLUMN fbm_max_to_order integer NOT NULL DEFAULT 2 CHECK (fbm_max_to_order BETWEEN 0 AND 20);

ALTER TABLE core.outbound_actions DROP CONSTRAINT outbound_actions_kind_check;
ALTER TABLE core.outbound_actions ADD CONSTRAINT outbound_actions_kind_check
  CHECK (kind IN ('amazon_ship_confirm', 'amazon_listing_qty'));
ALTER TABLE core.outbound_actions DROP CONSTRAINT outbound_actions_subject_type_check;
ALTER TABLE core.outbound_actions ADD CONSTRAINT outbound_actions_subject_type_check
  CHECK (subject_type IN ('order', 'sku'));

COMMIT;
