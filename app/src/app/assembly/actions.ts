"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  finishAssembly,
  getWorker,
  scanPart,
  startUnit,
  undoLast,
  type ScanResult,
} from "@/lib/assembly";
import { clearCurrentWorker, getCurrentWorker, setCurrentWorker } from "@/lib/worker-session";

export type ScanState = (ScanResult & { at: number }) | null;

const notSelected = { kind: "error" as const, message: "作業する人が選ばれていません。組立のトップで名前を選んでください。" };

/** 作業する人を選ぶ */
export async function selectWorkerAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("workerId"));
  if (!Number.isInteger(id) || !(await getWorker(id))) throw new Error("その人は選べません");
  await setCurrentWorker(id);
  refresh();
}

/** 作業する人を選び直す */
export async function clearWorkerAction(): Promise<void> {
  await clearCurrentWorker();
  refresh();
}

/** 新しく1台組み立て始める */
export async function startUnitAction(formData: FormData): Promise<void> {
  const worker = await getCurrentWorker();
  if (!worker) throw new Error(notSelected.message);
  const mgmtNo = await startUnit(worker.id, Number(formData.get("skuId")));
  redirect(`/assembly/${mgmtNo}?new=1`);
}

/** バーコードを読んだ（読み取り機は文字を打ってEnterを押すので、フォームの送信として届く） */
export async function scanAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const worker = await getCurrentWorker();
  if (!worker) return { ...notSelected, at: Date.now() };
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const code = String(formData.get("code") ?? "");
  const result = await scanPart(worker.id, mgmtNo, code);
  if (result.kind === "installed") refresh();
  return { ...result, at: Date.now() };
}

/** 最後に付けた部品を1つ外す */
export async function undoAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const worker = await getCurrentWorker();
  if (!worker) return { ...notSelected, at: Date.now() };
  const r = await undoLast(worker.id, String(formData.get("mgmtNo") ?? ""));
  if (r.ok) refresh();
  return r.ok
    ? { kind: "installed", slot: "", message: r.message, at: Date.now() }
    : { kind: "error", message: r.message, at: Date.now() };
}

/** 組立完了（検品待ちにする） */
export async function finishAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const worker = await getCurrentWorker();
  if (!worker) return { ...notSelected, at: Date.now() };
  const r = await finishAssembly(worker.id, String(formData.get("mgmtNo") ?? ""));
  if (r.ok) refresh();
  return r.ok
    ? { kind: "installed", slot: "", message: r.message, at: Date.now() }
    : { kind: "error", message: r.message, at: Date.now() };
}
