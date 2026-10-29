-- =====================================================================
-- データベースの利用者（ロール）と権限
--   zb_app     : アプリ本体。業務データ（core）を読み書きできる。個人情報（pii）は見られない
--   zb_pii     : 個人情報を扱う専用の窓口（AIゲートウェイ経由のローカルLLM用API、製品登録など）
--   zb_auditor : 監査ログと業務データを読むだけ
-- どのロールも監査ログを直接書き換えられない（記録はトリガーが行う）。
-- パスワードはここに書かず、作成後に Secret Manager の値で設定する。
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zb_app')     THEN CREATE ROLE zb_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zb_pii')     THEN CREATE ROLE zb_pii LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zb_auditor') THEN CREATE ROLE zb_auditor LOGIN; END IF;
END $$;

REVOKE ALL ON SCHEMA core, pii, audit FROM PUBLIC;

-- アプリ本体
GRANT USAGE ON SCHEMA core TO zb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO zb_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO zb_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO zb_app;
-- 追記専用の表は、アプリからも更新・削除させない
REVOKE UPDATE, DELETE ON core.task_events FROM zb_app;

-- 個人情報の窓口（業務データは読むだけ。顧客の作成は行う）
GRANT USAGE ON SCHEMA core, pii TO zb_pii;
GRANT SELECT ON ALL TABLES IN SCHEMA core TO zb_pii;
GRANT INSERT ON core.customers TO zb_pii;
GRANT USAGE, SELECT ON SEQUENCE core.customer_no_seq TO zb_pii;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pii TO zb_pii;

-- 監査
GRANT USAGE ON SCHEMA core, audit TO zb_auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA core, audit TO zb_auditor;

COMMIT;
