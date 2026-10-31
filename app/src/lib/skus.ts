import "server-only";
import { DatabaseError, type PoolClient } from "pg";
import { query, withActor } from "@/lib/db";
import { DEFAULT_SLOTS, type SkuInput, type SlotInput } from "@/lib/sku-calc";

// 機種（SKU）と構成表（枠と、枠に使ってよい型番）。組立で読んだ部品は、この構成表と照らし合わせる。
// actorId は、呼ぶ側（app/settings/skus/actions.ts）が requireManager でログインから決めたものを渡す。

export type SkuResult = { ok: true; id: number; message: string } | { ok: false; message: string };

class SkuError extends Error {}

export type SkuRow = {
  id: number;
  code: string;
  name: string;
  listPrice: number | null;
  active: boolean;
  slotCount: number;
  emptySlots: number;
  openUnits: number;
};

const SKU_COLUMNS = `k.id, k.code, k.name, k.list_price AS "listPrice", k.active,
  (SELECT count(*) FROM core.sku_slots s WHERE s.sku_id = k.id)::int AS "slotCount",
  (SELECT count(*) FROM core.sku_slots s WHERE s.sku_id = k.id
      AND NOT EXISTS (SELECT 1 FROM core.sku_slot_options o WHERE o.slot_id = s.id))::int AS "emptySlots",
  (SELECT count(*) FROM core.units u WHERE u.sku_id = k.id AND u.status IN ('planned', 'assembling'))::int AS "openUnits"`;

export async function listSkusWithSummary(): Promise<SkuRow[]> {
  return query<SkuRow>(`SELECT ${SKU_COLUMNS} FROM core.skus k ORDER BY k.active DESC, k.code`);
}

export type SlotOption = {
  partModelId: number;
  name: string;
  maker: string;
  modelNo: string;
  active: boolean;
  inStock: number;
};

export type SlotView = { id: number; slot: string; category: string; qty: number; options: SlotOption[] };
export type SkuDetail = SkuRow & { slots: SlotView[] };

export async function getSkuDetail(id: number): Promise<SkuDetail | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [sku] = await query<SkuRow>(`SELECT ${SKU_COLUMNS} FROM core.skus k WHERE k.id = $1`, [id]);
  if (!sku) return null;
  const slots = await query<Omit<SlotView, "options">>(
    `SELECT id, slot, category, qty FROM core.sku_slots WHERE sku_id = $1 ORDER BY sort_order, id`,
    [id],
  );
  const options = await query<SlotOption & { slotId: number }>(
    `SELECT o.slot_id AS "slotId", m.id AS "partModelId", m.name, m.maker, m.model_no AS "modelNo", m.active,
            (SELECT count(*) FROM core.part_items i WHERE i.part_model_id = m.id AND i.status = 'in_stock')::int AS "inStock"
       FROM core.sku_slot_options o
       JOIN core.sku_slots s ON s.id = o.slot_id
       JOIN core.part_models m ON m.id = o.part_model_id
      WHERE s.sku_id = $1
      ORDER BY m.maker, m.model_no`,
    [id],
  );
  return {
    ...sku,
    slots: slots.map((s) => ({
      ...s,
      options: options
        .filter((o) => o.slotId === s.id)
        .map((o) => ({
          partModelId: o.partModelId,
          name: o.name,
          maker: o.maker,
          modelNo: o.modelNo,
          active: o.active,
          inStock: o.inStock,
        })),
    })),
  };
}

/** DB が止めた理由（構成表の決まり）を、画面に出せる文にする */
function refusal(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "P0001") return error.message; // 0010_sku_composition のトリガーの日本語のメッセージ
  if (error.code === "23505") {
    if (error.constraint === "skus_code_key") return "同じ機種コードが、もう登録されています。";
    if (error.constraint === "sku_slots_sku_id_slot_key") return "同じ名前の枠が、もうあります。";
    if (error.constraint === "sku_slot_options_pkey") return "その型番は、もうこの枠に入っています。";
  }
  return null;
}

async function run(actorId: number, fn: (client: PoolClient) => Promise<SkuResult>): Promise<SkuResult> {
  try {
    return await withActor({ kind: "user", userId: actorId }, fn);
  } catch (error) {
    const message = refusal(error);
    if (message) return { ok: false, message };
    throw error;
  }
}

/**
 * 機種を作る。もとにする機種を選べば、その枠と使ってよい型番をそのまま写す（似た機種を作るとき）。
 * 選ばなければ、ふつうのゲーミングPCの枠（CPU・GPU…OS）を空で作る。
 */
export async function createSku(actorId: number, input: SkuInput, copyFromId: number | null): Promise<SkuResult> {
  return run(actorId, async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO core.skus (code, name, list_price, active) VALUES ($1, $2, $3, true) RETURNING id`,
      [input.code, input.name, input.listPrice],
    );
    const id = r.rows[0].id;
    if (copyFromId) {
      const src = await client.query<{ id: number; slot: string; category: string; qty: number; sort_order: number }>(
        `SELECT id, slot, category, qty, sort_order FROM core.sku_slots WHERE sku_id = $1 ORDER BY sort_order, id`,
        [copyFromId],
      );
      if (src.rowCount === 0) throw new SkuError("もとにする機種が見つからないか、枠がありません。");
      for (const s of src.rows) {
        const n = await client.query<{ id: number }>(
          `INSERT INTO core.sku_slots (sku_id, slot, category, qty, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, s.slot, s.category, s.qty, s.sort_order],
        );
        await client.query(
          `INSERT INTO core.sku_slot_options (slot_id, part_model_id)
           SELECT $1, part_model_id FROM core.sku_slot_options WHERE slot_id = $2`,
          [n.rows[0].id, s.id],
        );
      }
    } else {
      for (const [i, s] of DEFAULT_SLOTS.entries()) {
        await client.query(
          `INSERT INTO core.sku_slots (sku_id, slot, category, qty, sort_order) VALUES ($1, $2, $3, 1, $4)`,
          [id, s.slot, s.category, i + 1],
        );
      }
    }
    return { ok: true, id, message: `${input.code} を作りました。` };
  }).catch((error) => {
    if (error instanceof SkuError) return { ok: false as const, message: error.message };
    throw error;
  });
}


/** 名前・定価・使うかどうかを直す（機種コードは変えない。Amazon の出品などとつながるため） */
export async function updateSku(actorId: number, id: number, input: SkuInput): Promise<SkuResult> {
  return run(actorId, async (client) => {
    const r = await client.query(`UPDATE core.skus SET name = $2, list_price = $3, active = $4 WHERE id = $1`, [
      id,
      input.name,
      input.listPrice,
      input.active,
    ]);
    return r.rowCount === 1 ? { ok: true, id, message: "保存しました。" } : { ok: false, message: "その機種はありません。" };
  });
}

export async function addSlot(actorId: number, skuId: number, input: SlotInput): Promise<SkuResult> {
  return run(actorId, async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO core.sku_slots (sku_id, slot, category, qty, sort_order)
       SELECT k.id, $2, $3, $4, coalesce((SELECT max(sort_order) FROM core.sku_slots WHERE sku_id = k.id), 0) + 1
         FROM core.skus k WHERE k.id = $1
       RETURNING id`,
      [skuId, input.slot, input.category, input.qty],
    );
    return r.rowCount === 1
      ? { ok: true, id: r.rows[0].id, message: `枠「${input.slot}」を足しました。` }
      : { ok: false, message: "その機種はありません。" };
  });
}

export async function setSlotQty(actorId: number, slotId: number, qty: number): Promise<SkuResult> {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 20) return { ok: false, message: "数は1〜20にしてください。" };
  return run(actorId, async (client) => {
    const r = await client.query(`UPDATE core.sku_slots SET qty = $2 WHERE id = $1`, [slotId, qty]);
    return r.rowCount === 1 ? { ok: true, id: slotId, message: "数を変えました。" } : { ok: false, message: "その枠はありません。" };
  });
}

export async function removeSlot(actorId: number, slotId: number): Promise<SkuResult> {
  return run(actorId, async (client) => {
    const r = await client.query<{ slot: string }>(`DELETE FROM core.sku_slots WHERE id = $1 RETURNING slot`, [slotId]);
    return r.rowCount === 1
      ? { ok: true, id: slotId, message: `枠「${r.rows[0].slot}」を消しました。` }
      : { ok: false, message: "その枠はありません。" };
  });
}

/** 枠に使ってよい型番を足す（同じ種類の、使っている型番だけ） */
export async function addOption(actorId: number, slotId: number, partModelId: number): Promise<SkuResult> {
  if (!Number.isSafeInteger(partModelId) || partModelId <= 0) return { ok: false, message: "型番を選んでください。" };
  return run(actorId, async (client) => {
    const r = await client.query(
      `INSERT INTO core.sku_slot_options (slot_id, part_model_id)
       SELECT $1, m.id FROM core.part_models m WHERE m.id = $2 AND m.active`,
      [slotId, partModelId],
    );
    return r.rowCount === 1 ? { ok: true, id: slotId, message: "使ってよい型番に足しました。" } : { ok: false, message: "その型番は選べません。" };
  });
}

export async function removeOption(actorId: number, slotId: number, partModelId: number): Promise<SkuResult> {
  return run(actorId, async (client) => {
    const r = await client.query(`DELETE FROM core.sku_slot_options WHERE slot_id = $1 AND part_model_id = $2`, [
      slotId,
      partModelId,
    ]);
    return r.rowCount === 1 ? { ok: true, id: slotId, message: "使ってよい型番から外しました。" } : { ok: false, message: "入っていません。" };
  });
}

/** 型番の画面用：この型番を使っている枠と、まだ入っていない同じ種類の枠 */
export async function slotsForPartModel(partModelId: number): Promise<{
  using: { slotId: number; skuId: number; skuCode: string; slot: string }[];
  available: { slotId: number; skuId: number; skuCode: string; slot: string }[];
}> {
  const rows = await query<{ slotId: number; skuId: number; skuCode: string; slot: string; used: boolean }>(
    `SELECT s.id AS "slotId", k.id AS "skuId", k.code AS "skuCode", s.slot,
            EXISTS (SELECT 1 FROM core.sku_slot_options o WHERE o.slot_id = s.id AND o.part_model_id = m.id) AS used
       FROM core.part_models m
       JOIN core.sku_slots s ON s.category = m.category
       JOIN core.skus k ON k.id = s.sku_id
      WHERE m.id = $1 AND (k.active OR EXISTS (SELECT 1 FROM core.sku_slot_options o WHERE o.slot_id = s.id AND o.part_model_id = m.id))
      ORDER BY k.code, s.sort_order`,
    [partModelId],
  );
  const pick = ({ slotId, skuId, skuCode, slot }: (typeof rows)[number]) => ({ slotId, skuId, skuCode, slot });
  return { using: rows.filter((r) => r.used).map(pick), available: rows.filter((r) => !r.used).map(pick) };
}
