"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/auth/google";
import { requireManager } from "@/lib/auth/session";
import { parseAmazonInput, parseSkuInput, parseSlotInput } from "@/lib/sku-calc";
import {
  addOption,
  addSlot,
  createSku,
  removeOption,
  removeSlot,
  setAmazonListings,
  setSlotQty,
  setSlotRequired,
  updateSku,
  type SkuResult,
} from "@/lib/skus";

// 機種と構成表の操作。最初に requireManager で「代表・工場長がログインしているか」を確かめる。

export type SkuState = { ok: boolean; message: string; at: number } | null;

const n = (formData: FormData, key: string) => Number(formData.get(key));
const back = (formData: FormData) => safeNext(formData.get("back"), "/settings/skus");

async function done(r: SkuResult): Promise<SkuState> {
  if (r.ok) refresh();
  return { ok: r.ok, message: r.message, at: Date.now() };
}

/** 機種を作る */
export async function createSkuAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager("/settings/skus/new");
  const parsed = parseSkuInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  const copy = n(formData, "copyFrom");
  const r = await createSku(viewer.user.id, parsed.value, Number.isSafeInteger(copy) && copy > 0 ? copy : null);
  if (!r.ok) return { ok: false, message: r.message, at: Date.now() };
  redirect(`/settings/skus/${r.id}?created=1`);
}

/** 名前・定価・使うかどうかを直す */
export async function updateSkuAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  const parsed = parseSkuInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  return done(await updateSku(viewer.user.id, n(formData, "skuId"), parsed.value));
}

/** 枠を足す */
export async function addSlotAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  const parsed = parseSlotInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  return done(await addSlot(viewer.user.id, n(formData, "skuId"), parsed.value));
}

/** 枠の数を変える */
export async function slotQtyAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  const qty = Number(String(formData.get("qty") ?? "").normalize("NFKC"));
  return done(await setSlotQty(viewer.user.id, n(formData, "slotId"), qty));
}

/** 枠を消す */
export async function removeSlotAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  return done(await removeSlot(viewer.user.id, n(formData, "slotId")));
}

/** 枠に使ってよい型番を足す */
export async function addOptionAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  return done(await addOption(viewer.user.id, n(formData, "slotId"), n(formData, "partModelId")));
}

/** 枠の使ってよい型番から外す */
export async function removeOptionAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  return done(await removeOption(viewer.user.id, n(formData, "slotId"), n(formData, "partModelId")));
}

/** 枠を「必ず付ける」か「付けなくてもよい」にする */
export async function slotRequiredAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  return done(await setSlotRequired(viewer.user.id, n(formData, "slotId"), formData.get("required") === "1"));
}

/** Amazon の出荷方法と出品（セラー SKU・ASIN）を保存する */
export async function amazonListingsAction(_prev: SkuState, formData: FormData): Promise<SkuState> {
  const viewer = await requireManager(back(formData));
  const parsed = parseAmazonInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  return done(await setAmazonListings(viewer.user.id, n(formData, "skuId"), parsed.value));
}
