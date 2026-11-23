import "server-only";
import { query, withActor } from "@/lib/db";
import { addDays, DEFAULT_RESTOCK, endOfJstDay, restockPlan, type RestockPlan, type RestockSettings } from "@/lib/fba-restock-calc";
import { completeTask, createTask, findOpenTask, setTaskDue, type Actor } from "@/lib/tasks";
import { todayJst } from "@/lib/format";

// FBA の補充の表（読むだけ）。FBA・両方の機種ごとに、最後に取り込んだ在庫と直近の販売ペースから計算する

export type RestockRow = RestockPlan & {
  skuId: number;
  skuCode: string;
  skuName: string;
  fulfillment: "fba" | "both";
  fulfillable: number | null;
  inbound: number | null;
  reserved: number | null;
  capturedAt: Date | null;
  soldInWindow: number;
  /** このシステムで組立中・検品中・出荷待ちの個体（まだ FBA の納品にも自社出荷の注文にも入れていない）。在庫に足して数える */
  pipeline: number;
};

export async function getRestockSettings(): Promise<RestockSettings> {
  const rows = await query<{ key: string; n: string | null }>(
    `SELECT key, value #>> '{}' AS n FROM core.settings
      WHERE key IN ('fba_lead_time_days', 'sales_pace_window_days', 'fba_cover_days', 'fba_warn_days')`,
  );
  const get = (key: string, fallback: number) => {
    const v = Number(rows.find((r) => r.key === key)?.n);
    return Number.isInteger(v) && v >= 0 && v <= 365 ? v : fallback;
  };
  return {
    leadDays: get("fba_lead_time_days", DEFAULT_RESTOCK.leadDays),
    windowDays: Math.max(1, get("sales_pace_window_days", DEFAULT_RESTOCK.windowDays)),
    coverDays: get("fba_cover_days", DEFAULT_RESTOCK.coverDays),
    warnDays: get("fba_warn_days", DEFAULT_RESTOCK.warnDays),
  };
}

export async function getRestockRows(now: Date = new Date()): Promise<{ settings: RestockSettings; rows: RestockRow[] }> {
  const settings = await getRestockSettings();
  const today = todayJst(now);
  // 今日は途中なので入れない（昨日までの windowDays 日）
  const from = addDays(today, -settings.windowDays);
  const raw = await query<{
    skuId: number;
    skuCode: string;
    skuName: string;
    fulfillment: "fba" | "both";
    fulfillable: number | null;
    inbound: number | null;
    reserved: number | null;
    capturedAt: Date | null;
    sold: string;
    pipeline: string;
  }>(
    `SELECT k.id AS "skuId", k.code AS "skuCode", k.name AS "skuName", k.amazon_fulfillment AS fulfillment,
            s.fulfillable, s.inbound, s.reserved, s.captured_at AS "capturedAt",
            coalesce((SELECT sum(m.units_ordered) FROM core.sku_daily_metrics m
                       WHERE m.sku_id = k.id AND m.channel = 'amazon' AND m.metric_date >= $1 AND m.metric_date < $2), 0) AS sold,
            (SELECT count(*) FROM core.units u
              WHERE u.sku_id = k.id AND u.status IN ('planned', 'assembling', 'inspecting', 'ready')
                AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments f ON f.id = su.shipment_id
                                 WHERE su.unit_id = u.id AND f.status <> 'cancelled')
                AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL)) AS pipeline
       FROM core.skus k
       LEFT JOIN LATERAL (SELECT * FROM core.fba_inventory_snapshots x WHERE x.sku_id = k.id ORDER BY captured_at DESC LIMIT 1) s ON true
      WHERE k.active AND k.amazon_fulfillment IN ('fba', 'both')
      ORDER BY k.code`,
    [from, today],
  );
  const rows = raw.map((r) => {
    const sold = Number(r.sold);
    const pipeline = Number(r.pipeline);
    const plan = restockPlan({ fulfillable: r.fulfillable ?? 0, inbound: r.inbound ?? 0, pipeline, soldInWindow: sold, today }, settings);
    return { ...r, ...plan, soldInWindow: sold, pipeline };
  });
  // 急ぐものから
  const rank = { late: 0, soon: 1, ok: 2, no_sales: 3 } as const;
  rows.sort((a, b) => rank[a.level] - rank[b.level] || (a.startBy ?? "9999").localeCompare(b.startBy ?? "9999") || a.skuCode.localeCompare(b.skuCode));
  return { settings, rows };
}

// ---------------------------------------------------------------------
// 組立を始める期限が近い機種を、工場長の ToDo にする（FBA の取り込みのあとに呼ぶ。仕様書 F5）
//   期限を過ぎた・warnDays 日以内 … 機種ごとに1つ「FBA 補充：○○ の組立を始める」を作る（期限＝組立を始める期限の日の終わり）。
//                                   もうあれば期限だけ合わせる
//   足りた（組立を始めた・納品した・売れ行きが落ちた）・FBA の機種でなくなった … 自動で完了にする
// ---------------------------------------------------------------------

const SYSTEM: Actor = { kind: "system" };
export const RESTOCK_REF = "fba-restock:sku:";

export type RestockTaskSummary = { created: number; updated: number; closed: number };

export async function updateRestockTasks(now: Date = new Date()): Promise<RestockTaskSummary> {
  const { rows } = await getRestockRows(now);
  const summary: RestockTaskSummary = { created: 0, updated: 0, closed: 0 };
  await withActor(SYSTEM, async (c) => {
    const urgent = new Set<number>();
    for (const r of rows) {
      if ((r.level !== "late" && r.level !== "soon") || !r.startBy) continue;
      urgent.add(r.skuId);
      const ref = `${RESTOCK_REF}${r.skuId}`;
      const due = endOfJstDay(r.startBy);
      const open = await findOpenTask(c, "system", ref);
      if (open) {
        if (open.due_at?.getTime() !== due.getTime()) {
          await setTaskDue(c, SYSTEM, open.id, due);
          summary.updated++;
        }
        continue;
      }
      await createTask(c, SYSTEM, {
        title: `FBA 補充：${r.skuCode} の組立を始める`,
        description:
          `FBA の在庫が ${r.stockoutDate} ごろになくなる見込みです（1日 ${r.perDay.toFixed(2)}台、在庫 ${r.supply}台）。` +
          `補充の目安は ${r.suggestQty}台。FBA の画面で数字を確かめ、組み立てて納品してください。足りたら自動で完了になります。`,
        roleCode: "factory_manager",
        sourceKind: "system",
        sourceRef: ref,
        dueAt: due,
      });
      summary.created++;
    }
    const open = await c.query<{ id: number; ref: string; overdue: boolean }>(
      `SELECT id, source_ref AS ref, due_at IS NOT NULL AND now() > due_at AS overdue FROM core.tasks
        WHERE source_kind = 'system' AND source_ref LIKE $1 AND status IN ('todo', 'in_progress', 'awaiting_approval')`,
      [`${RESTOCK_REF}%`],
    );
    for (const t of open.rows) {
      const skuId = Number(t.ref.slice(RESTOCK_REF.length));
      if (urgent.has(skuId)) continue;
      const row = rows.find((r) => r.skuId === skuId);
      await completeTask(c, SYSTEM, t.id, t.overdue ? "在庫（組立中・納品中を含む）が足りたので、自動で閉じました" : null, {
        supply: row?.supply ?? null,
        startBy: row?.startBy ?? null,
        level: row?.level ?? "not_fba",
      });
      summary.closed++;
    }
  });
  return summary;
}
