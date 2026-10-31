"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requirePurchaser } from "@/lib/auth/session";
import { todayJst } from "@/lib/format";
import { parsePurchaseInput } from "@/lib/purchase-calc";
import {
  PurchaseError,
  addShipment,
  cancelReceipt,
  createPurchase,
  findArrival,
  receiveBulk,
  receiveSerial,
  removeShipment,
} from "@/lib/purchasing";

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

/** 発送（運送会社と追跡番号）を登録する */
export async function addShipmentAction(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  const viewer = await requirePurchaser(purchasePath(formData));
  const expected = String(formData.get("expectedOn") ?? "");
  const r = await addShipment(
    viewer.user.id,
    Number(formData.get("purchaseId")),
    String(formData.get("carrier") ?? ""),
    String(formData.get("trackingNo") ?? ""),
    expected === "" ? null : expected,
  );
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 間違えて登録した発送を消す */
export async function removeShipmentAction(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  const viewer = await requirePurchaser(purchasePath(formData));
  const r = await removeShipment(viewer.user.id, Number(formData.get("shipmentId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

export type ArrivalState = { message: string; purchaseIds?: number[]; at: number } | null;

/** 届いた荷物の送り状（追跡番号）か注文番号を読んで、その仕入れを開く */
export async function findArrivalAction(_prev: ArrivalState, formData: FormData): Promise<ArrivalState> {
  const viewer = await requirePurchaser("/purchases");
  const code = String(formData.get("code") ?? "");
  const r = await findArrival(viewer.user.id, code);
  if (r.kind === "shipment") redirect(`/purchases/${r.purchaseId}?arrived=${r.shipmentId}`);
  if (r.kind === "order") redirect(`/purchases/${r.purchaseId}`);
  if (r.kind === "many") {
    return { message: "同じ番号の仕入れがいくつかあります。開くものを選んでください。", purchaseIds: r.purchaseIds, at: Date.now() };
  }
  return {
    message: code.trim() === "" ? "読み取れませんでした。" : "その追跡番号・注文番号の仕入れは見つかりません。発送の登録がまだかもしれません。",
    at: Date.now(),
  };
}
