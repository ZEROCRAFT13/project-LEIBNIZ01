-- =====================================================================
-- FBA 納品（まずは手で記録する。SP-API での納品プラン作成・受領の取り込みは後で足す）
--   1つの納品（fba_shipments）＝ Amazon の1つの出荷（FBA15… の番号、1つの倉庫あて）
--   下書き（draft）… 出荷待ちで、FBA で売る機種（fba / both）の個体を入れる。1台＝1箱で、送り状番号は個体ごと
--   発送（shipped）… 入れた個体は「FBA へ輸送中」になる。もう個体を入れ替えられない
--   受領中（receiving）… セラーセントラルの受領数を機種ごとに入れる
--   完了（closed）… 全部受領されたら。入れた個体は「FBA 在庫」になる
--   取り消し（cancelled）… 下書きのときだけ
-- 個体の状態は、納品の状態が変わったときにトリガーで一緒に変える（ずれないように）
-- =====================================================================

BEGIN;

ALTER TABLE core.fba_shipments
  ADD COLUMN carrier        text CHECK (carrier IN ('yamato', 'sagawa', 'japanpost', 'seino', 'amazon', 'other')),
  ADD COLUMN destination_fc text CHECK (destination_fc ~ '^[A-Z0-9]{3,5}$'),   -- 納品先の倉庫（例 NRT5）
  ADD COLUMN note           text CHECK (length(note) <= 500),
  ADD COLUMN created_by     bigint REFERENCES core.users(id),
  ADD CONSTRAINT fba_shipments_amazon_id_format CHECK (amazon_shipment_id ~ '^FBA[0-9A-Z]{6,12}$'),
  ADD CONSTRAINT fba_shipments_shipped_has_id CHECK (status IN ('draft', 'cancelled') OR amazon_shipment_id IS NOT NULL),
  ADD CONSTRAINT fba_shipments_shipped_at CHECK (status IN ('draft', 'cancelled') OR shipped_at IS NOT NULL),
  ADD CONSTRAINT fba_shipments_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL));
CREATE INDEX ON core.fba_shipments (status, created_at);

ALTER TABLE core.fba_shipment_units
  ADD COLUMN tracking_no text CHECK (tracking_no ~ '^[0-9A-Z-]{6,30}$'),
  ADD COLUMN added_by    bigint REFERENCES core.users(id),
  ADD COLUMN added_at    timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON core.fba_shipment_units (unit_id);

-- 受領数（セラーセントラルの「受領済み」を機種ごとに）
CREATE TABLE core.fba_shipment_receipts (
  shipment_id  bigint NOT NULL REFERENCES core.fba_shipments(id),
  sku_id       bigint NOT NULL REFERENCES core.skus(id),
  received_qty integer NOT NULL CHECK (received_qty >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, sku_id)
);
CREATE TRIGGER fba_shipment_receipts_touch BEFORE UPDATE ON core.fba_shipment_receipts
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

-- ---------- 納品に入れる個体の決まり ----------
CREATE FUNCTION core.fba_shipment_units_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_unit     record;
BEGIN
  SELECT status INTO v_status FROM core.fba_shipments
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.shipment_id ELSE NEW.shipment_id END;

  IF TG_OP = 'DELETE' THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION '発送した納品からは、個体を外せません';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.shipment_id <> OLD.shipment_id OR NEW.unit_id <> OLD.unit_id
       OR NEW.added_by IS DISTINCT FROM OLD.added_by OR NEW.added_at <> OLD.added_at THEN
      RAISE EXCEPTION '納品に入れた個体は入れ替えられません（外して入れ直してください）';
    END IF;
    IF v_status IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION '完了・取り消しの納品は直せません';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION '発送した納品には、個体を足せません（新しい納品を作ってください）';
  END IF;
  SELECT u.mgmt_no, u.status, k.code AS sku_code, k.amazon_fulfillment
    INTO v_unit
    FROM core.units u JOIN core.skus k ON k.id = u.sku_id
   WHERE u.id = NEW.unit_id;
  IF v_unit.status <> 'ready' THEN
    RAISE EXCEPTION '% は出荷待ちではありません（検品が終わった個体だけ納品できます）', v_unit.mgmt_no;
  END IF;
  IF v_unit.amazon_fulfillment IS NULL OR v_unit.amazon_fulfillment NOT IN ('fba', 'both') THEN
    RAISE EXCEPTION '% の機種（%）は FBA で売る設定ではありません', v_unit.mgmt_no, v_unit.sku_code;
  END IF;
  IF EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
              WHERE su.unit_id = NEW.unit_id AND s.status <> 'cancelled') THEN
    RAISE EXCEPTION '% は、もう別の納品に入っています', v_unit.mgmt_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fba_shipment_units_check BEFORE INSERT OR UPDATE OR DELETE ON core.fba_shipment_units
  FOR EACH ROW EXECUTE FUNCTION core.fba_shipment_units_check();

-- ---------- 受領数の決まり ----------
CREATE FUNCTION core.fba_shipment_receipts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_sent   integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '受領数は消せません（0 にしてください）';
  END IF;
  SELECT status INTO v_status FROM core.fba_shipments WHERE id = NEW.shipment_id;
  IF v_status NOT IN ('shipped', 'receiving') THEN
    RAISE EXCEPTION '受領数は、発送してから完了するまでの間だけ入れられます';
  END IF;
  SELECT count(*) INTO v_sent
    FROM core.fba_shipment_units su JOIN core.units u ON u.id = su.unit_id
   WHERE su.shipment_id = NEW.shipment_id AND u.sku_id = NEW.sku_id;
  IF v_sent = 0 THEN
    RAISE EXCEPTION 'この納品に、その機種は入っていません';
  END IF;
  IF NEW.received_qty > v_sent THEN
    RAISE EXCEPTION '受領数（%）が、送った台数（%）より多くなっています', NEW.received_qty, v_sent;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fba_shipment_receipts_check BEFORE INSERT OR UPDATE OR DELETE ON core.fba_shipment_receipts
  FOR EACH ROW EXECUTE FUNCTION core.fba_shipment_receipts_check();

-- ---------- 納品の状態の移り方と、個体の状態 ----------
CREATE FUNCTION core.fba_shipments_flow() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_short integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '納品は消せません（下書きなら取り消しにします）';
  END IF;
  IF NEW.status = OLD.status THEN
    -- 発送したあとは、Amazon の番号を変えない
    IF OLD.status <> 'draft' AND NEW.amazon_shipment_id IS DISTINCT FROM OLD.amazon_shipment_id THEN
      RAISE EXCEPTION '発送した納品の Amazon の番号は変えられません';
    END IF;
    IF OLD.status IN ('closed', 'cancelled')
       AND (NEW.carrier IS DISTINCT FROM OLD.carrier OR NEW.destination_fc IS DISTINCT FROM OLD.destination_fc
            OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at) THEN
      RAISE EXCEPTION '完了・取り消しの納品は直せません（メモだけ書けます）';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('shipped', 'cancelled'))
       OR (OLD.status = 'shipped' AND NEW.status IN ('receiving', 'closed'))
       OR (OLD.status = 'receiving' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION '納品の状態は % から % には変えられません', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'shipped' THEN
    IF NOT EXISTS (SELECT 1 FROM core.fba_shipment_units WHERE shipment_id = NEW.id) THEN
      RAISE EXCEPTION '個体が1台も入っていない納品は発送できません';
    END IF;
    IF EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.units u ON u.id = su.unit_id
                WHERE su.shipment_id = NEW.id AND u.status <> 'ready') THEN
      RAISE EXCEPTION '出荷待ちでない個体が入っています（検品をやり直した個体など）。外してから発送してください';
    END IF;
    UPDATE core.units u
       SET status = 'inbound_to_fba', shipped_at = NEW.shipped_at, ship_destination = 'fba'
      FROM core.fba_shipment_units su
     WHERE su.shipment_id = NEW.id AND su.unit_id = u.id;
  ELSIF NEW.status = 'closed' THEN
    SELECT count(*) INTO v_short
      FROM (SELECT u.sku_id, count(*) AS sent
              FROM core.fba_shipment_units su JOIN core.units u ON u.id = su.unit_id
             WHERE su.shipment_id = NEW.id GROUP BY u.sku_id) s
      LEFT JOIN core.fba_shipment_receipts r ON r.shipment_id = NEW.id AND r.sku_id = s.sku_id
     WHERE coalesce(r.received_qty, 0) < s.sent;
    IF v_short > 0 THEN
      RAISE EXCEPTION 'まだ受領されていない機種があります。全部受領されてから完了にしてください';
    END IF;
    UPDATE core.units u
       SET status = 'at_fba'
      FROM core.fba_shipment_units su
     WHERE su.shipment_id = NEW.id AND su.unit_id = u.id AND u.status = 'inbound_to_fba';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fba_shipments_flow BEFORE UPDATE OR DELETE ON core.fba_shipments
  FOR EACH ROW EXECUTE FUNCTION core.fba_shipments_flow();

-- 監査ログ（fba_shipments は 0001 で対象。個体の出し入れと受領数も残す）
CREATE TRIGGER audit_fba_shipment_units AFTER INSERT OR UPDATE OR DELETE ON core.fba_shipment_units
  FOR EACH ROW EXECUTE FUNCTION audit.record('unit_id');
CREATE TRIGGER audit_fba_shipment_receipts AFTER INSERT OR UPDATE OR DELETE ON core.fba_shipment_receipts
  FOR EACH ROW EXECUTE FUNCTION audit.record('shipment_id');

GRANT SELECT, INSERT, UPDATE ON core.fba_shipment_receipts TO zb_app;
REVOKE DELETE ON core.fba_shipments, core.fba_shipment_receipts FROM zb_app;
GRANT SELECT ON core.fba_shipment_receipts TO zb_pii, zb_auditor;

COMMIT;
