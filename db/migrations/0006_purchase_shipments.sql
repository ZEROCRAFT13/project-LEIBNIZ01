-- =====================================================================
-- 仕入れの発送（輸送中）と追跡番号
--   ・1つの注文が何個口にも分かれて届くことがあるので、発送は別の表にする
--   ・発送が登録されて、まだ何も入荷していなければ「輸送中」
--   ・届いた荷物の送り状（追跡番号のバーコード）を読むと、その仕入れが開く
-- =====================================================================

BEGIN;

CREATE TABLE core.purchase_shipments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id  bigint NOT NULL REFERENCES core.purchases(id),
  carrier      text NOT NULL CHECK (carrier IN ('yamato','sagawa','japanpost','seino','amazon','other')),
  tracking_no  text NOT NULL CHECK (tracking_no ~ '^[0-9A-Z]{6,30}$'),  -- 数字と英大文字だけ（ハイフンなし）
  expected_on  date,                       -- 到着予定日（分かれば）
  delivered_at timestamptz,                -- 送り状を読んだ（荷物が届いた）時刻
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (carrier, tracking_no)
);
CREATE INDEX ON core.purchase_shipments (purchase_id);
CREATE INDEX ON core.purchase_shipments (tracking_no);

CREATE TRIGGER audit_purchase_shipments AFTER INSERT OR UPDATE OR DELETE ON core.purchase_shipments
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

-- 状態に「輸送中」を足す
ALTER TABLE core.purchases DROP CONSTRAINT purchases_status_check;
ALTER TABLE core.purchases ADD CONSTRAINT purchases_status_check
  CHECK (status IN ('ordered','in_transit','partially_received','received','cancelled'));

-- 仕入れの状態を決め直す（0005 の決め方に「輸送中」を足したもの）
CREATE OR REPLACE FUNCTION core.refresh_purchase_status(p_purchase_id bigint) RETURNS void
LANGUAGE sql AS $$
  UPDATE core.purchases p
     SET status = s.status
    FROM (SELECT CASE
                   WHEN count(*) > 0 AND bool_and(coalesce(r.n, 0) >= l.qty) THEN 'received'
                   WHEN coalesce(sum(r.n), 0) > 0                           THEN 'partially_received'
                   WHEN EXISTS (SELECT 1 FROM core.purchase_shipments sh
                                 WHERE sh.purchase_id = p_purchase_id)        THEN 'in_transit'
                   ELSE 'ordered'
                 END AS status
            FROM core.purchase_lines l
            LEFT JOIN (SELECT purchase_line_id, count(*) AS n
                         FROM core.part_items GROUP BY purchase_line_id) r ON r.purchase_line_id = l.id
           WHERE l.purchase_id = p_purchase_id AND l.part_model_id IS NOT NULL) s
   WHERE p.id = p_purchase_id AND p.status <> 'cancelled' AND p.status <> s.status
$$;

CREATE FUNCTION core.purchase_shipments_refresh_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.refresh_purchase_status(coalesce(NEW.purchase_id, OLD.purchase_id));
  IF TG_OP = 'UPDATE' AND NEW.purchase_id <> OLD.purchase_id THEN
    PERFORM core.refresh_purchase_status(OLD.purchase_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER purchase_shipments_refresh_purchase AFTER INSERT OR DELETE OR UPDATE OF purchase_id
  ON core.purchase_shipments FOR EACH ROW EXECUTE FUNCTION core.purchase_shipments_refresh_purchase();

-- 権限（0002 と同じ考え方）
GRANT SELECT, INSERT, UPDATE, DELETE ON core.purchase_shipments TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.purchase_shipments_id_seq TO zb_app;
GRANT SELECT ON core.purchase_shipments TO zb_pii, zb_auditor;

COMMIT;
