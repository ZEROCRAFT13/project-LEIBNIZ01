-- =====================================================================
-- 管理番号シールを刷ったかどうか
--   組立用のスマホで管理番号を発行し、事務所のPC（PT-P700 は USB でつなぐ）でまとめて刷るので、
--   「まだ刷っていない個体」を一覧にできるようにする
-- =====================================================================

BEGIN;

ALTER TABLE core.units ADD COLUMN label_printed_at timestamptz;
CREATE INDEX units_label_not_printed ON core.units (created_at) WHERE label_printed_at IS NULL;

COMMIT;
