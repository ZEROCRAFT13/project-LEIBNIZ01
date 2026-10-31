import "server-only";
import { DatabaseError } from "pg";
import { normalizeCode } from "@/lib/codes";
import { query, withActor } from "@/lib/db";
import {
  CARRIERS,
  isTrackingNo,
  normalizeBoxLocation,
  normalizeTracking,
  splitTax10,
  type PurchaseInput,
} from "@/lib/purchase-calc";

// 仕入れの登録と入荷。書き込みはすべて withActor の中で行う。
// actorId は、呼ぶ側（app/purchases/actions.ts）が requirePurchaser でログインから決めたものを渡す。

export type SupplierOption = { id: number; name: string };

export async function listSuppliers(): Promise<SupplierOption[]> {
  return query<SupplierOption>(`SELECT id, name FROM core.suppliers ORDER BY id`);
}

export type PartModelOption = {
  id: number;
  category: string;
  maker: string;
  modelNo: string;
  name: string;
  serialRequired: boolean;
  keepBox: boolean;
};

export async function listPartModels(): Promise<PartModelOption[]> {
  return query<PartModelOption>(
    `SELECT id, category, maker, model_no AS "modelNo", name,
            serial_required AS "serialRequired", keep_box AS "keepBox"
       FROM core.part_models WHERE active
      ORDER BY array_position(ARRAY['cpu','gpu','motherboard','memory','ssd','psu','cooler','case','fan','os','other'], category),
               maker, model_no`,
  );
}

export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly existingId?: number,
  ) {
    super(message);
  }
}

/** 仕入れを登録する（まだ入荷はしない）。登録した仕入れの番号を返す */
export async function createPurchase(actorId: number, input: PurchaseInput): Promise<number> {
  try {
    return await withActor({ kind: "user", userId: actorId }, async (client) => {
      const models = await client.query<{ id: number; name: string }>(
        `SELECT id, name FROM core.part_models WHERE active AND id = ANY($1)`,
        [input.lines.flatMap((l) => (l.partModelId ? [l.partModelId] : []))],
      );
      const modelName = new Map(models.rows.map((m) => [m.id, m.name]));
      const supplier = await client.query(`SELECT 1 FROM core.suppliers WHERE id = $1`, [input.supplierId]);
      if (supplier.rowCount !== 1) throw new PurchaseError("その仕入先はありません。");

      const p = await client.query<{ id: number }>(
        `INSERT INTO core.purchases (supplier_id, supplier_order_no, ordered_on, total_amount, tax_amount, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.supplierId, input.orderNo, input.orderedOn, input.total, input.tax, input.paymentMethod],
      );
      const purchaseId = p.rows[0].id;

      for (const [i, line] of input.lines.entries()) {
        if (line.partModelId !== null && !modelName.has(line.partModelId)) {
          throw new PurchaseError(`${i + 1}行目：その部品は選べません。`);
        }
        const description =
          line.description || (line.partModelId !== null ? (modelName.get(line.partModelId) ?? "") : "");
        await client.query(
          `INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [purchaseId, line.partModelId, description, line.qty, line.unitPrice, splitTax10(line.unitPrice).tax],
        );
      }
      return purchaseId;
    });
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505" && error.constraint?.startsWith("purchases_")) {
      const [dup] = await query<{ id: number }>(
        `SELECT id FROM core.purchases WHERE supplier_id = $1 AND supplier_order_no = $2`,
        [input.supplierId, input.orderNo],
      );
      throw new PurchaseError("この仕入先の同じ注文番号は、もう登録されています。", dup?.id);
    }
    throw error;
  }
}

export type PurchaseRow = {
  id: number;
  orderedOn: string;
  supplier: string;
  orderNo: string | null;
  total: number;
  status: string;
  received: number;
  expected: number;
};

/** 仕入れの一覧（新しい順）。入荷待ちを上に */
export async function listPurchases(limit = 100): Promise<PurchaseRow[]> {
  return query<PurchaseRow>(
    `SELECT p.id, p.ordered_on AS "orderedOn", s.name AS supplier, p.supplier_order_no AS "orderNo",
            p.total_amount AS total, p.status,
            (SELECT count(*) FROM core.part_items i JOIN core.purchase_lines l ON l.id = i.purchase_line_id
              WHERE l.purchase_id = p.id)::int AS received,
            (SELECT coalesce(sum(l.qty), 0) FROM core.purchase_lines l
              WHERE l.purchase_id = p.id AND l.part_model_id IS NOT NULL)::int AS expected
       FROM core.purchases p JOIN core.suppliers s ON s.id = p.supplier_id
      ORDER BY p.status IN ('ordered', 'in_transit', 'partially_received') DESC, p.ordered_on DESC, p.id DESC
      LIMIT $1`,
    [limit],
  );
}

export type ReceivedItem = {
  id: number;
  serialNo: string | null;
  boxLocation: string | null;
  status: string;
  receivedAt: Date;
};

export type PurchaseLineView = {
  id: number;
  description: string;
  qty: number;
  unitPrice: number;
  unitTax: number;
  model: (PartModelOption & { janCode: string | null }) | null;
  items: ReceivedItem[];
};

export type PurchaseView = {
  id: number;
  supplier: string;
  orderNo: string | null;
  orderedOn: string;
  total: number;
  tax: number;
  paymentMethod: string;
  status: string;
  lines: PurchaseLineView[];
  shipments: Shipment[];
};

export type Shipment = {
  id: number;
  carrier: string;
  trackingNo: string;
  expectedOn: string | null;
  deliveredAt: Date | null;
};

export async function getPurchase(id: number): Promise<PurchaseView | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [p] = await query<Omit<PurchaseView, "lines">>(
    `SELECT p.id, s.name AS supplier, p.supplier_order_no AS "orderNo", p.ordered_on AS "orderedOn",
            p.total_amount AS total, p.tax_amount AS tax, p.payment_method AS "paymentMethod", p.status
       FROM core.purchases p JOIN core.suppliers s ON s.id = p.supplier_id
      WHERE p.id = $1`,
    [id],
  );
  if (!p) return null;

  const lines = await query<Omit<PurchaseLineView, "model" | "items"> & { model: PurchaseLineView["model"] }>(
    `SELECT l.id, l.description, l.qty, l.unit_price AS "unitPrice", l.unit_tax AS "unitTax",
            CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object(
              'id', m.id, 'category', m.category, 'maker', m.maker, 'modelNo', m.model_no, 'name', m.name,
              'serialRequired', m.serial_required, 'keepBox', m.keep_box, 'janCode', m.jan_code) END AS model
       FROM core.purchase_lines l LEFT JOIN core.part_models m ON m.id = l.part_model_id
      WHERE l.purchase_id = $1
      ORDER BY l.id`,
    [id],
  );
  const items = await query<ReceivedItem & { lineId: number }>(
    `SELECT i.id, i.purchase_line_id AS "lineId", i.serial_no AS "serialNo", i.box_location AS "boxLocation",
            i.status, i.received_at AS "receivedAt"
       FROM core.part_items i JOIN core.purchase_lines l ON l.id = i.purchase_line_id
      WHERE l.purchase_id = $1
      ORDER BY i.id`,
    [id],
  );
  const shipments = await query<Shipment>(
    `SELECT id, carrier, tracking_no AS "trackingNo", expected_on AS "expectedOn", delivered_at AS "deliveredAt"
       FROM core.purchase_shipments WHERE purchase_id = $1 ORDER BY id`,
    [id],
  );
  return {
    ...p,
    shipments,
    lines: lines.map((l) => ({
      ...l,
      items: items
        .filter((i) => i.lineId === l.id)
        .map((i) => ({ id: i.id, serialNo: i.serialNo, boxLocation: i.boxLocation, status: i.status, receivedAt: i.receivedAt })),
    })),
  };
}

// ---------------------------------------------------------------------
// 入荷
// ---------------------------------------------------------------------

export type ReceiveResult = { ok: true; message: string } | { ok: false; message: string };

type LineForReceive = {
  id: number;
  partModelId: number | null;
  unitPrice: number;
  unitTax: number;
  serialRequired: boolean;
  keepBox: boolean;
  janCode: string | null;
  name: string;
};

async function lineForReceive(lineId: number): Promise<LineForReceive | null> {
  if (!Number.isSafeInteger(lineId) || lineId <= 0) return null;
  const [l] = await query<LineForReceive>(
    `SELECT l.id, l.part_model_id AS "partModelId", l.unit_price AS "unitPrice", l.unit_tax AS "unitTax",
            coalesce(m.serial_required, false) AS "serialRequired", coalesce(m.keep_box, false) AS "keepBox",
            m.jan_code AS "janCode", coalesce(m.name, l.description) AS name
       FROM core.purchase_lines l LEFT JOIN core.part_models m ON m.id = l.part_model_id
      WHERE l.id = $1`,
    [lineId],
  );
  return l ?? null;
}

function boxFor(line: LineForReceive, rawBox: string): { ok: true; box: string | null } | { ok: false; message: string } {
  if (!line.keepBox) return { ok: true, box: null };
  const box = normalizeBoxLocation(rawBox);
  if (box === "") return { ok: false, message: "この部品は元箱を保管します。箱を置く棚番（例 B-07）を入れてください。" };
  if (box.length > 20) return { ok: false, message: "棚番が長すぎます（20文字まで）。" };
  return { ok: true, box };
}

/** DBが止めた理由を、画面に出せる文にする */
function refusal(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "P0001") return error.message; // 0005_receiving のトリガーが出す日本語のメッセージ
  if (error.code === "23505" && error.constraint === "part_items_serial_uq") {
    return "このシリアルは、同じ型番でもう入荷済みです。同じ箱を2回読んでいないか確かめてください。";
  }
  return null;
}

/** シリアルのある部品を1個入荷する（箱のシリアルのバーコードを読む） */
export async function receiveSerial(
  actorId: number,
  lineId: number,
  rawSerial: string,
  rawBox: string,
): Promise<ReceiveResult> {
  const line = await lineForReceive(lineId);
  if (!line || line.partModelId === null) return { ok: false, message: "この明細には入荷できません。" };
  if (!line.serialRequired) return { ok: false, message: "この部品はシリアルを記録しません。数を入れて入荷してください。" };

  const serial = normalizeCode(rawSerial);
  if (serial === "") return { ok: false, message: "読み取れませんでした。もう一度読んでください。" };
  if (serial.length > 60) return { ok: false, message: "読み取った文字が長すぎます。別のバーコードを読んでいませんか。" };
  if (line.janCode && serial === line.janCode) {
    return { ok: false, message: "それは商品のJANコードです。箱の「S/N」「Serial」と書かれたバーコードを読んでください。" };
  }
  const box = boxFor(line, rawBox);
  if (!box.ok) return box;

  try {
    await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(
        `INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax, box_kept, box_location)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [line.partModelId, line.id, serial, line.unitPrice - line.unitTax, line.unitTax, box.box !== null, box.box],
      ),
    );
  } catch (error) {
    const message = refusal(error);
    if (message) return { ok: false, message };
    throw error;
  }
  return { ok: true, message: `${line.name}（${serial}）を入荷しました。${box.box ? `元箱は ${box.box} へ。` : ""}` };
}

/** シリアルを記録しない部品（ケースなど）を、数でまとめて入荷する */
export async function receiveBulk(actorId: number, lineId: number, qty: number, rawBox: string): Promise<ReceiveResult> {
  const line = await lineForReceive(lineId);
  if (!line || line.partModelId === null) return { ok: false, message: "この明細には入荷できません。" };
  if (line.serialRequired) return { ok: false, message: "この部品はシリアルを1個ずつ読んで入荷してください。" };
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 999) return { ok: false, message: "入荷する数を入れてください。" };
  const box = boxFor(line, rawBox);
  if (!box.ok) return box;

  try {
    await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(
        `INSERT INTO core.part_items (part_model_id, purchase_line_id, cost_excl_tax, cost_tax, box_kept, box_location)
         SELECT $1, $2, $3, $4, $5, $6 FROM generate_series(1, $7)`,
        [line.partModelId, line.id, line.unitPrice - line.unitTax, line.unitTax, box.box !== null, box.box, qty],
      ),
    );
  } catch (error) {
    const message = refusal(error);
    if (message) return { ok: false, message };
    throw error;
  }
  return { ok: true, message: `${line.name} を ${qty}個 入荷しました。` };
}

/** 読み間違えた入荷を取り消す（まだ在庫にあり、組立に使っていないものだけ） */
export async function cancelReceipt(actorId: number, itemId: number): Promise<ReceiveResult> {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return { ok: false, message: "その部品はありません。" };
  try {
    const r = await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query<{ serial_no: string | null }>(
        `DELETE FROM core.part_items
          WHERE id = $1 AND status = 'in_stock' AND purchase_line_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM core.unit_parts up WHERE up.part_item_id = part_items.id)
          RETURNING serial_no`,
        [itemId],
      ),
    );
    if (r.rowCount !== 1) return { ok: false, message: "この部品は組立などに使われたので、入荷を取り消せません。" };
    return { ok: true, message: `入荷を取り消しました${r.rows[0].serial_no ? `（${r.rows[0].serial_no}）` : ""}。` };
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503") {
      return { ok: false, message: "この部品はほかの記録（RMAなど）に使われているので、取り消せません。" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// 発送（輸送中）と、届いた荷物から仕入れを探す
// ---------------------------------------------------------------------

export type ShipmentResult = { ok: true; message: string } | { ok: false; message: string };

/** 発送のお知らせが来たら、運送会社と追跡番号を登録する（仕入れは「輸送中」になる） */
export async function addShipment(
  actorId: number,
  purchaseId: number,
  carrier: string,
  rawTrackingNo: string,
  expectedOn: string | null,
): Promise<ShipmentResult> {
  if (!CARRIERS.some((c) => c === carrier)) return { ok: false, message: "運送会社を選んでください。" };
  const trackingNo = normalizeTracking(rawTrackingNo);
  if (!isTrackingNo(trackingNo)) return { ok: false, message: "追跡番号を確かめてください（数字と英字で6〜30文字）。" };
  if (expectedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expectedOn)) {
    return { ok: false, message: "到着予定日を正しく入れてください。" };
  }
  try {
    const r = await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(
        `INSERT INTO core.purchase_shipments (purchase_id, carrier, tracking_no, expected_on)
         SELECT id, $2, $3, $4 FROM core.purchases WHERE id = $1 AND status <> 'cancelled'`,
        [purchaseId, carrier, trackingNo, expectedOn],
      ),
    );
    if (r.rowCount !== 1) return { ok: false, message: "この仕入れには発送を登録できません。" };
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      return { ok: false, message: `追跡番号 ${trackingNo} は、もう登録されています。` };
    }
    throw error;
  }
  return { ok: true, message: `追跡番号 ${trackingNo} を登録しました。` };
}

/** 間違えて登録した発送を消す */
export async function removeShipment(actorId: number, shipmentId: number): Promise<ShipmentResult> {
  if (!Number.isSafeInteger(shipmentId) || shipmentId <= 0) return { ok: false, message: "その発送はありません。" };
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query<{ tracking_no: string }>(
      `DELETE FROM core.purchase_shipments WHERE id = $1 RETURNING tracking_no`,
      [shipmentId],
    ),
  );
  if (r.rowCount !== 1) return { ok: false, message: "その発送はありません。" };
  return { ok: true, message: `追跡番号 ${r.rows[0].tracking_no} の登録を消しました。` };
}

export type ArrivalLookup =
  | { kind: "shipment"; purchaseId: number; shipmentId: number }
  | { kind: "order"; purchaseId: number }
  | { kind: "many"; purchaseIds: number[] }
  | { kind: "none" };

/**
 * 届いた荷物の送り状のバーコード（追跡番号）か、仕入先の注文番号から仕入れを探す。
 * 追跡番号で見つかったら、その荷物を「届いた」にする。
 */
export async function findArrival(actorId: number, raw: string): Promise<ArrivalLookup> {
  const tracking = normalizeTracking(raw);
  if (isTrackingNo(tracking)) {
    const hits = await query<{ id: number; purchase_id: number }>(
      `SELECT sh.id, sh.purchase_id FROM core.purchase_shipments sh
         JOIN core.purchases p ON p.id = sh.purchase_id AND p.status <> 'cancelled'
        WHERE sh.tracking_no = $1`,
      [tracking],
    );
    if (hits.length === 1) {
      await withActor({ kind: "user", userId: actorId }, (client) =>
        client.query(`UPDATE core.purchase_shipments SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL`, [
          hits[0].id,
        ]),
      );
      return { kind: "shipment", purchaseId: hits[0].purchase_id, shipmentId: hits[0].id };
    }
    if (hits.length > 1) return { kind: "many", purchaseIds: [...new Set(hits.map((h) => h.purchase_id))] };
  }

  const orderNo = raw.normalize("NFKC").trim();
  if (orderNo === "") return { kind: "none" };
  const orders = await query<{ id: number }>(
    `SELECT id FROM core.purchases
      WHERE status <> 'cancelled' AND upper(supplier_order_no) = upper($1)
      ORDER BY id DESC LIMIT 5`,
    [orderNo],
  );
  if (orders.length === 1) return { kind: "order", purchaseId: orders[0].id };
  if (orders.length > 1) return { kind: "many", purchaseIds: orders.map((o) => o.id) };
  return { kind: "none" };
}
