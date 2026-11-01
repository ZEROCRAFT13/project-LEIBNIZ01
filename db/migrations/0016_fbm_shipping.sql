-- =====================================================================
-- Amazon の自社出荷（FBM）。まずは手で記録する（SP-API での注文の取り込み・出荷通知は後で足す）
--   注文（orders: channel = 'amazon', is_fba = false）を注文番号で登録し、
--   出荷待ちの個体の管理番号を読んで結びつける（order_units: link_method = 'shipping'）。
--   箱（個体）ごとに送り状番号を入れて「発送した」→ 個体は「出荷済み」（お客様へ）。
--   Amazon への出荷通知は、当面はセラーセントラルで人が行い、行ったことをここに記録する。
--   お客様の名前・住所はこのシステムに持たない（送り状はセラーセントラルや運送会社のシステムで作る）
-- =====================================================================

BEGIN;

ALTER TABLE core.orders
  ADD COLUMN ship_by           date,          -- 出荷期限（Amazon の注文に出ている日）
  ADD COLUMN carrier           text CHECK (carrier IN ('yamato', 'sagawa', 'japanpost', 'seino', 'amazon', 'other')),
  ADD COLUMN shipped_at        timestamptz,
  ADD COLUMN ship_notified_at  timestamptz,   -- Amazon に出荷を通知した（当面は人がセラーセントラルで）
  ADD COLUMN ship_notified_by  bigint REFERENCES core.users(id),
  ADD COLUMN cancel_reason     text CHECK (length(cancel_reason) <= 200),
  ADD COLUMN note              text CHECK (length(note) <= 500),
  ADD COLUMN created_by        bigint REFERENCES core.users(id),
  ADD CONSTRAINT orders_amazon_no_format CHECK (channel <> 'amazon' OR external_order_no ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'),
  ADD CONSTRAINT orders_notified_after_ship CHECK (ship_notified_at IS NULL OR shipped_at IS NOT NULL),
  ADD CONSTRAINT orders_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL);

ALTER TABLE core.order_units
  ADD COLUMN tracking_no text CHECK (tracking_no ~ '^[0-9A-Z-]{6,30}$');

-- 1台の個体が同時に2つの注文に結びつかないことは、0001 の order_units_active_uq が守る

-- ---------- 出荷のための結びつけ（link_method = 'shipping'）の決まり ----------
CREATE FUNCTION core.order_units_shipping_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order  core.orders%ROWTYPE;
  v_unit   record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '注文と個体の結びつきは消せません（外すときは unlinked_at に理由を書きます）';
  END IF;
  SELECT * INTO v_order FROM core.orders WHERE id = NEW.order_id;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_id <> OLD.order_id OR NEW.unit_id <> OLD.unit_id OR NEW.link_method <> OLD.link_method THEN
      RAISE EXCEPTION '注文と個体の結びつきは付け替えられません（外して結び直してください）';
    END IF;
    IF OLD.link_method = 'shipping' THEN
      IF OLD.unlinked_at IS NOT NULL AND NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at THEN
        RAISE EXCEPTION '外した結びつきは戻せません（結び直してください）';
      END IF;
      IF NEW.unlinked_at IS NOT NULL AND OLD.unlinked_at IS NULL AND v_order.status <> 'open' THEN
        RAISE EXCEPTION '発送した注文から個体は外せません';
      END IF;
      IF NEW.tracking_no IS DISTINCT FROM OLD.tracking_no AND v_order.status NOT IN ('open', 'shipped') THEN
        RAISE EXCEPTION 'この注文の送り状番号は、もう直せません';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.link_method <> 'shipping' THEN
    RETURN NEW;   -- 製品登録・問い合わせでの結びつき（FBA の注文など）は、これまでどおり
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'この注文は受付中ではありません（今の状態: %）', v_order.status;
  END IF;
  IF v_order.is_fba THEN
    RAISE EXCEPTION 'FBA の注文は Amazon が出荷します。出荷のための結びつけはできません';
  END IF;
  SELECT u.mgmt_no, u.status, u.sku_id INTO v_unit FROM core.units u WHERE u.id = NEW.unit_id;
  IF v_unit.status <> 'ready' THEN
    RAISE EXCEPTION '% は出荷待ちではありません', v_unit.mgmt_no;
  END IF;
  IF EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
              WHERE su.unit_id = NEW.unit_id AND s.status <> 'cancelled') THEN
    RAISE EXCEPTION '% は FBA の納品に入っています', v_unit.mgmt_no;
  END IF;
  -- 注文の商品（機種）と数に合っているかは、0001 の order_units_check が見る
  RETURN NEW;
END $$;
CREATE TRIGGER order_units_shipping_check BEFORE INSERT OR UPDATE OR DELETE ON core.order_units
  FOR EACH ROW EXECUTE FUNCTION core.order_units_shipping_check();
REVOKE DELETE ON core.order_units FROM zb_app;

-- ---------- 自社出荷の注文の状態の移り方と、個体の状態 ----------
CREATE FUNCTION core.orders_fbm_flow() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_short integer;
BEGIN
  IF NEW.is_fba OR NEW.channel <> 'amazon' THEN
    RETURN NEW;   -- FBA と直販は、このトリガーの対象外（直販の出荷は別に作る）
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.external_order_no <> OLD.external_order_no AND OLD.status <> 'open' THEN
      RAISE EXCEPTION '発送した注文の注文番号は変えられません';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('shipped', 'cancelled'))
       OR (OLD.status = 'shipped' AND NEW.status IN ('delivered', 'returned'))
       OR (OLD.status = 'delivered' AND NEW.status = 'returned')) THEN
    RAISE EXCEPTION '注文の状態は % から % には変えられません', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'shipped' THEN
    -- 注文の数だけ個体が結びつき、全部に送り状番号がある
    SELECT count(*) INTO v_short
      FROM core.order_lines l
     WHERE l.order_id = NEW.id
       AND (SELECT count(*) FROM core.order_units ou JOIN core.units u ON u.id = ou.unit_id
             WHERE ou.order_id = NEW.id AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'
               AND u.sku_id = l.sku_id) < l.qty;
    IF v_short > 0 THEN
      RAISE EXCEPTION 'まだ個体が結びついていない商品があります';
    END IF;
    IF EXISTS (SELECT 1 FROM core.order_units WHERE order_id = NEW.id AND unlinked_at IS NULL
                AND link_method = 'shipping' AND tracking_no IS NULL) THEN
      RAISE EXCEPTION '送り状番号が入っていない箱があります';
    END IF;
    IF NEW.carrier IS NULL THEN
      RAISE EXCEPTION '運送会社を選んでください';
    END IF;
    IF NEW.shipped_at IS NULL THEN
      NEW.shipped_at := now();
    END IF;
    UPDATE core.units u
       SET status = 'shipped', shipped_at = NEW.shipped_at, ship_destination = 'customer'
      FROM core.order_units ou
     WHERE ou.order_id = NEW.id AND ou.unit_id = u.id AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping';
  ELSIF NEW.status = 'cancelled' THEN
    IF EXISTS (SELECT 1 FROM core.order_units WHERE order_id = NEW.id AND unlinked_at IS NULL AND link_method = 'shipping') THEN
      RAISE EXCEPTION '結びついている個体を外してから取り消してください';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_fbm_flow BEFORE UPDATE ON core.orders
  FOR EACH ROW EXECUTE FUNCTION core.orders_fbm_flow();

CREATE FUNCTION core.orders_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '注文は消せません（取り消しにします）';
END $$;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON core.orders
  FOR EACH ROW EXECUTE FUNCTION core.orders_no_delete();

CREATE INDEX ON core.orders (channel, is_fba, status, ship_by);

COMMIT;
