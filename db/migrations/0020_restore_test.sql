-- =====================================================================
-- 毎月の復元の試験の記録（仕様書8章「復元の試験」）
--   大阪のバックアップを、本番のプロジェクトの中に一時的に作ったデータベースへ戻し、
--   表ごとの行数がバックアップの控え（.json）と合うかを確かめて、すぐ消す。
--   本物のデータを検証環境には入れない（ルール1）ので、戻す先は検証ではなく本番の中の一時的なデータベース。
--   代表が Cloud Shell で infra/restore-test.sh を動かす（復号の鍵はクラウドに置かないため、人が貼る）。
--   記録は integration_runs の kind = 'restore_test'。summary には戻したバックアップの名前・表の数・行数・合わなかった表の名前だけ
--   最後の合格から35日を過ぎたら、ホームに「復元の試験をしてください」と出す
-- =====================================================================

BEGIN;

ALTER TABLE core.integration_runs DROP CONSTRAINT integration_runs_kind_check;
ALTER TABLE core.integration_runs ADD CONSTRAINT integration_runs_kind_check
  CHECK (kind IN ('amazon_orders', 'db_backup', 'restore_test'));

COMMIT;
