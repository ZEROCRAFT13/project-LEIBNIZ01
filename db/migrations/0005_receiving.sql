-- =====================================================================
-- 入荷（仕入れた部品を1個ずつ在庫に入れる）
--   ・仕入れの明細の数より多くは入荷できない。明細と違う型番をひもづけない
--   ・取り消し済みの仕入れには入荷できない
--   ・仕入れの状態（注文済み／一部入荷／入荷済み）は、入荷した部品の数から自動で決める
-- =====================================================================

BEGIN;

CREATE FUNCTION core.part_items_check_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_line   record;
  v_count  integer;
BEGIN
  IF NEW.purchase_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.purchase_line_id IS NOT DISTINCT FROM OLD.purchase_line_id
     AND NEW.part_model_id = OLD.part_model_id THEN
    RETURN NEW;  -- ひもづけが変わらない更新（状態や棚番の変更）は確かめなくてよい
  END IF;

  -- 同時に入荷しても数を超えないよう、明細の行を押さえてから数える
  SELECT l.part_model_id, l.qty, p.status AS purchase_status
    INTO v_line
    FROM core.purchase_lines l JOIN core.purchases p ON p.id = l.purchase_id
   WHERE l.id = NEW.purchase_line_id
     FOR UPDATE OF l;

  IF v_line.purchase_status = 'cancelled' THEN
    RAISE EXCEPTION '取り消した仕入れには入荷できません（明細 %）', NEW.purchase_line_id;
  END IF;
  IF v_line.part_model_id IS DISTINCT FROM NEW.part_model_id THEN
    RAISE EXCEPTION '仕入れの明細と型番が違います（明細 %）', NEW.purchase_line_id;
  END IF;

  SELECT count(*) INTO v_count
    FROM core.part_items
   WHERE purchase_line_id = NEW.purchase_line_id AND id <> NEW.id;
  IF v_count >= v_line.qty THEN
    RAISE EXCEPTION '仕入れの数（%個）より多くは入荷できません', v_line.qty;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER part_items_check_line BEFORE INSERT OR UPDATE OF purchase_line_id, part_model_id
  ON core.part_items FOR EACH ROW EXECUTE FUNCTION core.part_items_check_line();

-- 仕入れの状態を、入荷した数から決め直す（取り消し済みはそのまま）
-- 型番のない明細（送料・手数料など）は入荷を待たない
CREATE FUNCTION core.refresh_purchase_status(p_purchase_id bigint) RETURNS void
LANGUAGE sql AS $$
  UPDATE core.purchases p
     SET status = s.status
    FROM (SELECT CASE
                   WHEN count(*) > 0 AND bool_and(coalesce(r.n, 0) >= l.qty) THEN 'received'
                   WHEN coalesce(sum(r.n), 0) > 0                           THEN 'partially_received'
                   ELSE 'ordered'
                 END AS status
            FROM core.purchase_lines l
            LEFT JOIN (SELECT purchase_line_id, count(*) AS n
                         FROM core.part_items GROUP BY purchase_line_id) r ON r.purchase_line_id = l.id
           WHERE l.purchase_id = p_purchase_id AND l.part_model_id IS NOT NULL) s
   WHERE p.id = p_purchase_id AND p.status <> 'cancelled' AND p.status <> s.status
$$;

CREATE FUNCTION core.part_items_refresh_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.purchase_line_id IS NOT NULL THEN
    PERFORM core.refresh_purchase_status((SELECT purchase_id FROM core.purchase_lines WHERE id = OLD.purchase_line_id));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.purchase_line_id IS NOT NULL THEN
    PERFORM core.refresh_purchase_status((SELECT purchase_id FROM core.purchase_lines WHERE id = NEW.purchase_line_id));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER part_items_refresh_purchase AFTER INSERT OR DELETE OR UPDATE OF purchase_line_id
  ON core.part_items FOR EACH ROW EXECUTE FUNCTION core.part_items_refresh_purchase();

GRANT EXECUTE ON FUNCTION core.refresh_purchase_status(bigint) TO zb_app;

COMMIT;
