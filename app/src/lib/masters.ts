import "server-only";
import { DatabaseError } from "pg";
import { query, withActor } from "@/lib/db";
import type { PartModelInput, SupplierInput } from "@/lib/master-calc";

// 部品の型番と仕入先の登録・変更。消さずに「使わない」にする（過去の仕入れ・個体の記録が指しているため）。
// actorId は、呼ぶ側（app/settings/actions など）が require〜 でログインから決めたものを渡す。

export type MasterResult = { ok: true; id: number; message: string } | { ok: false; message: string };

// ---------------------------------------------------------------------
// 部品の型番
// ---------------------------------------------------------------------

export type PartModelRow = {
  id: number;
  category: string;
  maker: string;
  modelNo: string;
  name: string;
  janCode: string | null;
  serialRequired: boolean;
  keepBox: boolean;
  makerWarrantyMonths: number | null;
  active: boolean;
  inStock: number;
  skuCount: number;
};

const PART_COLUMNS = `p.id, p.category, p.maker, p.model_no AS "modelNo", p.name, p.jan_code AS "janCode",
  p.serial_required AS "serialRequired", p.keep_box AS "keepBox", p.maker_warranty_months AS "makerWarrantyMonths", p.active,
  (SELECT count(*) FROM core.part_items i WHERE i.part_model_id = p.id AND i.status = 'in_stock')::int AS "inStock",
  (SELECT count(DISTINCT s.sku_id) FROM core.sku_slot_options o JOIN core.sku_slots s ON s.id = o.slot_id
    WHERE o.part_model_id = p.id)::int AS "skuCount"`;

/** すべての型番（使わないものも）。q があれば型番・名前・メーカー・JANで絞る */
export async function listAllPartModels(q = ""): Promise<PartModelRow[]> {
  const like = `%${q
    .normalize("NFKC")
    .trim()
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return query<PartModelRow>(
    `SELECT ${PART_COLUMNS}
       FROM core.part_models p
      WHERE $1 = '%%' OR p.model_no ILIKE $1 OR p.name ILIKE $1 OR p.maker ILIKE $1 OR p.jan_code ILIKE $1
      ORDER BY p.active DESC,
               array_position(ARRAY['cpu','gpu','motherboard','memory','ssd','psu','cooler','case','fan','os','other'], p.category),
               p.maker, p.model_no`,
    [like],
  );
}

export async function getPartModel(id: number): Promise<PartModelRow | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [r] = await query<PartModelRow>(`SELECT ${PART_COLUMNS} FROM core.part_models p WHERE p.id = $1`, [id]);
  return r ?? null;
}

function partDuplicate(error: unknown): string | null {
  if (!(error instanceof DatabaseError) || error.code !== "23505") return null;
  if (error.constraint === "part_models_jan_uq") return "このJANコードは、ほかの型番に登録されています。";
  return "同じメーカー・同じ型番が、もう登録されています。";
}

export async function createPartModel(actorId: number, input: PartModelInput): Promise<MasterResult> {
  try {
    const id = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const r = await client.query<{ id: number }>(
        `INSERT INTO core.part_models (category, maker, model_no, name, jan_code, serial_required, keep_box,
                                       maker_warranty_months, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          input.category,
          input.maker,
          input.modelNo,
          input.name,
          input.janCode,
          input.serialRequired,
          input.keepBox,
          input.makerWarrantyMonths,
          input.active,
        ],
      );
      return r.rows[0].id;
    });
    return { ok: true, id, message: `${input.name}（${input.modelNo}）を追加しました。` };
  } catch (error) {
    const message = partDuplicate(error);
    if (message) return { ok: false, message };
    throw error;
  }
}

export async function updatePartModel(actorId: number, id: number, input: PartModelInput): Promise<MasterResult> {
  try {
    const r = await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(
        `UPDATE core.part_models
            SET category = $2, maker = $3, model_no = $4, name = $5, jan_code = $6, serial_required = $7,
                keep_box = $8, maker_warranty_months = $9, active = $10
          WHERE id = $1`,
        [
          id,
          input.category,
          input.maker,
          input.modelNo,
          input.name,
          input.janCode,
          input.serialRequired,
          input.keepBox,
          input.makerWarrantyMonths,
          input.active,
        ],
      ),
    );
    if (r.rowCount !== 1) return { ok: false, message: "その型番はありません。" };
    return { ok: true, id, message: "保存しました。" };
  } catch (error) {
    const message = partDuplicate(error);
    if (message) return { ok: false, message };
    throw error;
  }
}

// ---------------------------------------------------------------------
// 仕入先
// ---------------------------------------------------------------------

export type SupplierRow = {
  id: number;
  name: string;
  kind: string;
  invoiceRegNo: string | null;
  website: string | null;
  rmaContact: string | null;
  notes: string | null;
  purchaseCount: number;
};

const SUPPLIER_COLUMNS = `s.id, s.name, s.kind, s.invoice_reg_no AS "invoiceRegNo", s.website, s.rma_contact AS "rmaContact",
  s.notes, (SELECT count(*) FROM core.purchases p WHERE p.supplier_id = s.id)::int AS "purchaseCount"`;

export async function listAllSuppliers(): Promise<SupplierRow[]> {
  return query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM core.suppliers s ORDER BY s.kind, s.name`);
}

export async function getSupplier(id: number): Promise<SupplierRow | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [r] = await query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM core.suppliers s WHERE s.id = $1`, [id]);
  return r ?? null;
}

function supplierDuplicate(error: unknown): string | null {
  return error instanceof DatabaseError && error.code === "23505" ? "同じ名前の仕入先が、もう登録されています。" : null;
}

export async function createSupplier(actorId: number, input: SupplierInput): Promise<MasterResult> {
  try {
    const id = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const r = await client.query<{ id: number }>(
        `INSERT INTO core.suppliers (name, kind, invoice_reg_no, website, rma_contact, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.name, input.kind, input.invoiceRegNo, input.website, input.rmaContact, input.notes],
      );
      return r.rows[0].id;
    });
    return { ok: true, id, message: `${input.name} を追加しました。` };
  } catch (error) {
    const message = supplierDuplicate(error);
    if (message) return { ok: false, message };
    throw error;
  }
}

export async function updateSupplier(actorId: number, id: number, input: SupplierInput): Promise<MasterResult> {
  try {
    const r = await withActor({ kind: "user", userId: actorId }, (client) =>
      client.query(
        `UPDATE core.suppliers
            SET name = $2, kind = $3, invoice_reg_no = $4, website = $5, rma_contact = $6, notes = $7
          WHERE id = $1`,
        [id, input.name, input.kind, input.invoiceRegNo, input.website, input.rmaContact, input.notes],
      ),
    );
    if (r.rowCount !== 1) return { ok: false, message: "その仕入先はありません。" };
    return { ok: true, id, message: "保存しました。" };
  } catch (error) {
    const message = supplierDuplicate(error);
    if (message) return { ok: false, message };
    throw error;
  }
}
