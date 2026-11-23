import "server-only";
import { DatabaseError } from "pg";
import { SpApiError, type ListingQtyApi } from "@/lib/amazon/sp-api";
import { query, withActor } from "@/lib/db";
import { buildableFromParts, fbmListingQty, stockShortage, type FbmPolicy } from "@/lib/fbm-plan-calc";
import { completeTask, createTask, findOpenTask, type Actor } from "@/lib/tasks";

// 自社出荷の機種ごとの「作り方」と「Amazon に出す数」。
//   表（getFbmPlanRows）… 出荷待ち・組立中・部品で組める台数・FBA の在庫から、出す数を計算する（読むだけ）
//   ToDo（updateFbmPlanTasks、FBA の取り込みと同じく1時間ごと）
//     作り置きの機種で、出荷待ち＋組立中が目標に足りない → 工場長に「自社出荷の作り置き：○○ を N台組み立てる」。足りたら閉じる
//     出す数が、最後に Amazon に送った数とちがう機種がある → 代表に「Amazon の出品数を直す」。そろったら閉じる
//   送る（sendListingQuantities）… 代表・工場長が画面で数を見て押したとき（承認）だけ。押した時の数と今の計算がちがえば送らない（ルール4）

const SYSTEM: Actor = { kind: "system" };
export const FBM_STOCK_REF = "fbm-stock:sku:";
export const FBM_QTY_REF = "fbm-listing-qty";

export type FbmPlanRow = {
  skuId: number;
  skuCode: string;
  skuName: string;
  fulfillment: "fbm" | "both";
  policy: FbmPolicy;
  target: number;
  maxToOrder: number;
  sellerSku: string;
  ready: number;
  pipeline: number;
  buildable: number;
  fbaFulfillable: number | null;
  /** Amazon に出す数（計算） */
  qty: number;
  why: string;
  /** 作り置きで、あと何台組むか */
  shortage: number;
  /** 最後に Amazon に送れた数と時刻（この出品で） */
  lastQty: number | null;
  lastSentAt: Date | null;
  /** 出す数が、最後に送った数とちがう（まだ送っていないものも含む） */
  changed: boolean;
};

export async function getFbmPlanRows(): Promise<FbmPlanRow[]> {
  const rows = await query<
    Omit<FbmPlanRow, "buildable" | "qty" | "why" | "shortage" | "changed" | "lastQty"> & { lastQty: string | null }
  >(
    `SELECT k.id AS "skuId", k.code AS "skuCode", k.name AS "skuName", k.amazon_fulfillment AS fulfillment,
            k.fbm_policy AS policy, k.fbm_stock_target AS target, k.fbm_max_to_order AS "maxToOrder", l.seller_sku AS "sellerSku",
            (SELECT count(*) FROM core.units u
              WHERE u.sku_id = k.id AND u.status = 'ready'
                AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                                 WHERE su.unit_id = u.id AND s.status <> 'cancelled')
                AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL))::int AS ready,
            (SELECT count(*) FROM core.units u
              WHERE u.sku_id = k.id AND u.status IN ('planned', 'assembling', 'inspecting')
                AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL))::int AS pipeline,
            (SELECT x.fulfillable FROM core.fba_inventory_snapshots x WHERE x.sku_id = k.id ORDER BY x.captured_at DESC LIMIT 1) AS "fbaFulfillable",
            a.payload ->> 'quantity' AS "lastQty", a.finished_at AS "lastSentAt"
       FROM core.skus k
       JOIN core.amazon_listings l ON l.sku_id = k.id AND l.fulfillment = 'fbm' AND l.active
       LEFT JOIN LATERAL (
         SELECT payload, finished_at FROM core.outbound_actions
          WHERE kind = 'amazon_listing_qty' AND subject_type = 'sku' AND subject_id = k.id AND status = 'sent'
            AND payload ->> 'sellerSku' = l.seller_sku
          ORDER BY finished_at DESC LIMIT 1) a ON true
      WHERE k.active AND k.amazon_fulfillment IN ('fbm', 'both')
      ORDER BY k.code`,
  );
  if (rows.length === 0) return [];
  const slots = await query<{ skuId: number; required: boolean; anyPart: boolean; qty: number; inStock: number }>(
    `SELECT s.sku_id AS "skuId", s.required, s.any_part AS "anyPart", s.qty,
            (SELECT count(*) FROM core.part_items pi
              WHERE pi.status = 'in_stock' AND pi.asset_class = 'parts_inventory'
                AND pi.part_model_id IN (SELECT o.part_model_id FROM core.sku_slot_options o WHERE o.slot_id = s.id))::int AS "inStock"
       FROM core.sku_slots s WHERE s.sku_id = ANY($1)`,
    [rows.map((r) => r.skuId)],
  );
  return rows.map((r) => {
    const buildable = buildableFromParts(slots.filter((s) => s.skuId === r.skuId));
    const { qty, why } = fbmListingQty({ ...r, buildable });
    const lastQty = r.lastQty === null ? null : Number(r.lastQty);
    return {
      ...r,
      buildable,
      qty,
      why,
      lastQty,
      shortage: stockShortage(r.policy, r.target, r.ready + r.pipeline),
      changed: lastQty !== qty,
    };
  });
}

export type FbmPlanTaskSummary = { stockCreated: number; stockClosed: number; qtyTask: "created" | "closed" | "kept" | "none" };

/** 作り置きの組立と、出品数の直しの ToDo を作る・閉じる */
export async function updateFbmPlanTasks(): Promise<FbmPlanTaskSummary> {
  const rows = await getFbmPlanRows();
  const summary: FbmPlanTaskSummary = { stockCreated: 0, stockClosed: 0, qtyTask: "none" };
  await withActor(SYSTEM, async (c) => {
    const short = new Set<number>();
    for (const r of rows) {
      if (r.shortage <= 0) continue;
      short.add(r.skuId);
      const ref = `${FBM_STOCK_REF}${r.skuId}`;
      if (await findOpenTask(c, "system", ref)) continue;
      await createTask(c, SYSTEM, {
        title: `自社出荷の作り置き：${r.skuCode} を ${r.shortage}台組み立てる`,
        description: `作り置きの目標は ${r.target}台です（今は出荷待ち ${r.ready}台・組立中 ${r.pipeline}台）。そろったら自動で完了になります。`,
        roleCode: "factory_manager",
        sourceKind: "system",
        sourceRef: ref,
      });
      summary.stockCreated++;
    }
    const open = await c.query<{ id: number; ref: string }>(
      `SELECT id, source_ref AS ref FROM core.tasks
        WHERE source_kind = 'system' AND source_ref LIKE $1 AND status IN ('todo', 'in_progress', 'awaiting_approval')`,
      [`${FBM_STOCK_REF}%`],
    );
    for (const t of open.rows) {
      if (short.has(Number(t.ref.slice(FBM_STOCK_REF.length)))) continue;
      await completeTask(c, SYSTEM, t.id, null, { reason: "作り置きが目標に届いた" });
      summary.stockClosed++;
    }

    const changed = rows.filter((r) => r.changed);
    const qtyTask = await findOpenTask(c, "system", FBM_QTY_REF);
    if (changed.length > 0 && !qtyTask) {
      await createTask(c, SYSTEM, {
        title: `Amazon の出品数を直す（自社出荷 ${changed.length}機種）`,
        description: `出す数が、最後に Amazon に送った数とちがいます：${changed
          .map((r) => `${r.skuCode} ${r.lastQty ?? "未送信"}→${r.qty}台`)
          .join("、")}。自社出荷の画面で数を確かめて反映してください。そろったら自動で完了になります。`,
        roleCode: "ceo",
        sourceKind: "system",
        sourceRef: FBM_QTY_REF,
      });
      summary.qtyTask = "created";
    } else if (changed.length === 0 && qtyTask) {
      await completeTask(c, SYSTEM, qtyTask.id, null, { reason: "出品数がそろった" });
      summary.qtyTask = "closed";
    } else if (qtyTask) {
      summary.qtyTask = "kept";
    }
  });
  return summary;
}

export type SendResult = { ok: boolean; message: string };

/**
 * 承認して、出品数を Amazon に送る。want は画面に出ていた数（skuId → 数）。今の計算とちがえば、その機種は送らない
 * actorId は requireManager で確かめた人（承認した人として残る）
 */
export async function sendListingQuantities(
  actorId: number,
  want: Map<number, number>,
  api: ListingQtyApi | null,
  sellerId: string | null,
): Promise<SendResult> {
  if (!api) return { ok: false, message: "SP-API のキーが設定されていません。" };
  if (!sellerId) return { ok: false, message: "出品者 ID（SP_API_SELLER_ID）が設定されていません（docs/deploy.md）。" };
  if (want.size === 0) return { ok: false, message: "送る機種がありません。" };
  const rows = await getFbmPlanRows();
  const done: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const [skuId, qty] of want) {
    const r = rows.find((x) => x.skuId === skuId);
    if (!r) {
      skipped.push(`機種 ${skuId}（自社出荷の出品がない）`);
      continue;
    }
    if (r.qty !== qty) {
      skipped.push(`${r.skuCode}（数が変わりました：${qty}→${r.qty}台。画面を開き直してください）`);
      continue;
    }
    let actionId: number;
    try {
      actionId = await withActor({ kind: "user", userId: actorId }, async (c) => {
        const ins = await c.query<{ id: number }>(
          `INSERT INTO core.outbound_actions (kind, subject_type, subject_id, payload, approved_by)
           VALUES ('amazon_listing_qty', 'sku', $1, $2, $3) RETURNING id`,
          [skuId, JSON.stringify({ sellerSku: r.sellerSku, quantity: qty, why: r.why }), actorId],
        );
        return ins.rows[0].id;
      });
    } catch (e) {
      if (e instanceof DatabaseError) {
        failed.push(`${r.skuCode}（記録できませんでした）`);
        continue;
      }
      throw e;
    }
    let error: string | null = null;
    try {
      const listing = await api.getListing(sellerId, r.sellerSku);
      if (!listing) throw new SpApiError(`Amazon にこの出品（${r.sellerSku}）が見つかりません。`, null, null);
      const res = await api.setListingQuantity(sellerId, r.sellerSku, listing.productType, qty);
      if (res.status !== "ACCEPTED") {
        const codes = res.issues.filter((i) => i.severity === "ERROR").map((i) => i.code);
        throw new SpApiError(`Amazon が受け付けませんでした（${res.status || "不明"}${codes.length ? `：${codes.slice(0, 5).join("・")}` : ""}）。`, null, null);
      }
    } catch (e) {
      error = (e instanceof SpApiError ? e.message : "送る途中で思わぬエラーが起きました。").slice(0, 300);
    }
    await withActor({ kind: "user", userId: actorId }, (c) =>
      c.query(`UPDATE core.outbound_actions SET status = $2, finished_at = now(), error = $3 WHERE id = $1`, [
        actionId,
        error ? "failed" : "sent",
        error,
      ]),
    );
    if (error) failed.push(`${r.skuCode}（${error}）`);
    else done.push(`${r.skuCode} ${qty}台`);
  }
  // 送れたら、出品数の直しの ToDo を見直す
  if (done.length > 0) await updateFbmPlanTasks();
  const parts = [
    done.length ? `Amazon に反映しました：${done.join("、")}` : "",
    failed.length ? `送れませんでした：${failed.join("、")}` : "",
    skipped.length ? `送っていません：${skipped.join("、")}` : "",
  ].filter(Boolean);
  return { ok: failed.length === 0 && skipped.length === 0 && done.length > 0, message: parts.join("。") };
}
