-- =====================================================================
-- 機種（SKU）の構成表を画面から直せるようにするための決まり
--   ・機種のコードと枠の名前の形をそろえる
--   ・枠に使ってよい型番は、枠と同じ種類の部品だけ（GPU の枠にメモリを入れない）
--   ・組立中・組立予定の個体がある機種は、枠を消したり名前・種類を変えたりできない（数や使える型番は変えられる）
--   ・使ってよい型番の追加・削除も監査ログに残す
-- =====================================================================

BEGIN;

ALTER TABLE core.skus
  ADD CONSTRAINT skus_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,29}$'),
  ADD CONSTRAINT skus_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 100);
ALTER TABLE core.sku_slots
  ADD CONSTRAINT sku_slots_slot_format CHECK (slot ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  ADD CONSTRAINT sku_slots_category_check CHECK (category IN
    ('cpu','gpu','motherboard','memory','ssd','psu','cooler','case','fan','os','other'));

-- 枠と同じ種類の型番だけを使ってよい型番にできる
CREATE FUNCTION core.sku_slot_options_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_slot_category  text;
  v_model_category text;
BEGIN
  SELECT category INTO v_slot_category FROM core.sku_slots WHERE id = NEW.slot_id;
  SELECT category INTO v_model_category FROM core.part_models WHERE id = NEW.part_model_id;
  IF v_slot_category IS DISTINCT FROM v_model_category THEN
    RAISE EXCEPTION 'この枠（%）には、種類のちがう部品（%）は入れられません', v_slot_category, v_model_category;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sku_slot_options_check BEFORE INSERT OR UPDATE ON core.sku_slot_options
  FOR EACH ROW EXECUTE FUNCTION core.sku_slot_options_check();

-- 組立中・組立予定の個体がある機種の枠は、消したり名前・種類を変えたりできない
CREATE FUNCTION core.sku_slots_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.slot = OLD.slot AND NEW.category = OLD.category AND NEW.sku_id = OLD.sku_id THEN
    RETURN NEW;  -- 数や並び順だけの変更はよい
  END IF;
  IF EXISTS (SELECT 1 FROM core.units WHERE sku_id = OLD.sku_id AND status IN ('planned', 'assembling')) THEN
    RAISE EXCEPTION '組立中の個体がある機種の枠（%）は、消したり変えたりできません。組立が終わってから直してください', OLD.slot;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER sku_slots_guard BEFORE UPDATE OR DELETE ON core.sku_slots
  FOR EACH ROW EXECUTE FUNCTION core.sku_slots_guard();

-- 種類のちがう型番を、あとから種類を変えて枠にすべり込ませない
CREATE FUNCTION core.part_models_category_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category <> OLD.category
     AND EXISTS (SELECT 1 FROM core.sku_slot_options WHERE part_model_id = NEW.id) THEN
    RAISE EXCEPTION '機種の構成表で使っている型番は、種類を変えられません。先に構成表から外してください';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER part_models_category_guard BEFORE UPDATE OF category ON core.part_models
  FOR EACH ROW EXECUTE FUNCTION core.part_models_category_guard();

CREATE TRIGGER audit_sku_slot_options AFTER INSERT OR UPDATE OR DELETE ON core.sku_slot_options
  FOR EACH ROW EXECUTE FUNCTION audit.record('slot_id');

COMMIT;
