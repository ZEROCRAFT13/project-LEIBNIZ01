-- 開発用: 自社出荷の注文1件（出荷期限は明日）と、その「出荷する」タスク、手で足したタスク1件
BEGIN;
SET LOCAL app.actor_kind = 'system';
WITH o AS (
  INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount, ship_by)
  VALUES ('amazon', '503-0000000-0000101', false, now() - interval '2 hours', 349800,
          (now() AT TIME ZONE 'Asia/Tokyo')::date + 1)
  RETURNING id, ship_by
), l AS (
  INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price)
  SELECT o.id, k.id, k.code, 1, 349800 FROM o, core.skus k WHERE k.code = 'ZB-G5070-R7'
)
INSERT INTO core.tasks (title, description, role_code, assignee_user_id, source_kind, source_ref, due_at)
SELECT '自社出荷：503-0000000-0000101（ZB-G5070-R7 × 1）を出荷する',
       '出荷待ちの個体を結びつけ → 送り状番号を入れて発送 → セラーセントラルで出荷通知',
       'factory_manager', (SELECT id FROM core.users WHERE email = 'owner@zerobit.example'),
       'system', 'order:' || o.id, ((o.ship_by + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
  FROM o;
INSERT INTO core.tasks (title, role_code, assignee_user_id, source_kind, due_at)
VALUES ('梱包材（緩衝材・段ボール）の在庫を確かめる', 'factory_manager',
        (SELECT id FROM core.users WHERE email = 'owner@zerobit.example'), 'manual',
        ((now() AT TIME ZONE 'Asia/Tokyo')::date + 3)::timestamp AT TIME ZONE 'Asia/Tokyo');
INSERT INTO core.task_events (task_id, actor_kind, event)
SELECT id, 'system', 'created' FROM core.tasks;
COMMIT;
