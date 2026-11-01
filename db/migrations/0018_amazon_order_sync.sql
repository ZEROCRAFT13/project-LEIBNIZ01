-- =====================================================================
-- SP-API（Orders API v2026-01-01）から自社出荷の注文を取り込む
--   integration_runs … 取り込みを1回動かすごとの記録（いつ・成功したか・どこまで取ったか・件数）。
--     次の回は、最後に成功した回の cursor_to から取る。30分以上成功していなければ ToDo に出す。
--     失敗の内容は、HTTP の番号とエラーの種類だけ残す（応答の本文は残さない。注文の中身が入りうるため）
--   orders.source / amazon_status / amazon_updated_at … どこから来た注文か、Amazon 側の状態と更新時刻
--   お客様の名前・住所は取らない（includedData に BUYER・RECIPIENT を入れない）
-- =====================================================================

BEGIN;

CREATE TABLE core.integration_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('amazon_orders')),
  mode        text NOT NULL CHECK (mode IN ('incremental', 'reconcile', 'manual')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  cursor_from timestamptz,
  cursor_to   timestamptz,          -- この回で取り終えた時刻（成功したときだけ、次の回の起点になる）
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 件数だけ（新規・更新・取り消し・不明な出品など）
  error       text CHECK (length(error) <= 300),
  CHECK ((finished_at IS NULL) = (ok IS NULL)),
  CHECK (ok IS DISTINCT FROM false OR error IS NOT NULL)
);
CREATE INDEX ON core.integration_runs (kind, started_at DESC);
CREATE INDEX ON core.integration_runs (kind, finished_at DESC) WHERE ok;

-- 記録は書き足すだけ。終わった回は書き換えない
CREATE FUNCTION core.integration_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '取り込みの記録は消せません';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION '終わった取り込みの記録は書き換えられません';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_runs_guard BEFORE UPDATE OR DELETE ON core.integration_runs
  FOR EACH ROW EXECUTE FUNCTION core.integration_runs_guard();

GRANT SELECT, INSERT, UPDATE ON core.integration_runs TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.integration_runs_id_seq TO zb_app;
GRANT SELECT ON core.integration_runs TO zb_auditor;

ALTER TABLE core.orders
  ADD COLUMN source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sp_api')),
  ADD COLUMN amazon_status     text CHECK (amazon_status IN
                                 ('PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'UNFULFILLABLE')),
  ADD COLUMN amazon_updated_at timestamptz;

COMMIT;
