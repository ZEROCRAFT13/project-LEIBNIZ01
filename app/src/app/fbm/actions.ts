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
import { syncAmazonOrders } from "@/lib/amazon/order-sync";
import { createSpApi, spApiConfigFromEnv } from "@/lib/amazon/sp-api";

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

/** Amazon から今すぐ取り込む（直近7日を見直す）。読むだけで、Amazon には何も送らない */
export async function syncNowAction(): Promise<FbmState> {
  await requireManager("/fbm");
  const config = spApiConfigFromEnv();
  if (!config) return { ok: false, message: "SP-API のキーが設定されていません（app/.env.local）。", at: Date.now() };
  const r = await syncAmazonOrders(createSpApi(config), "manual");
  if (!r.ok) return { ok: false, message: `取り込めませんでした：${r.error}`, at: Date.now() };
  refresh();
  const s = r.summary;
  return {
    ok: true,
    message: `取り込みました：新しい注文 ${s.created}件、更新 ${s.updated}件（見た注文 ${s.fetched}件）${
      s.unknownListing ? `。出品が未登録で取り込めない注文 ${s.unknownListing}件は ToDo に出しました` : ""
    }`,
    at: Date.now(),
  };
}
