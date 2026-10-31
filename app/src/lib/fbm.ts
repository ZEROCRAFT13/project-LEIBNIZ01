import "server-only";
import { DatabaseError, type PoolClient } from "pg";
import { isMgmtNo, normalizeSearch } from "@/lib/codes";
import { query, withActor } from "@/lib/db";
import { isTracking, normalizeTracking, type FbaCarrier } from "@/lib/fba-calc";
import type { FbmOrderInput, FbmStatus } from "@/lib/fbm-calc";

// Amazon の自社出荷（FBM）。まずは手で記録する：注文番号で注文を登録し、出荷待ちの個体を結びつけ、
// 送り状番号を入れて発送する。お客様の名前・住所はここに持たない（セラーセントラルや運送会社のシステムで扱う）。
// Amazon への出荷通知は、当面はセラーセントラルで人が行い、行ったことを記録する（ここからは何も送らない）。
// 個体の状態は DB のトリガー（0016）が注文の状態に合わせて変える。
// actorId は、呼ぶ側（app/fbm/actions.ts）が requireManager でログインから決めたものを渡す。

export type FbmResult = { ok: boolean; message: string };

class Refused extends Error {}

function dbMessage(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "P0001") return error.message; // 0001・0016 のトリガーの日本語のメッセージ
  if (error.code === "23505" && error.constraint === "orders_channel_external_order_no_key") {
    return "その注文番号は、もう登録されています。";
  }
  if (error.code === "23505" && error.constraint === "order_units_active_uq") return "その個体は、もう別の注文に結びついています。";
  if (error.code === "23514") return "入力が決まりに合っていません。もう一度確かめてください。";
  return null;
}

async function run<T extends FbmResult>(actorId: number, fn: (client: PoolClient) => Promise<T>): Promise<T | FbmResult> {
  try {
    return await withActor({ kind: "user", userId: actorId }, fn);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    const m = dbMessage(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}

async function lockOrder(client: PoolClient, id: number): Promise<{ id: number; status: FbmStatus; external_order_no: string }> {
  const r = await client.query<{ id: number; status: FbmStatus; external_order_no: string }>(
    `SELECT id, status, external_order_no FROM core.orders
      WHERE id = $1 AND channel = 'amazon' AND NOT is_fba FOR UPDATE`,
    [id],
  );
  if (!r.rows[0]) throw new Refused("自社出荷の注文が見つかりません。");
  return r.rows[0];
}

// ---------------------------------------------------------------------
// 読む
// ---------------------------------------------------------------------

export type FbmSku = { id: number; code: string; name: string; sellerSku: string; listPrice: number | null; available: number };

/** 自社出荷で売っている機種（自社出荷用の出品があるもの）と、今出せる台数 */
export async function listFbmSkus(): Promise<FbmSku[]> {
  return query<FbmSku>(
    `SELECT k.id, k.code, k.name, l.seller_sku AS "sellerSku", k.list_price AS "listPrice",
            (SELECT count(*) FROM core.units u
              WHERE u.sku_id = k.id AND u.status = 'ready'
                AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                                 WHERE su.unit_id = u.id AND s.status <> 'cancelled')
                AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL))::int AS available
       FROM core.skus k
       JOIN core.amazon_listings l ON l.sku_id = k.id AND l.fulfillment = 'fbm' AND l.active
      WHERE k.amazon_fulfillment IN ('fbm', 'both')
      ORDER BY k.code`,
  );
}

export type FbmOrderRow = {
  id: number;
  orderNo: string;
  status: FbmStatus;
  orderedAt: Date;
  shipBy: string | null;
  skuCode: string;
  qty: number;
  linked: number;
  totalAmount: number;
  shippedAt: Date | null;
  notifiedAt: Date | null;
  /** 出荷期限まであと何日か（日本の日付。今日なら 0、過ぎたら負） */
  daysLeft: number | null;
};

const ORDER_COLUMNS = `o.id, o.external_order_no AS "orderNo", o.status, o.ordered_at AS "orderedAt", o.ship_by AS "shipBy",
  o.total_amount AS "totalAmount", o.shipped_at AS "shippedAt", o.ship_notified_at AS "notifiedAt",
  (o.ship_by - (now() AT TIME ZONE 'Asia/Tokyo')::date) AS "daysLeft",
  (SELECT string_agg(k.code, '・' ORDER BY k.code) FROM core.order_lines l JOIN core.skus k ON k.id = l.sku_id
    WHERE l.order_id = o.id) AS "skuCode",
  (SELECT coalesce(sum(l.qty), 0) FROM core.order_lines l WHERE l.order_id = o.id)::int AS qty,
  (SELECT count(*) FROM core.order_units ou
    WHERE ou.order_id = o.id AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping')::int AS linked`;

/** 自社出荷の注文（出荷待ち・出荷通知がまだのものが上。終わったものは直近の分だけ） */
export async function listFbmOrders(): Promise<FbmOrderRow[]> {
  return query<FbmOrderRow>(
    `SELECT ${ORDER_COLUMNS}
       FROM core.orders o
      WHERE o.channel = 'amazon' AND NOT o.is_fba
        AND (o.status = 'open' OR (o.status = 'shipped' AND o.ship_notified_at IS NULL)
             OR o.created_at > now() - interval '60 days')
      ORDER BY o.status <> 'open', (o.status = 'shipped' AND o.ship_notified_at IS NULL) DESC,
               o.ship_by NULLS LAST, o.ordered_at DESC
      LIMIT 200`,
  );
}

export type FbmLinkedUnit = { mgmtNo: string; skuCode: string; status: string; trackingNo: string | null; linkedAt: Date };

export type FbmOrderDetail = FbmOrderRow & {
  carrier: FbaCarrier | null;
  note: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  notifiedBy: string | null;
  lines: { skuId: number; skuCode: string; skuName: string; qty: number; unitPrice: number }[];
  units: FbmLinkedUnit[];
  /** 結びつけられる個体（出荷待ちで、注文の機種で、FBA の納品にも別の注文にも入っていない） */
  candidates: { mgmtNo: string; skuCode: string }[];
};

export async function getFbmOrder(id: number): Promise<FbmOrderDetail | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [row] = await query<
    FbmOrderRow & { carrier: FbaCarrier | null; note: string | null; cancelReason: string | null; createdBy: string | null; notifiedBy: string | null }
  >(
    `SELECT ${ORDER_COLUMNS}, o.carrier, o.note, o.cancel_reason AS "cancelReason",
            cb.display_name AS "createdBy", nb.display_name AS "notifiedBy"
       FROM core.orders o
       LEFT JOIN core.users cb ON cb.id = o.created_by
       LEFT JOIN core.users nb ON nb.id = o.ship_notified_by
      WHERE o.id = $1 AND o.channel = 'amazon' AND NOT o.is_fba`,
    [id],
  );
  if (!row) return null;
  const [lines, units] = await Promise.all([
    query<FbmOrderDetail["lines"][number]>(
      `SELECT l.sku_id AS "skuId", k.code AS "skuCode", k.name AS "skuName", l.qty, l.unit_price AS "unitPrice"
         FROM core.order_lines l JOIN core.skus k ON k.id = l.sku_id
        WHERE l.order_id = $1 ORDER BY l.id`,
      [id],
    ),
    query<FbmLinkedUnit>(
      `SELECT u.mgmt_no AS "mgmtNo", k.code AS "skuCode", u.status, ou.tracking_no AS "trackingNo", ou.linked_at AS "linkedAt"
         FROM core.order_units ou JOIN core.units u ON u.id = ou.unit_id JOIN core.skus k ON k.id = u.sku_id
        WHERE ou.order_id = $1 AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'
        ORDER BY ou.linked_at`,
      [id],
    ),
  ]);
  const candidates =
    row.status === "open"
      ? await query<{ mgmtNo: string; skuCode: string }>(
          `SELECT u.mgmt_no AS "mgmtNo", k.code AS "skuCode"
             FROM core.units u JOIN core.skus k ON k.id = u.sku_id
            WHERE u.status = 'ready' AND u.sku_id = ANY($1)
              AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                               WHERE su.unit_id = u.id AND s.status <> 'cancelled')
              AND NOT EXISTS (SELECT 1 FROM core.order_units ou WHERE ou.unit_id = u.id AND ou.unlinked_at IS NULL)
            ORDER BY u.inspected_at NULLS LAST, u.mgmt_no
            LIMIT 50`,
          [lines.map((l) => l.skuId)],
        )
      : [];
  return { ...row, lines, units, candidates };
}

// ---------------------------------------------------------------------
// 書く
// ---------------------------------------------------------------------

/** 自社出荷の注文を登録する（SP-API で取り込めるようになるまでは手で） */
export async function createFbmOrder(actorId: number, input: FbmOrderInput): Promise<FbmResult & { id?: number }> {
  return run(actorId, async (client) => {
    const sku = await client.query<{ code: string }>(
      `SELECT k.code FROM core.skus k
        WHERE k.id = $1 AND k.amazon_fulfillment IN ('fbm', 'both')
          AND EXISTS (SELECT 1 FROM core.amazon_listings l WHERE l.sku_id = k.id AND l.fulfillment = 'fbm' AND l.active)`,
      [input.skuId],
    );
    if (!sku.rows[0]) throw new Refused("その機種は自社出荷で売っていません（機種の設定で、自社出荷用の出品を登録してください）。");
    const r = await client.query<{ id: number }>(
      `INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, total_amount, ship_by, note, created_by)
       VALUES ('amazon', $1, false, $2, $3, $4, $5, $6) RETURNING id`,
      [input.orderNo, input.orderedAt, input.totalAmount, input.shipBy, input.note, actorId],
    );
    const id = r.rows[0].id;
    await client.query(
      `INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price) VALUES ($1, $2, $3, $4, $5)`,
      [id, input.skuId, sku.rows[0].code, input.qty, input.totalAmount / input.qty],
    );
    return { ok: true, id, message: `注文 ${input.orderNo} を登録しました。` };
  });
}

/** 管理番号のシール（QR でもよい）を読んで、注文に結びつける */
export async function linkUnit(actorId: number, orderId: number, rawCode: string): Promise<FbmResult> {
  const mgmtNo = normalizeSearch(rawCode);
  if (!isMgmtNo(mgmtNo)) return { ok: false, message: `「${rawCode}」は管理番号ではありません。` };
  return run(actorId, async (client) => {
    await lockOrder(client, orderId);
    const u = await client.query<{ id: number }>(`SELECT id FROM core.units WHERE mgmt_no = $1`, [mgmtNo]);
    if (!u.rows[0]) throw new Refused(`${mgmtNo} という個体はありません。`);
    await client.query(
      `INSERT INTO core.order_units (order_id, unit_id, link_method, linked_by) VALUES ($1, $2, 'shipping', $3)`,
      [orderId, u.rows[0].id, actorId],
    );
    return { ok: true, message: `${mgmtNo} を結びつけました。` };
  });
}

/** 発送前なら外せる（読み間違い・別の個体に替えるとき） */
export async function unlinkUnit(actorId: number, orderId: number, rawMgmtNo: string): Promise<FbmResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  return run(actorId, async (client) => {
    await lockOrder(client, orderId);
    const r = await client.query(
      `UPDATE core.order_units ou SET unlinked_at = now(), unlink_reason = '出荷前に外した'
         FROM core.units u
        WHERE ou.order_id = $1 AND ou.unit_id = u.id AND u.mgmt_no = $2
          AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'`,
      [orderId, mgmtNo],
    );
    if (r.rowCount !== 1) throw new Refused(`${mgmtNo} はこの注文に結びついていません。`);
    return { ok: true, message: `${mgmtNo} を外しました。` };
  });
}

/** 箱（個体）ごとの送り状番号 */
export async function setOrderTracking(actorId: number, orderId: number, rawMgmtNo: string, rawTracking: string): Promise<FbmResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  const tracking = normalizeTracking(rawTracking);
  if (tracking !== "" && !isTracking(tracking)) return { ok: false, message: "送り状番号は、数字とハイフンで6〜30文字です。" };
  return run(actorId, async (client) => {
    await lockOrder(client, orderId);
    const r = await client.query(
      `UPDATE core.order_units ou SET tracking_no = $3
         FROM core.units u
        WHERE ou.order_id = $1 AND ou.unit_id = u.id AND u.mgmt_no = $2
          AND ou.unlinked_at IS NULL AND ou.link_method = 'shipping'`,
      [orderId, mgmtNo, tracking || null],
    );
    if (r.rowCount !== 1) throw new Refused(`${mgmtNo} はこの注文に結びついていません。`);
    return { ok: true, message: tracking ? `${mgmtNo} の送り状番号を保存しました。` : `${mgmtNo} の送り状番号を消しました。` };
  });
}

/** 運送会社とメモ */
export async function updateFbmOrderInfo(
  actorId: number,
  orderId: number,
  info: { carrier: FbaCarrier | null; note: string | null },
): Promise<FbmResult> {
  return run(actorId, async (client) => {
    await lockOrder(client, orderId);
    await client.query(`UPDATE core.orders SET carrier = $2, note = $3 WHERE id = $1`, [orderId, info.carrier, info.note]);
    return { ok: true, message: "保存しました。" };
  });
}

/** 発送した（結びついた個体は「出荷済み」になる） */
export async function markFbmShipped(actorId: number, orderId: number): Promise<FbmResult> {
  return run(actorId, async (client) => {
    const o = await lockOrder(client, orderId);
    if (o.status !== "open") throw new Refused("この注文は、もう発送しています。");
    await client.query(`UPDATE core.orders SET status = 'shipped', shipped_at = now() WHERE id = $1`, [orderId]);
    return {
      ok: true,
      message: "発送しました。セラーセントラルで出荷通知（送り状番号の入力）をして、終わったら「出荷通知をした」を押してください。",
    };
  });
}

/** セラーセントラルで出荷通知をしたことを記録する（ここから Amazon には送らない） */
export async function markShipNotified(actorId: number, orderId: number): Promise<FbmResult> {
  return run(actorId, async (client) => {
    const o = await lockOrder(client, orderId);
    if (o.status === "open" || o.status === "cancelled") throw new Refused("発送してから記録してください。");
    const r = await client.query(
      `UPDATE core.orders SET ship_notified_at = now(), ship_notified_by = $2 WHERE id = $1 AND ship_notified_at IS NULL`,
      [orderId, actorId],
    );
    if (r.rowCount !== 1) throw new Refused("出荷通知は、もう記録してあります。");
    return { ok: true, message: "出荷通知をしたことを記録しました。" };
  });
}

/** 発送前の注文を取り消す（結びついた個体は外れて、出荷待ちに戻る） */
export async function cancelFbmOrder(actorId: number, orderId: number, rawReason: string): Promise<FbmResult> {
  const reason = rawReason.normalize("NFC").trim();
  if (reason.length < 1 || reason.length > 200) return { ok: false, message: "取り消しの理由を書いてください（200文字まで）。" };
  return run(actorId, async (client) => {
    const o = await lockOrder(client, orderId);
    if (o.status !== "open") throw new Refused("発送した注文は取り消せません（返品として扱います）。");
    await client.query(
      `UPDATE core.order_units SET unlinked_at = now(), unlink_reason = '注文の取り消し'
        WHERE order_id = $1 AND unlinked_at IS NULL AND link_method = 'shipping'`,
      [orderId],
    );
    await client.query(`UPDATE core.orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [orderId, reason]);
    return { ok: true, message: `注文 ${o.external_order_no} を取り消しました。` };
  });
}

/** 注文日時の欄の初期値（日本時間の今。datetime-local の形） */
export async function nowLocalMinute(): Promise<string> {
  const [r] = await query<{ v: string }>(`SELECT to_char(now() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') AS v`);
  return r.v;
}
