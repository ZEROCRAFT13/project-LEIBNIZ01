import "server-only";
import { DatabaseError, type PoolClient } from "pg";
import { query, withActor } from "@/lib/db";

// ToDo（タスク）。仕様書 4章：タスクは役割に割り当て、作った時点でその役割を持っていた人を残す。
// 状態の変化は task_events に追記し、終わったタスクは書き換えない（0017）。
// 自動で作るタスク（自社出荷の注文など）は、発生元（source_kind・source_ref）ごとに1つ。
// 書き込みは、呼ぶ側の withActor のトランザクションの中で client を渡して行う（発生元の変更と一緒に記録するため）。

export type TaskStatus = "todo" | "in_progress" | "awaiting_approval" | "done" | "cancelled";
export type Actor = { kind: "user"; userId: number } | { kind: "system" };

export class TaskRefused extends Error {}

const roleHolderSql = `(SELECT ra.user_id FROM core.role_assignments ra JOIN core.users u ON u.id = ra.user_id AND u.active
                         WHERE ra.role_code = $1 AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
                         ORDER BY ra.user_id LIMIT 1)`;

async function event(client: PoolClient, taskId: number, actor: Actor, name: string, detail: Record<string, unknown> = {}) {
  await client.query(
    `INSERT INTO core.task_events (task_id, actor_kind, actor_user_id, event, detail) VALUES ($1, $2, $3, $4, $5)`,
    [taskId, actor.kind, actor.kind === "user" ? actor.userId : null, name, JSON.stringify(detail)],
  );
}

export type NewTask = {
  title: string;
  description?: string | null;
  roleCode: string;
  sourceKind: "calendar" | "fba" | "inbox" | "ai" | "manual" | "system";
  sourceRef?: string | null;
  dueAt?: Date | string | null;
};

/** タスクを作る。担当者は、その時点で役割を持っている人（いれば） */
export async function createTask(client: PoolClient, actor: Actor, t: NewTask): Promise<number> {
  const r = await client.query<{ id: number }>(
    `INSERT INTO core.tasks (title, description, role_code, assignee_user_id, source_kind, source_ref, due_at)
     VALUES ($2, $3, $1, ${roleHolderSql}, $4, $5, $6) RETURNING id`,
    [t.roleCode, t.title, t.description ?? null, t.sourceKind, t.sourceRef ?? null, t.dueAt ?? null],
  );
  const id = r.rows[0].id;
  await event(client, id, actor, "created");
  return id;
}

/** 発生元の、終わっていないタスク（行を押さえる） */
export async function findOpenTask(client: PoolClient, sourceKind: string, sourceRef: string) {
  const r = await client.query<{ id: number; status: TaskStatus; due_at: Date | null }>(
    `SELECT id, status, due_at FROM core.tasks
      WHERE source_kind = $1 AND source_ref = $2 AND status IN ('todo', 'in_progress', 'awaiting_approval')
      FOR UPDATE`,
    [sourceKind, sourceRef],
  );
  return r.rows[0] ?? null;
}

/** 手を付けた（未着手 → 進行中）。すでに進行中なら何もしない */
export async function startTask(client: PoolClient, actor: Actor, taskId: number): Promise<void> {
  const r = await client.query(`UPDATE core.tasks SET status = 'in_progress' WHERE id = $1 AND status = 'todo'`, [taskId]);
  if (r.rowCount) await event(client, taskId, actor, "started");
}

/**
 * 完了にする。期限を過ぎていたら遅れた理由が要る（仕様書 4章）。
 * 理由がなければ TaskRefused を投げる（呼ぶ側のトランザクションごと取り消される）
 */
export async function completeTask(
  client: PoolClient,
  actor: Actor,
  taskId: number,
  delayReason: string | null,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  const t = await client.query<{ overdue: boolean }>(
    `SELECT due_at IS NOT NULL AND now() > due_at AS overdue FROM core.tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  const reason = delayReason?.normalize("NFC").trim() || null;
  if (t.rows[0]?.overdue && !reason) throw new TaskRefused("期限を過ぎているので、遅れた理由を書いてください。");
  await client.query(
    `UPDATE core.tasks
        SET status = 'done', completed_at = now(), completed_by_kind = $2, completed_by_user_id = $3,
            delay_reason = CASE WHEN due_at IS NOT NULL AND now() > due_at THEN $4 END,
            evidence = evidence || $5::jsonb
      WHERE id = $1`,
    [taskId, actor.kind, actor.kind === "user" ? actor.userId : null, reason, JSON.stringify(evidence)],
  );
  await event(client, taskId, actor, "completed", reason ? { delayReason: reason } : {});
}

export async function cancelTask(client: PoolClient, actor: Actor, taskId: number, reason: string): Promise<void> {
  await client.query(`UPDATE core.tasks SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [taskId, reason.slice(0, 200)]);
  await event(client, taskId, actor, "cancelled", { reason });
}

/** 期限を変える（出荷期限が変わったときなど） */
export async function setTaskDue(client: PoolClient, actor: Actor, taskId: number, dueAt: Date | string | null): Promise<void> {
  const r = await client.query(`UPDATE core.tasks SET due_at = $2 WHERE id = $1 AND due_at IS DISTINCT FROM $2::timestamptz`, [
    taskId,
    dueAt,
  ]);
  if (r.rowCount) await event(client, taskId, actor, "due_changed", { dueAt });
}

// ---------------------------------------------------------------------
// 一覧（ToDo の画面）
// ---------------------------------------------------------------------

export type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  roleCode: string;
  roleName: string;
  assignee: string | null;
  sourceKind: string;
  sourceRef: string | null;
  status: TaskStatus;
  dueAt: Date | null;
  overdue: boolean;
  /** 期限の日（日本の日付）が今日か */
  dueToday: boolean;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
  delayReason: string | null;
  cancelReason: string | null;
  /** 自社出荷の注文のタスクなら、その進み具合 */
  order: {
    id: number;
    orderNo: string;
    qty: number;
    linked: number;
    shipped: boolean;
    notified: boolean;
    /** 注文の機種で、今出せる個体の数（足りなければ組立を急ぐ） */
    available: number;
  } | null;
};

const TASK_COLUMNS = `t.id, t.title, t.description, t.role_code AS "roleCode", r.name AS "roleName",
  au.display_name AS assignee, t.source_kind AS "sourceKind", t.source_ref AS "sourceRef", t.status,
  t.due_at AS "dueAt",
  (t.status IN ('todo', 'in_progress', 'awaiting_approval') AND t.due_at < now()) AS overdue,
  (t.due_at IS NOT NULL AND ((t.due_at - interval '1 second') AT TIME ZONE 'Asia/Tokyo')::date
                           = (now() AT TIME ZONE 'Asia/Tokyo')::date) AS "dueToday",
  t.created_at AS "createdAt", t.completed_at AS "completedAt", cu.display_name AS "completedBy",
  t.delay_reason AS "delayReason", t.cancel_reason AS "cancelReason",
  CASE WHEN o.id IS NOT NULL THEN json_build_object(
    'id', o.id, 'orderNo', o.external_order_no,
    'qty', (SELECT coalesce(sum(l.qty), 0) FROM core.order_lines l WHERE l.order_id = o.id),
    'linked', (SELECT count(*) FROM core.order_units ou
                WHERE ou.order_id = o.id AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'),
    'shipped', o.status IN ('shipped', 'delivered', 'returned'),
    'notified', o.ship_notified_at IS NOT NULL,
    'available', (SELECT count(*) FROM core.units u
                   WHERE u.sku_id IN (SELECT l.sku_id FROM core.order_lines l WHERE l.order_id = o.id)
                     AND u.status = 'ready'
                     AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                                      WHERE su.unit_id = u.id AND s.status <> 'cancelled')
                     AND NOT EXISTS (SELECT 1 FROM core.order_units x WHERE x.unit_id = u.id AND x.unlinked_at IS NULL))
  ) END AS "order"`;

const TASK_FROM = `core.tasks t
  JOIN core.roles r ON r.code = t.role_code
  LEFT JOIN core.users au ON au.id = t.assignee_user_id
  LEFT JOIN core.users cu ON cu.id = t.completed_by_user_id
  LEFT JOIN core.orders o ON t.source_ref LIKE 'order:%' AND o.id = substring(t.source_ref from 7)::bigint`;

/** 終わっていないタスク（その人の役割のもの）。期限超過 → 期限の近い順 → 期限なし */
export async function listOpenTasks(roles: string[]): Promise<TaskRow[]> {
  return query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
      WHERE t.status IN ('todo', 'in_progress', 'awaiting_approval') AND t.role_code = ANY($1)
      ORDER BY t.due_at NULLS LAST, t.created_at
      LIMIT 300`,
    [roles],
  );
}

/** 最近終わったタスク（ここ7日） */
export async function listRecentlyFinished(roles: string[]): Promise<TaskRow[]> {
  return query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
      WHERE t.status IN ('done', 'cancelled') AND t.role_code = ANY($1)
        AND coalesce(t.completed_at, t.created_at) > now() - interval '7 days'
      ORDER BY coalesce(t.completed_at, t.created_at) DESC
      LIMIT 50`,
    [roles],
  );
}

/** 見出し用の数（終わっていない・期限超過） */
export async function countOpenTasks(roles: string[]): Promise<{ open: number; overdue: number }> {
  const [r] = await query<{ open: number; overdue: number }>(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE due_at < now())::int AS overdue
       FROM core.tasks WHERE status IN ('todo', 'in_progress', 'awaiting_approval') AND role_code = ANY($1)`,
    [roles],
  );
  return r;
}

// ---------------------------------------------------------------------
// 手で足すタスク
// ---------------------------------------------------------------------

export type TaskResult = { ok: boolean; message: string };

function refusal(error: unknown): string | null {
  if (error instanceof TaskRefused) return error.message;
  if (error instanceof DatabaseError && error.code === "P0001") return error.message;
  if (error instanceof DatabaseError && error.code === "23514") return "入力が決まりに合っていません。";
  return null;
}

export async function addManualTask(
  actorId: number,
  input: { title: string; roleCode: string; dueAt: Date | null; description: string | null },
): Promise<TaskResult> {
  try {
    await withActor({ kind: "user", userId: actorId }, (client) =>
      createTask(client, { kind: "user", userId: actorId }, { ...input, sourceKind: "manual" }),
    );
    return { ok: true, message: `「${input.title}」を足しました。` };
  } catch (error) {
    const m = refusal(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}

/** 手で足したタスクを完了・取り消しにする（自動で作ったタスクは、もとの作業が終わると自動で完了する） */
export async function finishManualTask(
  actorId: number,
  taskId: number,
  how: { done: true; delayReason: string | null } | { done: false; cancelReason: string },
): Promise<TaskResult> {
  const actor: Actor = { kind: "user", userId: actorId };
  try {
    return await withActor(actor, async (client) => {
      const r = await client.query<{ source_kind: string; status: TaskStatus }>(
        `SELECT source_kind, status FROM core.tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      );
      const t = r.rows[0];
      if (!t || !["todo", "in_progress", "awaiting_approval"].includes(t.status)) throw new TaskRefused("このタスクはもう終わっています。");
      if (t.source_kind !== "manual") throw new TaskRefused("このタスクは、もとの作業が終わると自動で完了します。");
      if (how.done) {
        await completeTask(client, actor, taskId, how.delayReason);
        return { ok: true, message: "完了にしました。" };
      }
      const reason = how.cancelReason.normalize("NFC").trim();
      if (!reason) throw new TaskRefused("取り消しの理由を書いてください。");
      await cancelTask(client, actor, taskId, reason);
      return { ok: true, message: "取り消しました。" };
    });
  } catch (error) {
    const m = refusal(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}
