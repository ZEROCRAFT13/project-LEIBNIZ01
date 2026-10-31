"use server";

import { refresh } from "next/cache";
import { requireInspector } from "@/lib/auth/session";
import { addInspectionPhoto, recordInspection, removeInspectionPhoto } from "@/lib/inspection";

// 検品する人は、ログイン（Google、または組立端末のPIN）から決まる。画面から送られた名前は信じない。

export type InspectState = { ok: boolean; message: string; errors?: string[]; at: number } | null;

async function inspectorId(mgmtNo: string): Promise<number> {
  const viewer = await requireInspector(`/inspection/${mgmtNo}`);
  return viewer.user.id;
}

/** 写真を足す（1回に1枚） */
export async function addPhotoAction(_prev: InspectState, formData: FormData): Promise<InspectState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const id = await inspectorId(mgmtNo);
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "写真が選ばれていません。", at: Date.now() };
  const r = await addInspectionPhoto(
    id,
    mgmtNo,
    String(formData.get("stage") ?? ""),
    String(formData.get("kind") ?? ""),
    new Uint8Array(await file.arrayBuffer()),
  );
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 撮り間違えた写真を取り消す */
export async function removePhotoAction(_prev: InspectState, formData: FormData): Promise<InspectState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const r = await removeInspectionPhoto(await inspectorId(mgmtNo), mgmtNo, Number(formData.get("photoId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 段階の結果を記録する */
export async function recordAction(_prev: InspectState, formData: FormData): Promise<InspectState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const id = await inspectorId(mgmtNo);
  const str = (k: string) => String(formData.get(k) ?? "");
  const r = await recordInspection(id, mgmtNo, str("stage"), {
    result: str("result"),
    checks: Array.from({ length: 50 }, (_, i) => str(`c${i}`)),
    stressTestMinutes: str("stressTestMinutes"),
    maxCpuTempC: str("maxCpuTempC"),
    maxGpuTempC: str("maxGpuTempC"),
    noiseDb: str("noiseDb"),
    benchNames: formData.getAll("benchName").map(String),
    benchScores: formData.getAll("benchScore").map(String),
    warningReason: str("warningReason"),
    note: str("note"),
    nextAction: str("nextAction"),
  });
  if (r.ok) refresh();
  return { ok: r.ok, message: r.message, errors: r.ok ? undefined : r.errors, at: Date.now() };
}
