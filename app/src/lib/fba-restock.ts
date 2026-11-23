import "server-only";
import { query } from "@/lib/db";
import { addDays, DEFAULT_RESTOCK, restockPlan, type RestockPlan, type RestockSettings } from "@/lib/fba-restock-calc";
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
  /** このシステムで「出荷待ち」の個体（まだ FBA の納品に入れていない） */
  readyHere: number;
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
    readyHere: string;
  }>(
    `SELECT k.id AS "skuId", k.code AS "skuCode", k.name AS "skuName", k.amazon_fulfillment AS fulfillment,
            s.fulfillable, s.inbound, s.reserved, s.captured_at AS "capturedAt",
            coalesce((SELECT sum(m.units_ordered) FROM core.sku_daily_metrics m
                       WHERE m.sku_id = k.id AND m.channel = 'amazon' AND m.metric_date >= $1 AND m.metric_date < $2), 0) AS sold,
            (SELECT count(*) FROM core.units u
              WHERE u.sku_id = k.id AND u.status = 'ready'
                AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments f ON f.id = su.shipment_id
                                 WHERE su.unit_id = u.id AND f.status <> 'cancelled')
                AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL)) AS "readyHere"
       FROM core.skus k
       LEFT JOIN LATERAL (SELECT * FROM core.fba_inventory_snapshots x WHERE x.sku_id = k.id ORDER BY captured_at DESC LIMIT 1) s ON true
      WHERE k.active AND k.amazon_fulfillment IN ('fba', 'both')
      ORDER BY k.code`,
    [from, today],
  );
  const rows = raw.map((r) => {
    const sold = Number(r.sold);
    const plan = restockPlan({ fulfillable: r.fulfillable ?? 0, inbound: r.inbound ?? 0, soldInWindow: sold, today }, settings);
    return { ...r, ...plan, soldInWindow: sold, readyHere: Number(r.readyHere) };
  });
  // 急ぐものから
  const rank = { late: 0, soon: 1, ok: 2, no_sales: 3 } as const;
  rows.sort((a, b) => rank[a.level] - rank[b.level] || (a.startBy ?? "9999").localeCompare(b.startBy ?? "9999") || a.skuCode.localeCompare(b.skuCode));
  return { settings, rows };
}
