"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireManager } from "@/lib/auth/session";
import {
  addUnitToShipment,
  cancelShipment,
  createFbaShipment,
  getFbaShipment,
  markShipped,
  recordReceipts,
  removeUnitFromShipment,
  setUnitTracking,
  updateShipmentInfo,
  type FbaResult,
} from "@/lib/fba";
import { parseReceipts, parseShipmentInfo } from "@/lib/fba-calc";

// FBA 納品の操作。最初に requireManager で「代表・工場長がログインしているか」を確かめる。
// ここでは Amazon には何も送らない（セラーセントラルで作った納品を記録するだけ）。

export type FbaState = { ok: boolean; message: string; at: number } | null;

const idOf = (formData: FormData) => Number(formData.get("shipmentId"));

async function actor(formData: FormData): Promise<number> {
  const id = idOf(formData);
  const viewer = await requireManager(Number.isSafeInteger(id) && id > 0 ? `/fba/${id}` : "/fba");
  return viewer.user.id;
}

function done(r: FbaResult): FbaState {
  if (r.ok) refresh();
  return { ok: r.ok, message: r.message, at: Date.now() };
}

/** 新しい納品（下書き）を作って開く */
export async function createShipmentAction(): Promise<void> {
  const viewer = await requireManager("/fba");
  const id = await createFbaShipment(viewer.user.id);
  redirect(`/fba/${id}`);
}

export async function addUnitAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  return done(await addUnitToShipment(await actor(formData), idOf(formData), String(formData.get("code") ?? "")));
}

export async function removeUnitAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  return done(await removeUnitFromShipment(await actor(formData), idOf(formData), String(formData.get("mgmtNo") ?? "")));
}

export async function infoAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  const id = await actor(formData);
  const parsed = parseShipmentInfo(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  return done(await updateShipmentInfo(id, idOf(formData), parsed.value));
}

export async function trackingAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  return done(
    await setUnitTracking(
      await actor(formData),
      idOf(formData),
      String(formData.get("mgmtNo") ?? ""),
      String(formData.get("trackingNo") ?? ""),
    ),
  );
}

export async function shipAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  return done(await markShipped(await actor(formData), idOf(formData)));
}

export async function cancelAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  return done(await cancelShipment(await actor(formData), idOf(formData)));
}

export async function receiptsAction(_prev: FbaState, formData: FormData): Promise<FbaState> {
  const id = await actor(formData);
  const shipment = await getFbaShipment(idOf(formData));
  if (!shipment) return { ok: false, message: "納品が見つかりません。", at: Date.now() };
  const parsed = parseReceipts(Object.fromEntries(formData), shipment.bySku);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  return done(await recordReceipts(id, shipment.id, parsed.value));
}
