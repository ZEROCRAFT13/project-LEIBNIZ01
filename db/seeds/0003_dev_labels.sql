-- 開発用: ダミーの個体は、もう組み上がって出荷などをしているので、シールは刷ってあることにする
-- （シールの一覧に、今発行した個体だけが「まだ刷っていない」として出るように）
BEGIN;
SET LOCAL app.actor_kind = 'system';
UPDATE core.units SET label_printed_at = assembled_at WHERE status <> 'assembling' AND assembled_at IS NOT NULL;
COMMIT;
