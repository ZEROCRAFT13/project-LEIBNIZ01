import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { safeNext } from "./google";
import { ASSEMBLY_ROLES, MANAGER_ROLES, PURCHASE_ROLES, findDevice, findViewer, type Device, type Issued, type Viewer } from "./store";

// Cookie とログインの確認。画面（Server Component）とサーバーの処理（Server Action・Route Handler）の両方から使う。
// 画面を隠すだけでは守れないので、データを読む・書く処理の直前で必ず require〜 を呼ぶ。

export const SESSION_COOKIE = "zb_session";
export const DEVICE_COOKIE = "zb_device";
export const OAUTH_COOKIE = "zb_oauth";

const secure = process.env.NODE_ENV === "production";

/** 1回の表示の中では、DBへの確認を1回にまとめる */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const jar = await cookies();
  return findViewer(jar.get(SESSION_COOKIE)?.value, jar.get(DEVICE_COOKIE)?.value);
});

export const getDevice = cache(async (): Promise<Device | null> => {
  return findDevice((await cookies()).get(DEVICE_COOKIE)?.value);
});

export async function getDeviceToken(): Promise<string | undefined> {
  return (await cookies()).get(DEVICE_COOKIE)?.value;
}

export async function setSessionCookie(issued: Issued): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, issued.token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires: issued.expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** 組立用の端末の鍵。ブラウザが許す上限の約1年残す（なくしたら設定画面で無効にする） */
export async function setDeviceCookie(token: string): Promise<void> {
  (await cookies()).set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

function loginUrl(next: string): string {
  return `/login?next=${encodeURIComponent(safeNext(next))}`;
}

export function canAssemble(viewer: Viewer): boolean {
  return viewer.roles.some((r) => ASSEMBLY_ROLES.includes(r));
}

export function canManage(viewer: Viewer): boolean {
  return viewer.kind === "user" && viewer.roles.some((r) => MANAGER_ROLES.includes(r));
}

export function canPurchase(viewer: Viewer): boolean {
  return viewer.kind === "user" && viewer.roles.some((r) => PURCHASE_ROLES.includes(r));
}

/** Google でログインした人だけ（組立端末のPINでは入れない画面） */
export async function requireUser(next: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(loginUrl(next));
  if (viewer.kind !== "user") redirect("/assembly");
  return viewer;
}

/** 組立端末とバイトのPINを管理できる人（代表・工場長） */
export async function requireManager(next: string): Promise<Viewer> {
  const viewer = await requireUser(next);
  if (!canManage(viewer)) redirect("/?denied=1");
  return viewer;
}

/** 仕入れと入荷を登録できる人（代表・工場長） */
export async function requirePurchaser(next: string): Promise<Viewer> {
  const viewer = await requireUser(next);
  if (!canPurchase(viewer)) redirect("/?denied=1");
  return viewer;
}

/** 組立をしてよい人（組立端末のPIN、または組立の役割を持つ人のGoogleログイン） */
export async function requireAssembler(next: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(loginUrl(next));
  if (!canAssemble(viewer)) redirect(viewer.kind === "worker" ? "/login?error=no_role" : "/?denied=1");
  return viewer;
}

/** 開発中だけの「開発用ログイン」を出してよいか */
export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.ZB_DEV_LOGIN === "1";
}
