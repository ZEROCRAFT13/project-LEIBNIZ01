-- =====================================================================
-- 外に出る操作の記録（ルール4：お客様・Amazon などへ送るものは、人が中身を見て承認してから送る）
--   outbound_actions … 1回の「承認して送る」ごとの記録。何を送るか（payload）、誰がいつ承認したか、
--     送れたか・失敗したか（Amazon の応答の HTTP の番号と種類だけ。本文は残さない）
--   まずは Amazon への出荷通知（自社出荷の注文。kind = 'amazon_ship_confirm'）。出品数の反映などは kind を足していく
--   記録は消せない。終わった記録は変えられない（失敗したら、新しく承認して送り直す）
--   orders.ship_notified_via … 出荷通知をどこで行ったか（セラーセントラルで人が／この画面から SP-API で）
-- =====================================================================

BEGIN;

CREATE TABLE core.outbound_actions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('amazon_ship_confirm')),
  subject_type  text NOT NULL CHECK (subject_type IN ('order')),
  subject_id    bigint NOT NULL,
  payload       jsonb NOT NULL,                       -- 送る中身（承認した画面に出したもの）
  approved_by   bigint NOT NULL REFERENCES core.users(id),
  approved_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'sent', 'failed')),
  finished_at   timestamptz,
  error         text CHECK (length(error) <= 300),
  CHECK ((status = 'approved') = (finished_at IS NULL)),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX ON core.outbound_actions (subject_type, subject_id, approved_at DESC);

CREATE FUNCTION core.outbound_actions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '外に出る操作の記録は消せません';
  END IF;
  IF OLD.status <> 'approved' THEN
    RAISE EXCEPTION '終わった送信の記録は変えられません';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id
     OR NEW.payload <> OLD.payload OR NEW.approved_by <> OLD.approved_by OR NEW.approved_at <> OLD.approved_at THEN
    RAISE EXCEPTION '承認した中身は変えられません（新しく承認してください）';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_actions_guard BEFORE UPDATE OR DELETE ON core.outbound_actions
  FOR EACH ROW EXECUTE FUNCTION core.outbound_actions_guard();

CREATE TRIGGER audit_outbound_actions AFTER INSERT OR UPDATE OR DELETE ON core.outbound_actions
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

GRANT SELECT, INSERT, UPDATE ON core.outbound_actions TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.outbound_actions_id_seq TO zb_app;
GRANT SELECT ON core.outbound_actions TO zb_auditor;

ALTER TABLE core.orders
  ADD COLUMN ship_notified_via text CHECK (ship_notified_via IN ('seller_central', 'sp_api')),
  ADD CONSTRAINT orders_notified_via CHECK (ship_notified_via IS NULL OR ship_notified_at IS NOT NULL);
UPDATE core.orders SET ship_notified_via = 'seller_central' WHERE ship_notified_at IS NOT NULL;

COMMIT;
