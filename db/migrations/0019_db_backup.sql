-- =====================================================================
-- データベースのバックアップ（1時間ごと・大阪へ。仕様書8章）
--   zb_backup … バックアップ専用のロール。全部の区画（個人情報の pii も含む）を読むだけ。
--     書けるのは、自分のバックアップの記録（integration_runs の kind = 'db_backup'）だけ。
--     バックアップは公開鍵で暗号化してから置く（復号の鍵はクラウドに置かない）。
--     パスワードはここに書かず、マイグレーションのジョブが Secret Manager の値で設定する（ZB_BACKUP_PASSWORD）。
--   integration_runs … kind に 'db_backup'、mode に 'scheduled'（Cloud Scheduler から1時間ごと）を足す。
--     summary には大きさ・ハッシュ・置いた場所・表の数と行数の合計だけを残す（中身は残さない）
-- これから足す表も読めるように、既定の権限も付ける（足し忘れは db/tests で見つかる）
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zb_backup') THEN CREATE ROLE zb_backup NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA core, pii, audit, auth, public TO zb_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA core, pii, audit, auth, public TO zb_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA core, pii, audit, auth, public TO zb_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA core, pii, audit, auth, public GRANT SELECT ON TABLES TO zb_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA core, pii, audit, auth, public GRANT SELECT ON SEQUENCES TO zb_backup;

-- 記録の種類を足す
ALTER TABLE core.integration_runs DROP CONSTRAINT integration_runs_kind_check;
ALTER TABLE core.integration_runs ADD CONSTRAINT integration_runs_kind_check CHECK (kind IN ('amazon_orders', 'db_backup'));
ALTER TABLE core.integration_runs DROP CONSTRAINT integration_runs_mode_check;
ALTER TABLE core.integration_runs ADD CONSTRAINT integration_runs_mode_check
  CHECK (mode IN ('incremental', 'reconcile', 'manual', 'scheduled'));

GRANT INSERT, UPDATE ON core.integration_runs TO zb_backup;
GRANT USAGE ON SEQUENCE core.integration_runs_id_seq TO zb_backup;

-- バックアップのロールは、バックアップの記録だけを書ける（ほかの取り込みの記録は作れない・変えられない）
CREATE FUNCTION core.integration_runs_backup_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'zb_backup' AND NEW.kind <> 'db_backup' THEN
    RAISE EXCEPTION 'バックアップのロールが書けるのは、バックアップの記録だけです';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION '記録の種類は変えられません';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_runs_backup_only BEFORE INSERT OR UPDATE ON core.integration_runs
  FOR EACH ROW EXECUTE FUNCTION core.integration_runs_backup_only();

COMMIT;
