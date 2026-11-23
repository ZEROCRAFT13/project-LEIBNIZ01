import "server-only";
import { notifyOnce } from "@/lib/amazon/order-sync";
import { yenFromMoney, type ApiOrder } from "@/lib/amazon/orders-map";
import type { FbaInventoryApi, OrdersApi } from "@/lib/amazon/sp-api";
import { query, withActor } from "@/lib/db";
import { updateRestockTasks } from "@/lib/fba-restock";
import { addDays, fbaQuantities } from "@/lib/fba-restock-calc";
import { todayJst } from "@/lib/format";
import { completeTask, findOpenTask, type Actor } from "@/lib/tasks";

// FBA の在庫と販売ペースを SP-API から取り込む（Cloud Scheduler から1時間ごと・画面の「今すぐ取り込む」）。
//   在庫 … FBA の出品（セラー SKU）ごとの数を機種ごとに足して、fba_inventory_snapshots に1行ずつ足す。
//          FBA の機種なのに Amazon に在庫の行がない機種は 0 として記録する（倉庫に1台もない）
//   販売 … 直近31日に作られた Amazon の注文（FBA・自社出荷とも、取り消しは除く）を、機種・日本時間の日付ごとに数え、
//          sku_daily_metrics（channel = 'amazon'）の units_ordered・sales_amount をその期間について作り直す
//   記録は件数だけ（注文番号やお客様の情報は残さない）。実行者は system（ルール7）
// 失敗したら ToDo に出し、次に成功したら自動で閉じる。
// 取り込めたら、組立を始める期限が近い機種を工場長の ToDo にする（lib/fba-restock.ts の updateRestockTasks）。

const SYSTEM: Actor = { kind: "system" };
const KIND = "amazon_fba";
export const SALES_DAYS = 31;

export type FbaSyncSummary = {
  inventoryRows: number;
  skus: number;
  orders: number;
  unitsSold: number;
  /** 登録されていない出品（セラー SKU）の数。在庫か注文があるもの */
  unknownListings: number;
  /** 組立の ToDo（作った・期限を直した・閉じた） */
  tasks?: { created: number; updated: number; closed: number };
};
export type FbaSyncResult = { ok: true; runId: number; summary: FbaSyncSummary } | { ok: false; runId: number | null; error: string };

type Listing = { sellerSku: string; skuId: number; fulfillment: "fba" | "fbm" };

/** 注文を、機種・日本時間の日付ごとの台数と金額にまとめる（取り消し・登録されていない出品は数えない） */
export function salesByDay(orders: ApiOrder[], listings: Listing[]) {
  const bySku = new Map(listings.map((l) => [l.sellerSku, l.skuId]));
  const out = new Map<string, { date: string; skuId: number; units: number; amount: number }>();
  const unknown = new Set<string>();
  let counted = 0;
  for (const o of orders) {
    if (o.fulfillment?.fulfillmentStatus === "CANCELLED" || !o.createdTime) continue;
    const created = new Date(o.createdTime);
    if (Number.isNaN(created.getTime())) continue;
    const date = todayJst(created);
    let any = false;
    for (const i of o.orderItems ?? []) {
      const sellerSku = String(i.product?.sellerSku ?? "").trim();
      const qty = Number.isInteger(i.quantityOrdered) ? (i.quantityOrdered as number) : 0;
      if (!sellerSku || qty <= 0) continue;
      const skuId = bySku.get(sellerSku);
      if (skuId === undefined) {
        unknown.add(sellerSku);
        continue;
      }
      const key = `${date}|${skuId}`;
      const row = out.get(key) ?? { date, skuId, units: 0, amount: 0 };
      row.units += qty;
      row.amount += (yenFromMoney(i.product?.price?.unitPrice) ?? 0) * qty;
      out.set(key, row);
      any = true;
    }
    if (any) counted++;
  }
  return { rows: [...out.values()], unknown: [...unknown], orders: counted };
}

/** 在庫の行を、FBA の機種ごとに足す */
export function inventoryBySku(items: Awaited<ReturnType<FbaInventoryApi["getFbaInventory"]>>, listings: Listing[]) {
  const fba = new Map(listings.filter((l) => l.fulfillment === "fba").map((l) => [l.sellerSku, l.skuId]));
  const out = new Map<number, { fulfillable: number; inbound: number; reserved: number; unfulfillable: number }>();
  const unknown = new Set<string>();
  for (const item of items) {
    const sellerSku = String(item.sellerSku ?? "").trim();
    const q = fbaQuantities(item);
    const skuId = fba.get(sellerSku);
    if (skuId === undefined) {
      if (sellerSku && q.fulfillable + q.inbound + q.reserved + q.unfulfillable > 0) unknown.add(sellerSku);
      continue;
    }
    const cur = out.get(skuId) ?? { fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0 };
    cur.fulfillable += q.fulfillable;
    cur.inbound += q.inbound;
    cur.reserved += q.reserved;
    cur.unfulfillable += q.unfulfillable;
    out.set(skuId, cur);
  }
  return { bySku: out, unknown: [...unknown] };
}

export async function syncFbaInventory(
  api: FbaInventoryApi & OrdersApi,
  mode: "incremental" | "manual",
  now: Date = new Date(),
): Promise<FbaSyncResult> {
  const run = await withActor(SYSTEM, (c) =>
    c.query<{ id: number }>(`INSERT INTO core.integration_runs (kind, mode) VALUES ($1, $2) RETURNING id`, [KIND, mode]),
  );
  const runId = run.rows[0].id;
  try {
    const listings = await query<Listing>(`SELECT seller_sku AS "sellerSku", sku_id AS "skuId", fulfillment FROM core.amazon_listings`);
    const fbaSkus = await query<{ id: number }>(
      `SELECT DISTINCT k.id FROM core.skus k JOIN core.amazon_listings l ON l.sku_id = k.id AND l.fulfillment = 'fba' AND l.active
        WHERE k.amazon_fulfillment IN ('fba', 'both')`,
    );
    const items = await api.getFbaInventory();
    const inv = inventoryBySku(items, listings);
    const from = addDays(todayJst(now), -(SALES_DAYS - 1));
    // 日本時間の from の 0時から
    const orders = await api.searchOrders({ createdAfter: new Date(`${from}T00:00:00+09:00`), merchantOnly: false });
    const sales = salesByDay(orders, listings);

    const summary: FbaSyncSummary = {
      inventoryRows: items.length,
      skus: fbaSkus.length,
      orders: sales.orders,
      unitsSold: sales.rows.reduce((n, r) => n + r.units, 0),
      unknownListings: new Set([...inv.unknown, ...sales.unknown]).size,
    };
    await withActor(SYSTEM, async (c) => {
      for (const { id } of fbaSkus) {
        const q = inv.bySku.get(id) ?? { fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0 };
        await c.query(
          `INSERT INTO core.fba_inventory_snapshots (captured_at, sku_id, fulfillable, inbound, reserved, unfulfillable)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (sku_id, captured_at) DO UPDATE SET fulfillable = EXCLUDED.fulfillable, inbound = EXCLUDED.inbound,
             reserved = EXCLUDED.reserved, unfulfillable = EXCLUDED.unfulfillable`,
          [now, id, q.fulfillable, q.inbound, q.reserved, q.unfulfillable],
        );
      }
      // 期間の分を作り直す（取り消された注文が減るように、いったん 0 にしてから入れる）
      await c.query(
        `UPDATE core.sku_daily_metrics SET units_ordered = 0, sales_amount = 0 WHERE channel = 'amazon' AND metric_date >= $1`,
        [from],
      );
      for (const r of sales.rows) {
        await c.query(
          `INSERT INTO core.sku_daily_metrics (metric_date, sku_id, channel, units_ordered, sales_amount)
           VALUES ($1, $2, 'amazon', $3, $4)
           ON CONFLICT (metric_date, sku_id, channel) DO UPDATE SET units_ordered = EXCLUDED.units_ordered, sales_amount = EXCLUDED.sales_amount`,
          [r.date, r.skuId, r.units, r.amount],
        );
      }
      await c.query(`UPDATE core.integration_runs SET finished_at = now(), ok = true, summary = $2 WHERE id = $1`, [
        runId,
        JSON.stringify(summary),
      ]);
      const alarm = await findOpenTask(c, "system", "sync:amazon_fba");
      if (alarm) await completeTask(c, SYSTEM, alarm.id, null, { recoveredRunId: runId });
    });
    try {
      summary.tasks = await updateRestockTasks(now);
    } catch {
      // 取り込みはできている。ToDo は次の回（1時間後）にやり直す
    }
    return { ok: true, runId, summary };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "不明なエラー").slice(0, 300);
    await withActor(SYSTEM, async (c) => {
      await c.query(`UPDATE core.integration_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [runId, message]);
      await notifyOnce(
        c,
        "sync:amazon_fba",
        "Amazon の FBA 在庫の取り込みが失敗しています",
        `FBA の在庫と販売ペースが古いままになり、組立を始める期限がずれます。直ったら自動で閉じます。最後のエラー：${message}`,
        "ceo",
      );
    });
    return { ok: false, runId, error: message };
  }
}

export type FbaSyncHealth = { lastSuccessAt: Date | null; lastError: string | null; stale: boolean };

/** 取り込みの様子（画面用。2時間以上成功していなければ stale） */
export async function getFbaSyncHealth(configured: boolean): Promise<FbaSyncHealth> {
  const [r] = await query<{ lastSuccessAt: Date | null; lastError: string | null; lastRunOk: boolean | null }>(
    `SELECT (SELECT max(finished_at) FROM core.integration_runs WHERE kind = $1 AND ok) AS "lastSuccessAt",
            (SELECT error FROM core.integration_runs WHERE kind = $1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1) AS "lastError",
            (SELECT ok FROM core.integration_runs WHERE kind = $1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1) AS "lastRunOk"`,
    [KIND],
  );
  const stale = configured && (!r.lastSuccessAt || Date.now() - r.lastSuccessAt.getTime() > 2 * 3600_000);
  return { lastSuccessAt: r.lastSuccessAt, lastError: r.lastRunOk === false ? r.lastError : null, stale };
}
