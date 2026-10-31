"use server";

import { redirect } from "next/navigation";
import { safeNext } from "@/lib/auth/google";
import {
  clearSessionCookie,
  devLoginEnabled,
  getDeviceToken,
  getViewer,
  setDeviceCookie,
  setSessionCookie,
} from "@/lib/auth/session";
import { devLogin, enrollDevice, logout, pinLogin } from "@/lib/auth/store";

export type FormState = { message: string; at: number } | null;

/** 組立端末で名前を選び、PINを入れた */
export async function pinLoginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return { message: "名前を選んでください。", at: Date.now() };
  const r = await pinLogin(await getDeviceToken(), userId, String(formData.get("pin") ?? ""));
  if (!r.ok) return { message: r.message, at: Date.now() };
  await setSessionCookie(r.issued);
  redirect("/assembly");
}

/** 組立用の端末として登録する（代表が出した登録コードを入れる） */
export async function enrollAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const r = await enrollDevice(String(formData.get("code") ?? ""));
  if (!r.ok) return { message: r.message, at: Date.now() };
  await setDeviceCookie(r.token);
  // 代表などがこの端末でログインしたままなら切る（共用の端末に人のログインを残さない）
  const viewer = await getViewer();
  if (viewer) {
    await logout(viewer);
    await clearSessionCookie();
  }
  redirect("/login?enrolled=1");
}

/** 開発中だけ: Google の設定なしでログインする */
export async function devLoginAction(formData: FormData): Promise<void> {
  if (!devLoginEnabled()) throw new Error("開発用ログインは使えません");
  const issued = await devLogin(Number(formData.get("userId")));
  if (!issued) throw new Error("その人ではログインできません");
  await setSessionCookie(issued);
  redirect(safeNext(formData.get("next")));
}

/** ログアウト（組立端末では「作業を終える」） */
export async function logoutAction(): Promise<void> {
  const viewer = await getViewer();
  if (viewer) await logout(viewer);
  await clearSessionCookie();
  redirect("/login");
}
