import "server-only";
import { DatabaseError, type PoolClient } from "pg";
import { isMgmtNo, normalizeSearch } from "@/lib/codes";
import { query, withActor } from "@/lib/db";
import {
  isTracking,
  normalizeTracking,
  summarizeBySku,
  type FbaCarrier,
  type FbaStatus,
  type ShipmentInfo,
  type SkuCount,
} from "@/lib/fba-calc";

// FBA 納品（まずは手で記録する）。セラーセントラルで作った納品プランの番号（FBA15…）を入れ、
// どの個体をどの納品で送ったかを残す。個体の状態は DB のトリガー（0015）が納品の状態に合わせて変える。
// actorId は、呼ぶ側（app/fba/actions.ts）が requireManager でログインから決めたものを渡す。

export type FbaResult = { ok: boolean; message: string };

class Refused extends Error {}

function dbMessage(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "P0001") return error.message; // 0015 のトリガーの日本語のメッセージ
  if (error.code === "23505" && error.constraint === "fba_shipments_amazon_shipment_id_key") {
    return "その Amazon の出荷の番号は、もう別の納品に入っています。";
  }
  if (error.code === "23505" && error.constraint === "fba_shipment_units_pkey") return "その個体は、もうこの納品に入っています。";
  if (error.code === "23514") return "入力が決まりに合っていません。もう一度確かめてください。";
  return null;
}

async function run(actorId: number, fn: (client: PoolClient) => Promise<FbaResult>): Promise<FbaResult> {
  try {
    return await withActor({ kind: "user", userId: actorId }, fn);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    const m = dbMessage(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}

async function lockShipment(client: PoolClient, id: number): Promise<{ id: number; status: FbaStatus }> {
  const r = await client.query<{ id: number; status: FbaStatus }>(
    `SELECT id, status FROM core.fba_shipments WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!r.rows[0]) throw new Refused("納品が見つかりません。");
  return r.rows[0];
}

// ---------------------------------------------------------------------
// 読む
// ---------------------------------------------------------------------

export type ShipmentRow = {
  id: number;
  amazonShipmentId: string | null;
  status: FbaStatus;
  destinationFc: string | null;
  carrier: FbaCarrier | null;
  unitCount: number;
  receivedCount: number;
  createdAt: Date;
  shippedAt: Date | null;
  closedAt: Date | null;
};

const SHIPMENT_COLUMNS = `s.id, s.amazon_shipment_id AS "amazonShipmentId", s.status, s.destination_fc AS "destinationFc",
  s.carrier, s.created_at AS "createdAt", s.shipped_at AS "shippedAt", s.closed_at AS "closedAt",
  (SELECT count(*) FROM core.fba_shipment_units su WHERE su.shipment_id = s.id)::int AS "unitCount",
  (SELECT coalesce(sum(r.received_qty), 0) FROM core.fba_shipment_receipts r WHERE r.shipment_id = s.id)::int AS "receivedCount"`;

/** 納品の一覧（終わっていないものが上。完了・取り消しは直近の分だけ） */
export async function listFbaShipments(): Promise<ShipmentRow[]> {
  return query<ShipmentRow>(
    `SELECT ${SHIPMENT_COLUMNS}
       FROM core.fba_shipments s
      WHERE s.status NOT IN ('closed', 'cancelled') OR coalesce(s.closed_at, s.created_at) > now() - interval '60 days'
      ORDER BY s.status IN ('closed', 'cancelled'), s.created_at DESC
      LIMIT 100`,
  );
}

export type ReadyUnit = { mgmtNo: string; skuId: number; skuCode: string; fulfillment: "fba" | "both"; inspectedAt: Date | null };

/** FBA に送れる個体：出荷待ちで、FBA で売る機種（fba / both）で、どの納品にも入っていない */
export async function listReadyForFba(): Promise<ReadyUnit[]> {
  return query<ReadyUnit>(
    `SELECT u.mgmt_no AS "mgmtNo", k.id AS "skuId", k.code AS "skuCode", k.amazon_fulfillment AS fulfillment,
            u.inspected_at AS "inspectedAt"
       FROM core.units u JOIN core.skus k ON k.id = u.sku_id
      WHERE u.status = 'ready' AND k.amazon_fulfillment IN ('fba', 'both')
        AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                         WHERE su.unit_id = u.id AND s.status <> 'cancelled')
      ORDER BY k.code, u.inspected_at NULLS LAST, u.mgmt_no`,
  );
}

export type ShipmentUnit = { mgmtNo: string; skuId: number; skuCode: string; status: string; trackingNo: string | null };

export type ShipmentDetail = ShipmentRow & {
  note: string | null;
  createdBy: string | null;
  units: ShipmentUnit[];
  bySku: SkuCount[];
  allReceived: boolean;
  /** 入っている個体のうち、出荷待ちでないもの（下書きのあいだに検品をやり直したなど） */
  notReady: number;
};

export async function getFbaShipment(id: number): Promise<ShipmentDetail | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [row] = await query<ShipmentRow & { note: string | null; createdBy: string | null }>(
    `SELECT ${SHIPMENT_COLUMNS}, s.note, us.display_name AS "createdBy"
       FROM core.fba_shipments s LEFT JOIN core.users us ON us.id = s.created_by
      WHERE s.id = $1`,
    [id],
  );
  if (!row) return null;
  const [units, receipts] = await Promise.all([
    query<ShipmentUnit>(
      `SELECT u.mgmt_no AS "mgmtNo", k.id AS "skuId", k.code AS "skuCode", u.status, su.tracking_no AS "trackingNo"
         FROM core.fba_shipment_units su
         JOIN core.units u ON u.id = su.unit_id
         JOIN core.skus k ON k.id = u.sku_id
        WHERE su.shipment_id = $1
        ORDER BY k.code, su.added_at, u.mgmt_no`,
      [id],
    ),
    query<{ skuId: number; receivedQty: number }>(
      `SELECT sku_id AS "skuId", received_qty AS "receivedQty" FROM core.fba_shipment_receipts WHERE shipment_id = $1`,
      [id],
    ),
  ]);
  const sum = summarizeBySku(units, receipts);
  return {
    ...row,
    units,
    bySku: sum.rows,
    allReceived: sum.allReceived,
    notReady: row.status === "draft" ? units.filter((u) => u.status !== "ready").length : 0,
  };
}

// ---------------------------------------------------------------------
// 書く
// ---------------------------------------------------------------------

/** 新しい納品（下書き）を作る */
export async function createFbaShipment(actorId: number): Promise<number> {
  return withActor({ kind: "user", userId: actorId }, async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO core.fba_shipments (created_by) VALUES ($1) RETURNING id`,
      [actorId],
    );
    return r.rows[0].id;
  });
}

/** 管理番号のシール（QR でも）を読んで、納品に入れる */
export async function addUnitToShipment(actorId: number, shipmentId: number, rawCode: string): Promise<FbaResult> {
  const mgmtNo = normalizeSearch(rawCode);
  if (!isMgmtNo(mgmtNo)) return { ok: false, message: `「${rawCode}」は管理番号ではありません。` };
  return run(actorId, async (client) => {
    await lockShipment(client, shipmentId);
    const u = await client.query<{ id: number }>(`SELECT id FROM core.units WHERE mgmt_no = $1`, [mgmtNo]);
    if (!u.rows[0]) throw new Refused(`${mgmtNo} という個体はありません。`);
    await client.query(
      `INSERT INTO core.fba_shipment_units (shipment_id, unit_id, added_by) VALUES ($1, $2, $3)`,
      [shipmentId, u.rows[0].id, actorId],
    );
    return { ok: true, message: `${mgmtNo} を入れました。` };
  });
}

/** 下書きの納品から外す */
export async function removeUnitFromShipment(actorId: number, shipmentId: number, rawMgmtNo: string): Promise<FbaResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  return run(actorId, async (client) => {
    await lockShipment(client, shipmentId);
    const r = await client.query(
      `DELETE FROM core.fba_shipment_units su USING core.units u
        WHERE su.shipment_id = $1 AND su.unit_id = u.id AND u.mgmt_no = $2`,
      [shipmentId, mgmtNo],
    );
    if (r.rowCount !== 1) throw new Refused(`${mgmtNo} はこの納品に入っていません。`);
    return { ok: true, message: `${mgmtNo} を外しました。` };
  });
}

/** 納品の見出し（Amazon の番号・倉庫・運送会社・メモ）を保存する */
export async function updateShipmentInfo(actorId: number, shipmentId: number, info: ShipmentInfo): Promise<FbaResult> {
  return run(actorId, async (client) => {
    const s = await lockShipment(client, shipmentId);
    if (s.status === "closed" || s.status === "cancelled") {
      await client.query(`UPDATE core.fba_shipments SET note = $2 WHERE id = $1`, [shipmentId, info.note]);
      return { ok: true, message: "メモを保存しました。" };
    }
    await client.query(
      `UPDATE core.fba_shipments
          SET amazon_shipment_id = CASE WHEN status = 'draft' THEN $2 ELSE amazon_shipment_id END,
              destination_fc = $3, carrier = $4, note = $5
        WHERE id = $1`,
      [shipmentId, info.amazonShipmentId, info.destinationFc, info.carrier, info.note],
    );
    return { ok: true, message: "保存しました。" };
  });
}

/** 個体（箱）ごとの送り状番号。空にすると消す */
export async function setUnitTracking(actorId: number, shipmentId: number, rawMgmtNo: string, rawTracking: string): Promise<FbaResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  const tracking = normalizeTracking(rawTracking);
  if (tracking !== "" && !isTracking(tracking)) {
    return { ok: false, message: "送り状番号は、数字とハイフンで6〜30文字です。" };
  }
  return run(actorId, async (client) => {
    await lockShipment(client, shipmentId);
    const r = await client.query(
      `UPDATE core.fba_shipment_units su SET tracking_no = $3
         FROM core.units u
        WHERE su.shipment_id = $1 AND su.unit_id = u.id AND u.mgmt_no = $2`,
      [shipmentId, mgmtNo, tracking || null],
    );
    if (r.rowCount !== 1) throw new Refused(`${mgmtNo} はこの納品に入っていません。`);
    return { ok: true, message: tracking ? `${mgmtNo} の送り状番号を保存しました。` : `${mgmtNo} の送り状番号を消しました。` };
  });
}

/** 発送した（入れた個体は「FBA へ輸送中」になる） */
export async function markShipped(actorId: number, shipmentId: number): Promise<FbaResult> {
  return run(actorId, async (client) => {
    const s = await lockShipment(client, shipmentId);
    if (s.status !== "draft") throw new Refused("この納品は、もう発送しています。");
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.fba_shipment_units WHERE shipment_id = $1`,
      [shipmentId],
    );
    await client.query(`UPDATE core.fba_shipments SET status = 'shipped', shipped_at = now() WHERE id = $1`, [shipmentId]);
    return { ok: true, message: `発送しました。${r.rows[0].n}台が「FBA へ輸送中」になりました。` };
  });
}

/** 下書きを取り消す（入れた個体は出荷待ちのまま。ほかの納品に入れられる） */
export async function cancelShipment(actorId: number, shipmentId: number): Promise<FbaResult> {
  return run(actorId, async (client) => {
    const s = await lockShipment(client, shipmentId);
    if (s.status !== "draft") throw new Refused("発送した納品は取り消せません。");
    await client.query(`UPDATE core.fba_shipments SET status = 'cancelled' WHERE id = $1`, [shipmentId]);
    return { ok: true, message: "納品を取り消しました。" };
  });
}

/**
 * 受領数を保存する（セラーセントラルの「受領済み」を機種ごとに）。
 * 全部受領されたら、そのまま完了にする（入れた個体は「FBA 在庫」になる）。
 */
export async function recordReceipts(
  actorId: number,
  shipmentId: number,
  receipts: { skuId: number; receivedQty: number }[],
): Promise<FbaResult & { closed?: boolean }> {
  let closed = false;
  const r = await run(actorId, async (client) => {
    const s = await lockShipment(client, shipmentId);
    if (s.status !== "shipped" && s.status !== "receiving") {
      throw new Refused("受領数は、発送してから完了するまでの間だけ入れられます。");
    }
    for (const x of receipts) {
      await client.query(
        `INSERT INTO core.fba_shipment_receipts (shipment_id, sku_id, received_qty) VALUES ($1, $2, $3)
         ON CONFLICT (shipment_id, sku_id) DO UPDATE SET received_qty = EXCLUDED.received_qty`,
        [shipmentId, x.skuId, x.receivedQty],
      );
    }
    if (s.status === "shipped") {
      await client.query(`UPDATE core.fba_shipments SET status = 'receiving' WHERE id = $1`, [shipmentId]);
    }
    const units = await client.query<{ skuId: number; skuCode: string }>(
      `SELECT u.sku_id AS "skuId", k.code AS "skuCode"
         FROM core.fba_shipment_units su JOIN core.units u ON u.id = su.unit_id JOIN core.skus k ON k.id = u.sku_id
        WHERE su.shipment_id = $1`,
      [shipmentId],
    );
    const rec = await client.query<{ skuId: number; receivedQty: number }>(
      `SELECT sku_id AS "skuId", received_qty AS "receivedQty" FROM core.fba_shipment_receipts WHERE shipment_id = $1`,
      [shipmentId],
    );
    const sum = summarizeBySku(units.rows, rec.rows);
    if (sum.allReceived) {
      await client.query(`UPDATE core.fba_shipments SET status = 'closed', closed_at = now() WHERE id = $1`, [shipmentId]);
      closed = true;
      return { ok: true, message: `全部（${sum.sent}台）受領されたので、完了にしました。個体は「FBA 在庫」になりました。` };
    }
    return { ok: true, message: `受領数を保存しました（${sum.received} / ${sum.sent}台）。` };
  });
  return { ...r, closed };
}
