-- =====================================================================
-- 構成表の枠を「付けなくてもよい」にできるようにし、「自由枠」と「個体のメモ」を足す
--   ・required = false の枠は、付けなくても組立を完了できる（直販の機種のケースファンなど）
--     Amazon 用の機種は required = true のまま、型番を決めて固定できる
--   ・any_part = true の枠（自由枠）は、登録済みの部品なら種類を問わず付けられる（Wi-Fiカード、追加のSSDなど）
--   ・個体のメモは、在庫を使わない作業や部品を文字で残す（LEDテープ追加、ケーブル交換など）。
--     お客様の個人情報は書かない（画面にも注意を出す）
-- =====================================================================

BEGIN;

ALTER TABLE core.sku_slots
  ADD COLUMN required boolean NOT NULL DEFAULT true,
  ADD COLUMN any_part boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT sku_slots_any_part_other CHECK (NOT any_part OR category = 'other');

-- 自由枠には「使ってよい型番」を決めない（何でも入るため）
CREATE OR REPLACE FUNCTION core.sku_slot_options_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_slot_category  text;
  v_any_part       boolean;
  v_model_category text;
BEGIN
  SELECT category, any_part INTO v_slot_category, v_any_part FROM core.sku_slots WHERE id = NEW.slot_id;
  IF v_any_part THEN
    RAISE EXCEPTION '自由枠には型番を決めなくても、登録済みの部品なら何でも付けられます';
  END IF;
  SELECT category INTO v_model_category FROM core.part_models WHERE id = NEW.part_model_id;
  IF v_slot_category IS DISTINCT FROM v_model_category THEN
    RAISE EXCEPTION 'この枠（%）には、種類のちがう部品（%）は入れられません', v_slot_category, v_model_category;
  END IF;
  RETURN NEW;
END $$;

-- 組立の取り付け：構成表の型番か、自由枠なら通す（それ以外は理由が要る）
CREATE OR REPLACE FUNCTION core.unit_parts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM core.units u
      JOIN core.sku_slots s        ON s.sku_id = u.sku_id AND s.slot = NEW.slot
      JOIN core.sku_slot_options o ON o.slot_id = s.id
      JOIN core.part_items p       ON p.part_model_id = o.part_model_id
      WHERE u.id = NEW.unit_id AND p.id = NEW.part_item_id
    ) OR EXISTS (
      SELECT 1
      FROM core.units u
      JOIN core.sku_slots s ON s.sku_id = u.sku_id AND s.slot = NEW.slot
      WHERE u.id = NEW.unit_id AND s.any_part
    ) INTO v_ok;
    IF NOT v_ok AND NEW.override_reason IS NULL THEN
      RAISE EXCEPTION '構成表にない部品です（枠: %）。使う場合は override_reason に理由を書いてください', NEW.slot;
    END IF;
    UPDATE core.part_items SET status = 'installed' WHERE id = NEW.part_item_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    UPDATE core.part_items SET status = 'in_stock'
     WHERE id = NEW.part_item_id AND status = 'installed';
  END IF;
  RETURN NEW;
END $$;

-- 個体のメモ（消さずに「取り消し」にする。誰がいつ書いたかを残す）
CREATE TABLE core.unit_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id    bigint NOT NULL REFERENCES core.units(id),
  note       text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 200),
  created_by bigint REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by bigint REFERENCES core.users(id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX ON core.unit_notes (unit_id);
CREATE TRIGGER audit_unit_notes AFTER INSERT OR UPDATE OR DELETE ON core.unit_notes
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

GRANT SELECT, INSERT, UPDATE ON core.unit_notes TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.unit_notes_id_seq TO zb_app;
GRANT SELECT ON core.unit_notes TO zb_pii, zb_auditor;

COMMIT;
