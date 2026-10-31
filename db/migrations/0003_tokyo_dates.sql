-- =====================================================================
-- 日付を日本時間で数える
-- 0001 では保証の起算日・FBAの期限・管理番号の年月を、DBの設定時刻（Cloud SQL では UTC）で
-- 数えていた。日本時間の 0〜9時の注文が前日扱いになるので、日本時間に固定する。
-- =====================================================================

BEGIN;

-- 今日の日付（日本時間）
CREATE FUNCTION core.today_jst() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date $$;

-- 管理番号の年月も日本時間で決める
CREATE OR REPLACE FUNCTION core.next_mgmt_no(p_on date DEFAULT core.today_jst()) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_yymm text := to_char(p_on, 'YYMM');
  v_no   integer;
BEGIN
  INSERT INTO core.mgmt_no_counters AS c (yymm, last_no) VALUES (v_yymm, 1)
  ON CONFLICT (yymm) DO UPDATE SET last_no = c.last_no + 1
  RETURNING last_no INTO v_no;
  IF v_no > 9999 THEN
    RAISE EXCEPTION '% の管理番号が上限（9999）を超えました', v_yymm;
  END IF;
  RETURN 'ZB-' || v_yymm || '-' || lpad(v_no::text, 4, '0');
END $$;

-- 保証期間（起算日を日本時間の日付にする）
CREATE OR REPLACE VIEW core.v_unit_warranty AS
SELECT u.id AS unit_id, u.mgmt_no, s.code AS sku_code, u.status,
       (coalesce(o.ordered_at, u.shipped_at) AT TIME ZONE 'Asia/Tokyo')::date AS warranty_start,
       ((coalesce(o.ordered_at, u.shipped_at) AT TIME ZONE 'Asia/Tokyo')::date
          + make_interval(months => u.warranty_months))::date AS warranty_end,
       u.warranty_months,
       (pr.id IS NOT NULL) AS registered
FROM core.units u
JOIN core.skus s ON s.id = u.sku_id
LEFT JOIN core.order_units ou ON ou.unit_id = u.id AND ou.unlinked_at IS NULL
LEFT JOIN core.orders o ON o.id = ou.order_id
LEFT JOIN core.product_registrations pr ON pr.unit_id = u.id;

-- FBA在庫の残り日数と、組立を始める期限（日本時間の今日から数える）
CREATE OR REPLACE VIEW core.v_fba_runway AS
WITH cfg AS (
  SELECT (SELECT (value #>> '{}')::int FROM core.settings WHERE key = 'fba_lead_time_days')     AS lead_days,
         (SELECT (value #>> '{}')::int FROM core.settings WHERE key = 'sales_pace_window_days') AS window_days,
         core.today_jst() AS today
), latest AS (
  SELECT DISTINCT ON (sku_id) sku_id, captured_at, fulfillable, inbound
  FROM core.fba_inventory_snapshots
  ORDER BY sku_id, captured_at DESC
), pace AS (
  SELECT m.sku_id, sum(m.units_ordered)::numeric / max(cfg.window_days) AS per_day
  FROM core.sku_daily_metrics m, cfg
  WHERE m.channel = 'amazon' AND m.metric_date > cfg.today - cfg.window_days
  GROUP BY m.sku_id
)
SELECT s.id AS sku_id, s.code AS sku_code,
       l.fulfillable, l.inbound,
       round(p.per_day, 2) AS per_day,
       CASE WHEN p.per_day > 0 THEN round((l.fulfillable + l.inbound) / p.per_day, 1) END AS days_left,
       CASE WHEN p.per_day > 0
            THEN cfg.today + floor((l.fulfillable + l.inbound) / p.per_day)::int - cfg.lead_days END
         AS start_assembly_by
FROM core.skus s
CROSS JOIN cfg
JOIN latest l ON l.sku_id = s.id
LEFT JOIN pace p ON p.sku_id = s.id
WHERE s.active;

GRANT EXECUTE ON FUNCTION core.today_jst() TO zb_app;
GRANT SELECT ON core.v_unit_warranty, core.v_fba_runway TO zb_app, zb_pii, zb_auditor;

COMMIT;
