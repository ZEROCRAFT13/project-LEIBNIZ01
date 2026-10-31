-- 開発用: 機種ごとの Amazon の出荷方法と出品（ASIN はダミー。B0ZBDUMMY… は実在しない番号）
--   ZB-G5060-R5（台数の出るバリューモデル）… FBA
--   ZB-G5070-R7 … 両方（FBA が主、切れている間は自社出荷）
BEGIN;
SET LOCAL app.actor_kind = 'system';
UPDATE core.skus SET amazon_fulfillment = 'fba'  WHERE code = 'ZB-G5060-R5';
UPDATE core.skus SET amazon_fulfillment = 'both' WHERE code = 'ZB-G5070-R7';
INSERT INTO core.amazon_listings (sku_id, fulfillment, seller_sku, asin)
SELECT s.id, v.fulfillment, v.seller_sku, v.asin
  FROM (VALUES
    ('ZB-G5060-R5', 'fba', 'ZB-G5060-R5-FBA', 'B0ZBDUMMY1'),
    ('ZB-G5070-R7', 'fba', 'ZB-G5070-R7-FBA', 'B0ZBDUMMY2'),
    ('ZB-G5070-R7', 'fbm', 'ZB-G5070-R7-FBM', 'B0ZBDUMMY2')
  ) AS v(code, fulfillment, seller_sku, asin)
  JOIN core.skus s ON s.code = v.code;
COMMIT;
