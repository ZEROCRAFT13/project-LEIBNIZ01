import "server-only";
import type { PoolClient } from "pg";
import { mapOrder, STALE_MINUTES, syncWindowFrom, type AmazonOrder } from "@/lib/amazon/orders-map";
import type { OrdersApi } from "@/lib/amazon/sp-api";
import { query, withActor } from "@/lib/db";
import { createOrderTask, shipByDue } from "@/lib/fbm";
import { completeTask, createTask, findOpenTask, setTaskDue, type Actor } from "@/lib/tasks";

// 自社出荷の注文を SP-API から取り込む（5分ごと・1日1回の照合・画面の「今すぐ取り込む」）。
//   新しい注文（UNSHIPPED / PARTIALLY_SHIPPED）… 注文を登録し、ToDo に「出荷する」を作る
//   出品（セラー SKU）が登録されていない … 取り込まずに ToDo で知らせる（機種の設定で登録すると、次の照合で入る）
//   Amazon で取り消された・発送済みになった … このシステムでまだ出荷待ちなら ToDo で知らせる（自動では取り消さない）
//   支払い待ち（PENDING）… まだ出荷できないので取り込まない。出荷できる状態になると更新されて入る
// 1つの注文ごとにトランザクションを分け、実行者は system にする（ルール7）。
// 取り込みが失敗したら ToDo に出し、次に成功したら自動で閉じる。

const SYSTEM: Actor = { kind: "system" };
const KIND = "amazon_orders";

export type SyncMode = "incremental" | "reconcile" | "manual";

export type SyncSummary = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skippedPending: number;
  skippedNotMerchant: number;
  unknownListing: number;
  cancelledOnAmazon: number;
  shippedOnAmazon: number;
  unreadable: number;
};

export type SyncResult = { ok: true; runId: number; summary: SyncSummary } | { ok: false; runId: number | null; error: string };

const emptySummary = (): SyncSummary => ({
  fetched: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  skippedPending: 0,
  skippedNotMerchant: 0,
  unknownListing: 0,
  cancelledOnAmazon: 0,
  shippedOnAmazon: 0,
  unreadable: 0,
});

/** 知らせの ToDo を、発生元ごとに1つだけ作る（もうあれば何もしない） */
async function notifyOnce(client: PoolClient, ref: string, title: string, description: string, role = "factory_manager", dueAt: Date | null = null) {
  if (await findOpenTask(client, "system", ref)) return;
  await createTask(client, SYSTEM, { title, description, roleCode: role, sourceKind: "system", sourceRef: ref, dueAt });
}

type Outcome = keyof Pick<
  SyncSummary,
  "created" | "updated" | "unchanged" | "skippedPending" | "skippedNotMerchant" | "unknownListing" | "cancelledOnAmazon" | "shippedOnAmazon"
>;

/** 1件の注文を反映する */
export async function applyAmazonOrder(o: AmazonOrder): Promise<Outcome> {
  if (!o.merchantFulfilled) return "skippedNotMerchant";
  return withActor(SYSTEM, async (client) => {
    const existing = await client.query<{ id: number; status: string; ship_by: string | null; amazon_status: string | null }>(
      `SELECT id, status, ship_by, amazon_status FROM core.orders WHERE channel = 'amazon' AND external_order_no = $1 FOR UPDATE`,
      [o.orderNo],
    );
    const cur = existing.rows[0];

    if (!cur) {
      if (o.status === "PENDING" || o.status === "PENDING_AVAILABILITY") return "skippedPending";
      if (o.status !== "UNSHIPPED" && o.status !== "PARTIALLY_SHIPPED") return "unchanged"; // 取り込む前に終わった注文
      // 出品（セラー SKU）から機種を引く
      const skus = await client.query<{ seller_sku: string; sku_id: number; code: string }>(
        `SELECT l.seller_sku, l.sku_id, k.code FROM core.amazon_listings l JOIN core.skus k ON k.id = l.sku_id
          WHERE l.fulfillment = 'fbm' AND l.seller_sku = ANY($1)`,
        [o.lines.map((l) => l.sellerSku)],
      );
      const bySku = new Map(skus.rows.map((r) => [r.seller_sku, r]));
      const unknown = [...new Set(o.lines.filter((l) => !bySku.has(l.sellerSku)).map((l) => l.sellerSku))];
      if (unknown.length > 0 || o.lines.length === 0) {
        await notifyOnce(
          client,
          `amazon-order:${o.orderNo}`,
          `Amazon の注文 ${o.orderNo} を取り込めません（出品 ${unknown.join("・") || "なし"} が登録されていません）`,
          "「設定 → 機種と構成表」で、その機種の自社出荷用の出品（セラー SKU）を登録してください。登録すると、次の照合（1日1回）か「Amazon から今すぐ取り込む」で入ります。",
          "factory_manager",
          await shipByDue(client, o.shipBy),
        );
        return "unknownListing";
      }
      const ins = await client.query<{ id: number }>(
        `INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount, ship_by, source, amazon_status, amazon_updated_at)
         VALUES ('amazon', $1, false, $2, $3, $4, 'sp_api', $5, $6) RETURNING id`,
        [o.orderNo, o.createdAt, o.total, o.shipBy, o.status, o.updatedAt],
      );
      const id = ins.rows[0].id;
      // 同じ機種の明細はまとめる（単価がちがえば分けたまま）
      for (const l of o.lines) {
        const s = bySku.get(l.sellerSku)!;
        await client.query(
          `INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price) VALUES ($1, $2, $3, $4, $5)`,
          [id, s.sku_id, s.code, l.qty, l.unitPrice],
        );
      }
      await createOrderTask(
        client,
        SYSTEM,
        id,
        o.orderNo,
        o.lines.map((l) => ({ skuCode: bySku.get(l.sellerSku)!.code, qty: l.qty })),
        o.shipBy,
      );
      // 前に「取り込めません」と知らせていたら閉じる
      const pending = await findOpenTask(client, "system", `amazon-order:${o.orderNo}`);
      if (pending) await completeTask(client, SYSTEM, pending.id, "出品を登録したので取り込んだ");
      return "created";
    }

    // もうある注文：Amazon 側の状態と出荷期限を合わせる
    let changed = false;
    if (cur.amazon_status !== o.status || (o.shipBy && cur.ship_by !== o.shipBy)) {
      await client.query(
        `UPDATE core.orders SET amazon_status = $2, amazon_updated_at = $3, ship_by = coalesce($4::date, ship_by) WHERE id = $1`,
        [cur.id, o.status, o.updatedAt, cur.status === "open" ? o.shipBy : null],
      );
      changed = true;
      if (cur.status === "open" && o.shipBy && cur.ship_by !== o.shipBy) {
        const task = await findOpenTask(client, "system", `order:${cur.id}`);
        if (task) await setTaskDue(client, SYSTEM, task.id, await shipByDue(client, o.shipBy));
      }
    }
    if (cur.status === "open" && o.status === "CANCELLED") {
      await notifyOnce(
        client,
        `amazon-cancel:${cur.id}`,
        `Amazon で取り消された注文 ${o.orderNo} を、ここでも取り消す`,
        "自社出荷の注文の画面で、結びつけた個体を確かめてから「この注文を取り消す」を押してください（個体は出荷待ちに戻ります）。",
      );
      return "cancelledOnAmazon";
    }
    if (cur.status === "open" && o.status === "SHIPPED") {
      await notifyOnce(
        client,
        `amazon-shipped:${cur.id}`,
        `Amazon では発送済みの注文 ${o.orderNo} が、ここではまだ出荷待ちです`,
        "セラーセントラルで先に出荷通知をした場合は、自社出荷の画面で個体・送り状番号を入れて「発送した」「出荷通知をした」を押してください。",
      );
      return "shippedOnAmazon";
    }
    return changed ? "updated" : "unchanged";
  });
}

async function lastSuccess(): Promise<Date | null> {
  const [r] = await query<{ at: Date | null }>(
    `SELECT max(cursor_to) AS at FROM core.integration_runs WHERE kind = $1 AND ok`,
    [KIND],
  );
  return r?.at ?? null;
}

/**
 * 取り込みを1回動かす。
 * incremental … 前に成功した回の終わり（から10分重ねて）以降に更新された注文
 * reconcile / manual … 直近7日に作られた注文を全部見直す（取りこぼし・出品の登録待ちを拾う）
 */
export async function syncAmazonOrders(api: OrdersApi, mode: SyncMode, now: Date = new Date()): Promise<SyncResult> {
  const from = syncWindowFrom(mode, await lastSuccess(), now);
  const run = await withActor(SYSTEM, (c) =>
    c.query<{ id: number }>(
      `INSERT INTO core.integration_runs (kind, mode, cursor_from) VALUES ($1, $2, $3) RETURNING id`,
      [KIND, mode, from],
    ),
  );
  const runId = run.rows[0].id;
  const summary = emptySummary();
  const failedOrders: string[] = [];
  try {
    const orders = await api.searchOrders(
      mode === "incremental" ? { lastUpdatedAfter: from, merchantOnly: true } : { createdAfter: from, merchantOnly: true },
    );
    summary.fetched = orders.length;
    for (const raw of orders) {
      const m = mapOrder(raw);
      if (!m.ok) {
        summary.unreadable++;
        failedOrders.push(`${m.orderNo ?? "番号不明"}（${m.reason}）`);
        continue;
      }
      try {
        summary[await applyAmazonOrder(m.order)]++;
      } catch {
        failedOrders.push(`${m.order.orderNo}（登録できなかった）`);
      }
    }
    if (failedOrders.length > 0) {
      throw new Error(`取り込めなかった注文があります：${failedOrders.slice(0, 5).join("、")}`);
    }
    await withActor(SYSTEM, async (c) => {
      await c.query(
        `UPDATE core.integration_runs SET finished_at = now(), ok = true, cursor_to = $2, summary = $3 WHERE id = $1`,
        [runId, now, JSON.stringify(summary)],
      );
      // 止まっていると知らせていたら閉じる
      const alarm = await findOpenTask(c, "system", "sync:amazon_orders");
      if (alarm) await completeTask(c, SYSTEM, alarm.id, null, { recoveredRunId: runId });
    });
    return { ok: true, runId, summary };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "不明なエラー").slice(0, 300);
    await withActor(SYSTEM, async (c) => {
      await c.query(
        `UPDATE core.integration_runs SET finished_at = now(), ok = false, summary = $2, error = $3 WHERE id = $1`,
        [runId, JSON.stringify(summary), message],
      );
      await notifyOnce(
        c,
        "sync:amazon_orders",
        "Amazon の注文の取り込みが失敗しています",
        `自社出荷の注文が ToDo に入らなくなります。セラーセントラルで新しい注文を確かめてください。直ったら自動で閉じます。最後のエラー：${message}`,
        "ceo",
      );
    });
    return { ok: false, runId, error: message };
  }
}

export type SyncHealth = {
  configured: boolean;
  lastSuccessAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
  /** 30分以上成功していない（設定してあるのに） */
  stale: boolean;
};

/** 取り込みの様子（画面の警告用。読むだけ） */
export async function getSyncHealth(configured: boolean): Promise<SyncHealth> {
  const [r] = await query<{ lastSuccessAt: Date | null; lastRunAt: Date | null; lastError: string | null; stale: boolean }>(
    `SELECT (SELECT max(finished_at) FROM core.integration_runs WHERE kind = $1 AND ok) AS "lastSuccessAt",
            (SELECT max(started_at) FROM core.integration_runs WHERE kind = $1) AS "lastRunAt",
            (SELECT error FROM core.integration_runs WHERE kind = $1 AND finished_at IS NOT NULL
              ORDER BY finished_at DESC LIMIT 1) AS "lastError",
            coalesce((SELECT max(finished_at) FROM core.integration_runs WHERE kind = $1 AND ok)
                       < now() - make_interval(mins => $2), true) AS stale`,
    [KIND, STALE_MINUTES],
  );
  return { configured, ...r, stale: configured && r.stale };
}
