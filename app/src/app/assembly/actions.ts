"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  addUnitNote,
  finishAssembly,
  removeUnitNote,
  scanPart,
  startUnit,
  undoLast,
  type ScanResult,
} from "@/lib/assembly";
import { requireAssembler } from "@/lib/auth/session";

// 作業する人は、ログイン（組立端末のPIN、または Google）から決まる。画面から送られた名前は信じない。

export type ScanState = (ScanResult & { at: number }) | null;

async function currentWorkerId(mgmtNo?: string): Promise<number> {
  const viewer = await requireAssembler(mgmtNo ? `/assembly/${mgmtNo}` : "/assembly");
  return viewer.user.id;
}

/** 新しく1台組み立て始める */
export async function startUnitAction(formData: FormData): Promise<void> {
  const workerId = await currentWorkerId();
  const mgmtNo = await startUnit(workerId, Number(formData.get("skuId")));
  redirect(`/assembly/${mgmtNo}?new=1`);
}

/** バーコードを読んだ（読み取り機は文字を打ってEnterを押すので、フォームの送信として届く） */
export async function scanAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const workerId = await currentWorkerId(mgmtNo);
  const code = String(formData.get("code") ?? "");
  const result = await scanPart(workerId, mgmtNo, code);
  if (result.kind === "installed") refresh();
  return { ...result, at: Date.now() };
}

/** 最後に付けた部品を1つ外す */
export async function undoAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const r = await undoLast(await currentWorkerId(mgmtNo), mgmtNo);
  if (r.ok) refresh();
  return r.ok
    ? { kind: "installed", slot: "", message: r.message, at: Date.now() }
    : { kind: "error", message: r.message, at: Date.now() };
}

/** 組立完了（検品待ちにする） */
export async function finishAction(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const r = await finishAssembly(await currentWorkerId(mgmtNo), mgmtNo);
  if (r.ok) refresh();
  return r.ok
    ? { kind: "installed", slot: "", message: r.message, at: Date.now() }
    : { kind: "error", message: r.message, at: Date.now() };
}

export type NoteState = { ok: boolean; message: string; at: number } | null;

/** 個体のメモを足す（在庫を使わない作業・部品） */
export async function addNoteAction(_prev: NoteState, formData: FormData): Promise<NoteState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const r = await addUnitNote(await currentWorkerId(mgmtNo), mgmtNo, String(formData.get("note") ?? ""));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 個体のメモを取り消す */
export async function removeNoteAction(_prev: NoteState, formData: FormData): Promise<NoteState> {
  const mgmtNo = String(formData.get("mgmtNo") ?? "");
  const r = await removeUnitNote(await currentWorkerId(mgmtNo), mgmtNo, Number(formData.get("noteId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}
