-- =====================================================================
-- 機種ごとに Amazon の出荷方法を決め、出品（セラー SKU と ASIN）を登録する
--   skus.amazon_fulfillment
--     fba  … FBA で売る（台数の出るバリューモデルなど）
--     fbm  … 自社出荷で売る（高額で台数の少ない機種、利益率を守りたい機種）
--     both … FBA が主。FBA の在庫が切れている間だけ自社出荷でも売る
--     NULL … Amazon では売らない（直販だけ）
--   amazon_listings … 1つの機種に、FBA 用と自社出荷用の出品を1つずつまで（使っているもの）。
--     セラー SKU は Amazon 側の出品の番号なので、一度使った番号は別の機種に使わない（止めた出品も残す）
-- =====================================================================

BEGIN;

ALTER TABLE core.skus
  ADD COLUMN amazon_fulfillment text CHECK (amazon_fulfillment IN ('fba', 'fbm', 'both'));

CREATE TABLE core.amazon_listings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_id      bigint NOT NULL REFERENCES core.skus(id),
  fulfillment text NOT NULL CHECK (fulfillment IN ('fba', 'fbm')),
  seller_sku  text NOT NULL UNIQUE CHECK (seller_sku ~ '^[!-~]{1,40}$'),   -- 半角の英数字と記号（空白なし）40文字まで
  asin        text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX amazon_listings_one_active ON core.amazon_listings (sku_id, fulfillment) WHERE active;
CREATE TRIGGER amazon_listings_touch BEFORE UPDATE ON core.amazon_listings
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

-- 出品をほかの機種や出荷方法に付け替えない（売上・納品の記録がずれるため）。消さずに止める
CREATE FUNCTION core.amazon_listings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Amazon の出品は消せません（使わなくなったら止めます）';
  END IF;
  IF NEW.sku_id <> OLD.sku_id OR NEW.fulfillment <> OLD.fulfillment THEN
    RAISE EXCEPTION 'Amazon の出品を、ほかの機種や出荷方法に付け替えることはできません（新しく登録してください）';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amazon_listings_guard BEFORE UPDATE OR DELETE ON core.amazon_listings
  FOR EACH ROW EXECUTE FUNCTION core.amazon_listings_guard();
CREATE TRIGGER audit_amazon_listings AFTER INSERT OR UPDATE OR DELETE ON core.amazon_listings
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

GRANT SELECT, INSERT, UPDATE ON core.amazon_listings TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.amazon_listings_id_seq TO zb_app;
GRANT SELECT ON core.amazon_listings TO zb_pii, zb_auditor;

COMMIT;
