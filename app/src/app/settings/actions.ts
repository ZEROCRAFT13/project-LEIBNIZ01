"use server";

import { refresh } from "next/cache";
import { requireManager } from "@/lib/auth/session";
import {
  AccountError,
  EnrollError,
  addPartTimer,
  createEnrollment,
  deactivatePartTimer,
  reissueEnrollment,
  revokeDevice,
  setWorkerPin,
  unlockWorkerPin,
} from "@/lib/auth/store";

// 設定の操作。どれも最初に requireManager で「代表・工場長がGoogleでログインしているか」を確かめる。

export type CodeState =
  | { kind: "code"; name: string; code: string; expiresAt: string; at: number }
  | { kind: "error"; message: string; at: number }
  | null;

export type MessageState = { ok: boolean; message: string; at: number } | null;

function toCode(e: { name: string; code: string; expiresAt: Date }): CodeState {
  return { kind: "code", name: e.name, code: e.code, expiresAt: e.expiresAt.toISOString(), at: Date.now() };
}

function fail(error: unknown, known: (new (...a: never[]) => Error)[]): { message: string } {
  if (known.some((k) => error instanceof k)) return { message: (error as Error).message };
  throw error;
}

/** 組立用の端末を作り、登録コードを出す */
export async function createEnrollmentAction(_prev: CodeState, formData: FormData): Promise<CodeState> {
  const viewer = await requireManager("/settings/devices");
  try {
    const e = await createEnrollment(viewer.user.id, String(formData.get("name") ?? ""));
    refresh();
    return toCode(e);
  } catch (error) {
    return { kind: "error", ...fail(error, [EnrollError]), at: Date.now() };
  }
}

/** 登録コードを出し直す（期限切れのとき） */
export async function reissueEnrollmentAction(_prev: CodeState, formData: FormData): Promise<CodeState> {
  const viewer = await requireManager("/settings/devices");
  try {
    const e = await reissueEnrollment(viewer.user.id, Number(formData.get("deviceId")));
    refresh();
    return toCode(e);
  } catch (error) {
    return { kind: "error", ...fail(error, [EnrollError]), at: Date.now() };
  }
}

/** 端末を無効にする */
export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const viewer = await requireManager("/settings/devices");
  await revokeDevice(viewer.user.id, Number(formData.get("deviceId")));
  refresh();
}

/** バイトを追加する（名前だけ） */
export async function addPartTimerAction(_prev: MessageState, formData: FormData): Promise<MessageState> {
  const viewer = await requireManager("/settings/workers");
  const name = String(formData.get("name") ?? "");
  try {
    await addPartTimer(viewer.user.id, name);
    refresh();
    return { ok: true, message: `${name.trim()} さんを追加しました。続けてPINを決めてください。`, at: Date.now() };
  } catch (error) {
    return { ok: false, ...fail(error, [AccountError]), at: Date.now() };
  }
}

/** PINを決める・決め直す */
export async function setPinAction(_prev: MessageState, formData: FormData): Promise<MessageState> {
  const viewer = await requireManager("/settings/workers");
  try {
    await setWorkerPin(viewer.user.id, Number(formData.get("userId")), String(formData.get("pin") ?? ""));
    refresh();
    return { ok: true, message: "PINを設定しました。本人に口頭で伝えてください。", at: Date.now() };
  } catch (error) {
    return { ok: false, ...fail(error, [AccountError]), at: Date.now() };
  }
}

/** PINのロックを解除する */
export async function unlockPinAction(formData: FormData): Promise<void> {
  const viewer = await requireManager("/settings/workers");
  await unlockWorkerPin(viewer.user.id, Number(formData.get("userId")));
  refresh();
}

/** バイトの利用を止める */
export async function deactivatePartTimerAction(formData: FormData): Promise<void> {
  const viewer = await requireManager("/settings/workers");
  await deactivatePartTimer(viewer.user.id, Number(formData.get("userId")));
  refresh();
}
