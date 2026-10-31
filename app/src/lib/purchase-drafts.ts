import "server-only";
import { DatabaseError } from "pg";
import { query, withActor } from "@/lib/db";
import { itemKey, parseOrderMail, splitLineTotal, type ParsedLine } from "@/lib/order-mail";
import { PAYMENT_METHODS, splitTax10, type LineInput, type PaymentMethod } from "@/lib/purchase-calc";
import { PurchaseError, duplicatePurchaseError, insertPurchase } from "@/lib/purchasing";

// 仕入れの下書き。注文確認メールを読んで作り、人が確かめて「確定」すると仕入れになる。
// メールの本文は保存しない（宛名・住所が入っているため）。読み取った項目だけを残す。
// actorId は、呼ぶ側（app/purchases/drafts/actions.ts）が requirePurchaser でログインから決めたものを渡す。

export type DraftLine = ParsedLine & { itemKey: string };

export type DraftResult =
  | { ok: true; id: number }
  | { ok: false; message: string; existingDraftId?: number; existingPurchaseId?: number };

/** 貼り付けたメールの本文から下書きを作る */
export async function createDraftFromMail(
  actorId: number,
  text: string,
  source: { kind: "paste" } | { kind: "email"; ref: string } = { kind: "paste" },
): Promise<DraftResult> {
  if (text.trim() === "") return { ok: false, message: "メールの本文を貼り付けてください。" };
  if (text.length > 200_000) return { ok: false, message: "本文が長すぎます。注文の部分だけを貼り付けてください。" };
  const parsed = parseOrderMail(text);
  if (!parsed) {
    return { ok: false, message: "対応しているショップのメールではないようです（今はドスパラの「ご注文確定のお知らせ」に対応）。" };
  }

  const [supplier] = await query<{ id: number }>(`SELECT id FROM core.suppliers WHERE name = $1`, [parsed.supplierName]);
  const issues = [...parsed.issues];
  if (!supplier) issues.push(`仕入先「${parsed.supplierName}」が登録されていません。確定の前に仕入先を選んでください。`);

  if (supplier && parsed.orderNo) {
    const [dup] = await query<{ id: number }>(
      `SELECT id FROM core.purchases WHERE supplier_id = $1 AND supplier_order_no = $2`,
      [supplier.id, parsed.orderNo],
    );
    if (dup) {
      return { ok: false, message: "この注文は、もう仕入れとして登録されています。", existingPurchaseId: dup.id };
    }
  }

  const lines: DraftLine[] = parsed.lines.map((l) => ({ ...l, itemKey: itemKey(l.description) }));
  try {
    const id = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const r = await client.query<{ id: number }>(
        `INSERT INTO core.purchase_drafts (source, source_ref, parser, supplier_id, supplier_order_no, ordered_on,
                                           payment_method, total_amount, lines, issues, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          source.kind,
          source.kind === "email" ? source.ref : null,
          parsed.parser,
          supplier?.id ?? null,
          parsed.orderNo,
          parsed.orderedOn,
          parsed.paymentMethod,
          parsed.total,
          JSON.stringify(lines),
          issues,
          actorId,
        ],
      );
      return r.rows[0].id;
    });
    return { ok: true, id };
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      const [d] = await query<{ id: number }>(
        `SELECT id FROM core.purchase_drafts
          WHERE status <> 'discarded' AND ((parser = $1 AND supplier_order_no = $2) OR source_ref = $3)`,
        [parsed.parser, parsed.orderNo, source.kind === "email" ? source.ref : null],
      );
      return { ok: false, message: "この注文の下書きは、もうあります。", existingDraftId: d?.id };
    }
    throw error;
  }
}

export type DraftRow = {
  id: number;
  parser: string;
  supplier: string | null;
  orderNo: string | null;
  orderedOn: string | null;
  total: number | null;
  issues: string[];
  lineCount: number;
  createdAt: Date;
};

export async function listOpenDrafts(): Promise<DraftRow[]> {
  return query<DraftRow>(
    `SELECT d.id, d.parser, s.name AS supplier, d.supplier_order_no AS "orderNo", d.ordered_on AS "orderedOn",
            d.total_amount AS total, d.issues, jsonb_array_length(d.lines) AS "lineCount", d.created_at AS "createdAt"
       FROM core.purchase_drafts d LEFT JOIN core.suppliers s ON s.id = d.supplier_id
      WHERE d.status = 'open'
      ORDER BY d.created_at DESC`,
  );
}

export async function countOpenDrafts(): Promise<number> {
  const [r] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM core.purchase_drafts WHERE status = 'open'`);
  return r.n;
}

export type DraftView = {
  id: number;
  parser: string;
  supplierId: number | null;
  orderNo: string | null;
  orderedOn: string | null;
  paymentMethod: PaymentMethod | null;
  total: number | null;
  issues: string[];
  status: string;
  purchaseId: number | null;
  lines: (DraftLine & { suggestedModelId: number | null })[];
};

/** 下書きと、覚えている対応から当てた型番 */
export async function getDraft(id: number): Promise<DraftView | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [d] = await query<Omit<DraftView, "lines"> & { lines: DraftLine[] }>(
    `SELECT id, parser, supplier_id AS "supplierId", supplier_order_no AS "orderNo", ordered_on AS "orderedOn",
            payment_method AS "paymentMethod", total_amount AS total, issues, status, purchase_id AS "purchaseId", lines
       FROM core.purchase_drafts WHERE id = $1`,
    [id],
  );
  if (!d) return null;
  const aliases = d.supplierId
    ? await query<{ itemKey: string; partModelId: number }>(
        `SELECT a.item_key AS "itemKey", a.part_model_id AS "partModelId"
           FROM core.supplier_item_aliases a JOIN core.part_models m ON m.id = a.part_model_id AND m.active
          WHERE a.supplier_id = $1 AND a.item_key = ANY($2)`,
        [d.supplierId, d.lines.map((l) => l.itemKey)],
      )
    : [];
  const byKey = new Map(aliases.map((a) => [a.itemKey, a.partModelId]));
  return {
    ...d,
    lines: d.lines.map((l) => ({ ...l, suggestedModelId: l.kind === "item" ? (byKey.get(l.itemKey) ?? null) : null })),
  };
}

/** 確定のときの、明細ごとの選択（部品の型番、または部品以外） */
export type LineChoice = { partModelId: number } | { other: true };

export type ConfirmInput = {
  supplierId: number;
  orderedOn: string;
  paymentMethod: string;
  choices: LineChoice[];
};

export type ConfirmResult = { ok: true; purchaseId: number } | { ok: false; message: string; existingPurchaseId?: number };

/**
 * 下書きを確定して仕入れにする。選んだ型番は「ショップの商品名 → 型番」として覚える。
 * 明細の合計がメールの合計と合わないときは確定しない（手で登録してもらう）。
 */
export async function confirmDraft(actorId: number, draftId: number, input: ConfirmInput): Promise<ConfirmResult> {
  const draft = await getDraft(draftId);
  if (!draft || draft.status !== "open") return { ok: false, message: "この下書きは、もう確定したか捨てられています。" };
  if (!draft.orderNo) return { ok: false, message: "注文番号のない下書きは確定できません。手で登録してください。" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.orderedOn)) return { ok: false, message: "注文日を入れてください。" };
  const paymentMethod = PAYMENT_METHODS.find((m) => m === input.paymentMethod);
  if (!paymentMethod) return { ok: false, message: "支払い方法を選んでください。" };
  if (input.choices.length !== draft.lines.length) return { ok: false, message: "明細ごとに部品を選んでください。" };

  const lines: LineInput[] = [];
  for (const [i, line] of draft.lines.entries()) {
    const choice = input.choices[i];
    if (!("other" in choice) && !(Number.isSafeInteger(choice.partModelId) && choice.partModelId > 0)) {
      return { ok: false, message: `${i + 1}行目：部品を選んでください。` };
    }
    const partModelId = "other" in choice ? null : choice.partModelId;
    // 単価×数量が金額と合えばそのまま。合わなければ（金額だけのメール）、合計が合うように分ける
    const parts =
      line.unitPrice !== null && line.unitPrice * line.qty === line.lineTotal
        ? [{ qty: line.qty, unitPrice: line.unitPrice }]
        : splitLineTotal(line.lineTotal, line.qty);
    for (const p of parts) {
      lines.push({ partModelId, description: line.description.slice(0, 100), qty: p.qty, unitPrice: p.unitPrice });
    }
  }
  if (!lines.some((l) => l.partModelId !== null)) return { ok: false, message: "部品の明細が1行もありません。" };

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  if (draft.total !== null && total !== draft.total) {
    return {
      ok: false,
      message: `明細の合計（${total.toLocaleString()}円）がメールの合計（${draft.total.toLocaleString()}円）と合わないので、確定できません。「仕入れを登録」から手で登録してください。`,
    };
  }

  const purchase = {
    supplierId: input.supplierId,
    orderNo: draft.orderNo,
    orderedOn: input.orderedOn,
    paymentMethod,
    lines,
    total,
    tax: splitTax10(total).tax,
  };
  try {
    const purchaseId = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const locked = await client.query(`SELECT 1 FROM core.purchase_drafts WHERE id = $1 AND status = 'open' FOR UPDATE`, [
        draftId,
      ]);
      if (locked.rowCount !== 1) throw new PurchaseError("この下書きは、もう確定したか捨てられています。");
      const id = await insertPurchase(client, purchase);
      await client.query(`UPDATE core.purchase_drafts SET status = 'confirmed', purchase_id = $2 WHERE id = $1`, [
        draftId,
        id,
      ]);
      // ショップの商品名と型番の対応を覚える（次の下書きで自動で当てる）
      for (const [i, line] of draft.lines.entries()) {
        const choice = input.choices[i];
        if (line.kind !== "item" || "other" in choice) continue;
        await client.query(
          `INSERT INTO core.supplier_item_aliases (supplier_id, item_key, part_model_id, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (supplier_id, item_key) DO UPDATE SET part_model_id = EXCLUDED.part_model_id
           WHERE supplier_item_aliases.part_model_id <> EXCLUDED.part_model_id`,
          [input.supplierId, line.itemKey, choice.partModelId, actorId],
        );
      }
      return id;
    });
    return { ok: true, purchaseId };
  } catch (error) {
    if (error instanceof PurchaseError) return { ok: false, message: error.message, existingPurchaseId: error.existingId };
    const dup = await duplicatePurchaseError(error, purchase);
    if (dup) return { ok: false, message: dup.message, existingPurchaseId: dup.existingId };
    throw error;
  }
}

/** 下書きを捨てる（間違って作った・キャンセルした注文） */
export async function discardDraft(actorId: number, draftId: number): Promise<boolean> {
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query(`UPDATE core.purchase_drafts SET status = 'discarded' WHERE id = $1 AND status = 'open'`, [draftId]),
  );
  return r.rowCount === 1;
}
