-- =====================================================================
-- ToDo（タスク）の決まりを足す（仕様書 4章）
--   ・自動で作るタスク（自社出荷の注文など）は、発生元（source_kind と source_ref）ごとに、終わっていないものを1つだけ
--   ・タスクは消さない（取り消しにする）。終わった（完了・取り消し）タスクは書き換えない
--   ・状態の変化は task_events に追記する（0001・0002 で書き換え・削除はできない）
-- =====================================================================

BEGIN;

CREATE UNIQUE INDEX tasks_one_open_per_source ON core.tasks (source_kind, source_ref)
  WHERE source_ref IS NOT NULL AND status IN ('todo', 'in_progress', 'awaiting_approval');
CREATE INDEX ON core.tasks (status, due_at);

ALTER TABLE core.tasks
  ADD COLUMN cancel_reason text CHECK (length(cancel_reason) <= 200),
  ADD CONSTRAINT tasks_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  ADD CONSTRAINT tasks_title_len CHECK (length(btrim(title)) BETWEEN 1 AND 200);

CREATE FUNCTION core.tasks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'タスクは消せません（取り消しにします）';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION '終わったタスク（完了・取り消し）は書き換えられません';
  END IF;
  IF NEW.source_kind <> OLD.source_kind OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'タスクの発生元は変えられません';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_guard BEFORE UPDATE OR DELETE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.tasks_guard();
REVOKE DELETE ON core.tasks FROM zb_app;

COMMIT;
