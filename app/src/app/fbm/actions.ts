"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireManager } from "@/lib/auth/session";
import { FBA_CARRIERS, type FbaCarrier } from "@/lib/fba-calc";
import {
  cancelFbmOrder,
  createFbmOrder,
  linkUnit,
  markFbmShipped,
  markShipNotified,
  setOrderTracking,
  unlinkUnit,
  updateFbmOrderInfo,
  type FbmResult,
} from "@/lib/fbm";
import { parseFbmOrderInput } from "@/lib/fbm-calc";

// 自社出荷の操作。最初に requireManager で「代表・工場長がログインしているか」を確かめる。
// ここから Amazon には何も送らない（出荷通知はセラーセントラルで人が行い、その記録だけ残す）。

export type FbmState = { ok: boolean; message: string; at: number } | null;

const idOf = (formData: FormData) => Number(formData.get("orderId"));
const str = (formData: FormData, k: string) => String(formData.get(k) ?? "");

async function actor(formData: FormData): Promise<number> {
  const id = idOf(formData);
  const viewer = await requireManager(Number.isSafeInteger(id) && id > 0 ? `/fbm/${id}` : "/fbm");
  return viewer.user.id;
}

function done(r: FbmResult): FbmState {
  if (r.ok) refresh();
  return { ok: r.ok, message: r.message, at: Date.now() };
}

/** 注文を登録して開く */
export async function createOrderAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  const viewer = await requireManager("/fbm");
  const parsed = parseFbmOrderInput(Object.fromEntries(formData), new Date());
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  const r = await createFbmOrder(viewer.user.id, parsed.value);
  if (!r.ok || !("id" in r) || !r.id) return { ok: false, message: r.message, at: Date.now() };
  redirect(`/fbm/${r.id}`);
}

export async function linkUnitAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await linkUnit(await actor(formData), idOf(formData), str(formData, "code")));
}

export async function unlinkUnitAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await unlinkUnit(await actor(formData), idOf(formData), str(formData, "mgmtNo")));
}

export async function trackingAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await setOrderTracking(await actor(formData), idOf(formData), str(formData, "mgmtNo"), str(formData, "trackingNo")));
}

export async function infoAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  const id = await actor(formData);
  const c = str(formData, "carrier");
  const carrier = (FBA_CARRIERS as readonly string[]).includes(c) ? (c as FbaCarrier) : null;
  const note = str(formData, "note").normalize("NFC").trim();
  if (note.length > 500) return { ok: false, message: "メモは500文字までにしてください。", at: Date.now() };
  return done(await updateFbmOrderInfo(id, idOf(formData), { carrier, note: note || null }));
}

export async function shipAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await markFbmShipped(await actor(formData), idOf(formData)));
}

export async function notifiedAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await markShipNotified(await actor(formData), idOf(formData), str(formData, "delayReason") || null));
}

export async function cancelAction(_prev: FbmState, formData: FormData): Promise<FbmState> {
  return done(await cancelFbmOrder(await actor(formData), idOf(formData), str(formData, "reason")));
}
