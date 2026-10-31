import "server-only";
import { cookies } from "next/headers";
import { getWorker, type Worker } from "@/lib/assembly";

// 組立画面で「誰が作業しているか」を覚えておく仕組み。
// ※ ログイン機能ができるまでの仮のもの。名前を選ぶだけなので本番では使わない（ログインに置き換える）。

const COOKIE = "zb_worker";

export async function getCurrentWorker(): Promise<Worker | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  const id = Number(value);
  if (!value || !Number.isInteger(id)) return null;
  return getWorker(id);
}

export async function setCurrentWorker(id: number): Promise<void> {
  (await cookies()).set(COOKIE, String(id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12, // 12時間（1日の作業が終われば選び直す）
  });
}

export async function clearCurrentWorker(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
