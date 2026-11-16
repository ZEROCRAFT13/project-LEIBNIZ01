import "server-only";
import { DatabaseError, type PoolClient } from "pg";
import { SpApiError, type ShipConfirmApi } from "@/lib/amazon/sp-api";
import { query, withActor } from "@/lib/db";
import { AMAZON_CARRIER_CODES, buildShipPackages, type AmazonItem, type ShipUnit } from "@/lib/fbm-calc";
import type { FbmResult } from "@/lib/fbm";
import { TaskRefused, completeTask, findOpenTask } from "@/lib/tasks";

// Amazon への出荷通知（自社出荷）を、この画面から SP-API で送る。
//   1. 送る中身（運送会社・発送日時・箱ごとの送り状番号と個体）を画面に出す
//   2. 代表・工場長が中身を見て「この内容で送る」を押す ＝ 承認。その時点の中身を outbound_actions に残す（ルール4）
//   3. Amazon の注文を問い合わせて明細の番号を知り、機種ごとの数がこちらの記録とぴったり合うときだけ、箱ごとに送る
//   4. 送れたら注文に「出荷通知をした（SP-API）」を記録し、ToDo の「出荷する」を完了にする。失敗したら理由を残す（送り直せる）
// 送り直しは同じ箱の番号で送るので、Amazon 側では同じ箱の内容が直る（二重にならない）。
// お客様の情報は問い合わせない（includedData は FULFILLMENT だけ）

class Refused extends Error {}

/** 承認したまま終わっていない送信があっても、これより古ければ止まったものとみなして送り直せる */
const STALE_INFLIGHT_MINUTES = 10;

export type ShipNoticeBox = { trackingNo: string; mgmtNos: string[]; skuCodes: string[] };
export type OutboundRow = {
  id: number;
  status: "approved" | "sent" | "failed";
  approvedAt: Date;
  approvedBy: string;
  finishedAt: Date | null;
  error: string | null;
};

export type ShipNoticePreview = {
  orderNo: string;
  carrier: string | null;
  carrierCode: string | null;
  shippedAt: Date | null;
  boxes: ShipNoticeBox[];
  /** これがあると、この画面からは送れない（セラーセントラルで人が通知する） */
  blockers: string[];
  history: OutboundRow[];
};

type OrderRow = { id: number; orderNo: string; status: string; carrier: string | null; shippedAt: Date | null; notifiedAt: Date | null };

async function readUnits(run: <T>(sql: string, params: unknown[]) => Promise<T[]>, orderId: number) {
  return run<ShipUnit & { skuCode: string }>(
    `SELECT u.mgmt_no AS "mgmtNo", u.sku_id AS "skuId", k.code AS "skuCode", ou.tracking_no AS "trackingNo"
       FROM core.order_units ou JOIN core.units u ON u.id = ou.unit_id JOIN core.skus k ON k.id = u.sku_id
      WHERE ou.order_id = $1 AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'
      ORDER BY ou.linked_at, ou.id`,
    [orderId],
  );
}

function boxesOf(units: (ShipUnit & { skuCode: string })[]): ShipNoticeBox[] {
  const boxes: ShipNoticeBox[] = [];
  for (const u of units) {
    const t = u.trackingNo ?? "（送り状番号なし）";
    let b = boxes.find((x) => x.trackingNo === t);
    if (!b) boxes.push((b = { trackingNo: t, mgmtNos: [], skuCodes: [] }));
    b.mgmtNos.push(u.mgmtNo);
    b.skuCodes.push(u.skuCode);
  }
  return boxes;
}

function blockersOf(o: OrderRow, units: ShipUnit[], configured: boolean): string[] {
  const b: string[] = [];
  if (!configured) b.push("SP-API のキーが設定されていません。");
  if (o.status !== "shipped") b.push("発送してから送れます。");
  if (o.notifiedAt) b.push("出荷通知は、もう済んでいます。");
  if (!o.carrier || !AMAZON_CARRIER_CODES[o.carrier]) {
    b.push("この運送会社は、この画面からは送れません（ヤマト・佐川・日本郵便だけ）。セラーセントラルで通知してください。");
  }
  if (units.length === 0) b.push("結びついた個体がありません。");
  if (units.some((u) => !u.trackingNo)) b.push("送り状番号が入っていない箱があります。");
  return b;
}

/** 送る中身（画面に出して、承認してもらうもの） */
export async function getShipNoticePreview(orderId: number, configured: boolean): Promise<ShipNoticePreview | null> {
  const [o] = await query<OrderRow>(
    `SELECT id, external_order_no AS "orderNo", status, carrier, shipped_at AS "shippedAt", ship_notified_at AS "notifiedAt"
       FROM core.orders WHERE id = $1 AND channel = 'amazon' AND NOT is_fba`,
    [orderId],
  );
  if (!o) return null;
  const units = await readUnits((sql, p) => query(sql, p), orderId);
  const history = await query<OutboundRow>(
    `SELECT a.id, a.status, a.approved_at AS "approvedAt", u.display_name AS "approvedBy", a.finished_at AS "finishedAt", a.error
       FROM core.outbound_actions a JOIN core.users u ON u.id = a.approved_by
      WHERE a.kind = 'amazon_ship_confirm' AND a.subject_type = 'order' AND a.subject_id = $1
      ORDER BY a.approved_at DESC LIMIT 10`,
    [orderId],
  );
  return {
    orderNo: o.orderNo,
    carrier: o.carrier,
    carrierCode: o.carrier ? (AMAZON_CARRIER_CODES[o.carrier] ?? null) : null,
    shippedAt: o.shippedAt,
    boxes: boxesOf(units),
    blockers: blockersOf(o, units, configured),
    history,
  };
}

function short(error: unknown): string {
  if (error instanceof SpApiError || error instanceof Refused) return error.message.slice(0, 300);
  return "送る途中で思わぬエラーが起きました。時間をおいて送り直してください。";
}

/**
 * 承認して、Amazon に出荷通知を送る。actorId は requireManager で確かめた人（承認した人として残る）。
 * delayReason は、出荷期限を過ぎているとき（ToDo の完了に要る）
 */
export async function sendShipNotice(
  actorId: number,
  orderId: number,
  delayReason: string | null,
  api: ShipConfirmApi | null,
): Promise<FbmResult> {
  const reason = delayReason?.normalize("NFC").trim() || null;
  // 1. 確かめて、承認した中身を残す（送る前に記録する。Amazon が失敗しても承認の記録は残る）
  let prepared: { actionId: number; orderNo: string; carrierCode: string; shipDate: string; units: ShipUnit[] };
  try {
    prepared = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const r = await client.query<OrderRow>(
        `SELECT id, external_order_no AS "orderNo", status, carrier, shipped_at AS "shippedAt", ship_notified_at AS "notifiedAt"
           FROM core.orders WHERE id = $1 AND channel = 'amazon' AND NOT is_fba FOR UPDATE`,
        [orderId],
      );
      const o = r.rows[0];
      if (!o) throw new Refused("自社出荷の注文が見つかりません。");
      const units = await readUnits(async (sql, p) => (await client.query(sql, p)).rows, orderId);
      const blockers = blockersOf(o, units, api !== null);
      if (blockers.length > 0) throw new Refused(blockers.join(" "));
      const inflight = await client.query(
        `SELECT 1 FROM core.outbound_actions
          WHERE kind = 'amazon_ship_confirm' AND subject_type = 'order' AND subject_id = $1 AND status = 'approved'
            AND approved_at > now() - make_interval(mins => $2)`,
        [orderId, STALE_INFLIGHT_MINUTES],
      );
      if (inflight.rowCount) throw new Refused("この注文の出荷通知は、いま送っているところです。少し待ってから画面を開き直してください。");
      await requireDelayReasonIfOverdue(client, orderId, reason);
      const carrierCode = AMAZON_CARRIER_CODES[o.carrier!]!;
      const shipDate = o.shippedAt!.toISOString();
      const payload = {
        orderNo: o.orderNo,
        carrierCode,
        shipDate,
        boxes: boxesOf(units).map((b) => ({ trackingNo: b.trackingNo, mgmtNos: b.mgmtNos })),
      };
      const ins = await client.query<{ id: number }>(
        `INSERT INTO core.outbound_actions (kind, subject_type, subject_id, payload, approved_by)
         VALUES ('amazon_ship_confirm', 'order', $1, $2, $3) RETURNING id`,
        [orderId, JSON.stringify(payload), actorId],
      );
      return { actionId: ins.rows[0].id, orderNo: o.orderNo, carrierCode, shipDate, units };
    });
  } catch (error) {
    if (error instanceof Refused || error instanceof TaskRefused) return { ok: false, message: error.message };
    if (error instanceof DatabaseError && error.code === "P0001") return { ok: false, message: error.message };
    throw error;
  }

  // 2. Amazon に送る（DB のトランザクションの外で）
  let sent = 0;
  try {
    const order = await api!.getOrder(prepared.orderNo);
    if (!order) throw new Refused("Amazon にこの注文が見つかりません（注文番号を確かめてください）。");
    if (order.fulfillment?.fulfilledBy !== "MERCHANT") throw new Refused("Amazon ではこの注文は自社出荷になっていません。");
    if (order.fulfillment?.fulfillmentStatus === "CANCELLED") throw new Refused("Amazon でこの注文は取り消されています。");
    const items = await amazonItems(order.orderItems ?? []);
    const built = buildShipPackages(prepared.units, items);
    if (!built.ok) throw new Refused(built.errors.join(" "));
    for (const p of built.packages) {
      await api!.confirmShipment(prepared.orderNo, {
        packageReferenceId: p.packageReferenceId,
        carrierCode: prepared.carrierCode,
        trackingNumber: p.trackingNumber,
        shipDate: prepared.shipDate,
        orderItems: p.orderItems,
      });
      sent += 1;
    }
  } catch (error) {
    const message = short(error) + (sent > 0 ? `（${sent}箱目までは送れています。送り直すと同じ箱の内容が直ります）` : "");
    await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(`UPDATE core.outbound_actions SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [
        prepared.actionId,
        message.slice(0, 300),
      ]),
    );
    return { ok: false, message: `Amazon に出荷通知を送れませんでした：${message}` };
  }

  // 3. 送れたことを記録し、ToDo を完了にする
  await withActor({ kind: "user", userId: actorId }, async (client) => {
    await client.query(`UPDATE core.outbound_actions SET status = 'sent', finished_at = now() WHERE id = $1`, [prepared.actionId]);
    await client.query(
      `UPDATE core.orders SET ship_notified_at = now(), ship_notified_by = $2, ship_notified_via = 'sp_api'
        WHERE id = $1 AND ship_notified_at IS NULL`,
      [orderId, actorId],
    );
    const task = await findOpenTask(client, "system", `order:${orderId}`);
    if (task) {
      await completeTask(client, { kind: "user", userId: actorId }, task.id, reason, {
        orderNo: prepared.orderNo,
        outboundActionId: prepared.actionId,
      });
    }
  });
  return { ok: true, message: `Amazon に出荷通知を送りました（${sent}箱）。ToDo の「出荷する」を完了にしました。` };
}

/** ToDo の「出荷する」が期限を過ぎていれば、遅れた理由が要る（送ってから完了できないことがないよう、先に確かめる） */
async function requireDelayReasonIfOverdue(client: PoolClient, orderId: number, reason: string | null): Promise<void> {
  const task = await findOpenTask(client, "system", `order:${orderId}`);
  if (!task) return;
  const r = await client.query<{ overdue: boolean }>(`SELECT due_at IS NOT NULL AND now() > due_at AS overdue FROM core.tasks WHERE id = $1`, [
    task.id,
  ]);
  if (r.rows[0]?.overdue && !reason) throw new Refused("出荷期限を過ぎているので、遅れた理由を書いてください。");
}

/** Amazon の注文の明細 → こちらの機種（自社出荷の出品のセラー SKU から。止めた出品も含めて引く） */
async function amazonItems(raw: { orderItemId?: string; quantityOrdered?: number; product?: { sellerSku?: string } }[]): Promise<AmazonItem[]> {
  const items = raw.map((i) => ({
    orderItemId: String(i.orderItemId ?? ""),
    sellerSku: String(i.product?.sellerSku ?? "").trim(),
    quantity: Number.isInteger(i.quantityOrdered) ? (i.quantityOrdered as number) : -1,
  }));
  if (items.some((i) => !i.orderItemId || !i.sellerSku || i.quantity < 0)) {
    throw new Refused("Amazon の注文の明細が読めません。");
  }
  const rows = await query<{ sellerSku: string; skuId: number }>(
    `SELECT seller_sku AS "sellerSku", sku_id AS "skuId" FROM core.amazon_listings
      WHERE fulfillment = 'fbm' AND seller_sku = ANY($1)`,
    [items.map((i) => i.sellerSku)],
  );
  return items.map((i) => ({ ...i, skuId: rows.find((r) => r.sellerSku === i.sellerSku)?.skuId ?? null }));
}
