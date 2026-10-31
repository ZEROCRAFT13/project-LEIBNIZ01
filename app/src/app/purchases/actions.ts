"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requirePurchaser } from "@/lib/auth/session";
import { todayJst } from "@/lib/format";
import { parsePurchaseInput } from "@/lib/purchase-calc";
import { PurchaseError, cancelReceipt, createPurchase, receiveBulk, receiveSerial } from "@/lib/purchasing";

// 仕入れと入荷の操作。どれも最初に requirePurchaser で「代表・工場長がログインしているか」を確かめる。

export type CreateState = { errors: string[]; existingId?: number; at: number } | null;
export type ReceiveState = { ok: boolean; message: string; at: number } | null;

function parseLines(raw: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(raw ?? "[]"));
  } catch {
    return [];
  }
}

/** 仕入れを登録する */
export async function createPurchaseAction(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const viewer = await requirePurchaser("/purchases/new");
  const parsed = parsePurchaseInput(
    {
      supplierId: formData.get("supplierId"),
      orderNo: formData.get("orderNo"),
      orderedOn: formData.get("orderedOn"),
      paymentMethod: formData.get("paymentMethod"),
      tax: formData.get("tax"),
      lines: parseLines(formData.get("lines")),
    },
    todayJst(),
  );
  if (!parsed.ok) return { errors: parsed.errors, at: Date.now() };

  let id: number;
  try {
    id = await createPurchase(viewer.user.id, parsed.value);
  } catch (error) {
    if (error instanceof PurchaseError) return { errors: [error.message], existingId: error.existingId, at: Date.now() };
    throw error;
  }
  redirect(`/purchases/${id}?new=1`);
}

function purchasePath(formData: FormData): string {
  const id = Number(formData.get("purchaseId"));
  return Number.isSafeInteger(id) && id > 0 ? `/purchases/${id}` : "/purchases";
}

/** シリアルを読んで1個入荷する */
export async function receiveSerialAction(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  const viewer = await requirePurchaser(purchasePath(formData));
  const r = await receiveSerial(
    viewer.user.id,
    Number(formData.get("lineId")),
    String(formData.get("serial") ?? ""),
    String(formData.get("box") ?? ""),
  );
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** シリアルのない部品を数でまとめて入荷する */
export async function receiveBulkAction(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  const viewer = await requirePurchaser(purchasePath(formData));
  const qty = Number(String(formData.get("qty") ?? "").normalize("NFKC"));
  const r = await receiveBulk(viewer.user.id, Number(formData.get("lineId")), qty, String(formData.get("box") ?? ""));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 読み間違えた入荷を取り消す */
export async function cancelReceiptAction(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  const viewer = await requirePurchaser(purchasePath(formData));
  const r = await cancelReceipt(viewer.user.id, Number(formData.get("itemId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}
