-- =====================================================================
-- 仕入れの下書き（注文確認メールから作る）と、ショップの商品名と型番の対応
--   ・メールの本文そのものは保存しない（宛名や住所が入っているため）。読み取った項目だけを残す
--   ・下書きは人が確かめて「確定」すると仕入れになる（自動で仕入れにはしない）
--   ・ショップの商品名と型番の対応は、一度選べば次から自動で当てる
-- =====================================================================

BEGIN;

CREATE TABLE core.purchase_drafts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source            text NOT NULL CHECK (source IN ('paste', 'email')),
  source_ref        text UNIQUE,                         -- メールのID（同じメールを二度読まない）
  parser            text NOT NULL,                       -- 例: 'dospara'
  supplier_id       bigint REFERENCES core.suppliers(id),
  supplier_order_no text,
  ordered_on        date,
  payment_method    text CHECK (payment_method IN ('card','bank','cash','cod','other')),
  total_amount      bigint CHECK (total_amount >= 0),    -- メールに書いてある合計（税込）
  lines             jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  issues            text[] NOT NULL DEFAULT '{}',        -- 読み取りで気になった点（合計が合わない など）
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'discarded')),
  purchase_id       bigint UNIQUE REFERENCES core.purchases(id),
  created_by        bigint REFERENCES core.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'confirmed') = (purchase_id IS NOT NULL))
);
-- 同じ注文の下書きを二重に作らない（捨てたものは除く）
CREATE UNIQUE INDEX purchase_drafts_order_uq ON core.purchase_drafts (parser, supplier_order_no)
  WHERE status <> 'discarded' AND supplier_order_no IS NOT NULL;
CREATE INDEX ON core.purchase_drafts (status, created_at);

CREATE TABLE core.supplier_item_aliases (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id   bigint NOT NULL REFERENCES core.suppliers(id),
  item_key      text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 300),  -- 商品名（そろえたもの）や ASIN
  part_model_id bigint NOT NULL REFERENCES core.part_models(id),
  created_by    bigint REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, item_key)
);

CREATE TRIGGER audit_purchase_drafts AFTER INSERT OR UPDATE OR DELETE ON core.purchase_drafts
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');
CREATE TRIGGER audit_supplier_item_aliases AFTER INSERT OR UPDATE OR DELETE ON core.supplier_item_aliases
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

GRANT SELECT, INSERT, UPDATE ON core.purchase_drafts TO zb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.supplier_item_aliases TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.purchase_drafts_id_seq, core.supplier_item_aliases_id_seq TO zb_app;
GRANT SELECT ON core.purchase_drafts, core.supplier_item_aliases TO zb_pii, zb_auditor;

COMMIT;
