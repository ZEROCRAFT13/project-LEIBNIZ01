-- =====================================================================
-- 仕入れの下書きに「うち消費税」を足す
--   Joshin などはメールに消費税の額が書いてあるので、確定のときはその額を使う
--   （書いていなければ、これまでどおり合計から計算する）
-- =====================================================================

BEGIN;

ALTER TABLE core.purchase_drafts
  ADD COLUMN tax_amount bigint CHECK (tax_amount >= 0),
  ADD CONSTRAINT purchase_drafts_tax_le_total
    CHECK (tax_amount IS NULL OR total_amount IS NULL OR tax_amount <= total_amount);

COMMIT;
