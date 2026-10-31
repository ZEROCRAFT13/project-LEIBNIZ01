"use server";

import { refresh } from "next/cache";
import { requireDocuments } from "@/lib/auth/session";
import { parseDocumentMeta } from "@/lib/document-calc";
import {
  importInbox,
  intakeFile,
  linkToPurchase,
  unlinkFromPurchase,
  updateDocumentMeta,
  type InboxSummary,
  type IntakeResult,
} from "@/lib/documents";

// 書類の操作。どれも最初に requireDocuments で「書類を扱える人がログインしているか」を確かめる。

export type UploadResult = IntakeResult | { status: "rejected"; name: string; reason: string };

/** ファイルを1つアップロードする（画面から1ファイルずつ呼ぶ） */
export async function uploadDocumentAction(formData: FormData): Promise<UploadResult> {
  const viewer = await requireDocuments("/documents");
  const file = formData.get("file");
  if (!(file instanceof File)) return { status: "rejected", name: "", reason: "ファイルがありません。" };
  const purchaseId = Number(formData.get("purchaseId"));
  const r = await intakeFile(
    viewer.user.id,
    { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, source: "upload" },
    Number.isSafeInteger(purchaseId) && purchaseId > 0 ? purchaseId : null,
  );
  if (r.status !== "rejected") refresh();
  return r;
}

export type InboxState = (InboxSummary & { at: number }) | null;

/** 共有の取り込みフォルダにあるファイルを取り込む（useActionState から呼ぶので、前の結果を受け取るが使わない） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function importInboxAction(_prev: InboxState): Promise<InboxState> {
  const viewer = await requireDocuments("/documents");
  const r = await importInbox(viewer.user.id);
  if (r.results.length > 0) refresh();
  return { ...r, at: Date.now() };
}

export type DocState = { ok: boolean; message: string; at: number } | null;

function documentId(formData: FormData): number {
  return Number(formData.get("documentId"));
}

/** 日付・取引先・金額などを保存する（「確認済みにする」なら確認済みに） */
export async function saveDocumentMetaAction(_prev: DocState, formData: FormData): Promise<DocState> {
  const id = documentId(formData);
  const viewer = await requireDocuments(`/documents/${Number.isSafeInteger(id) ? id : ""}`);
  const parsed = parseDocumentMeta({
    kind: formData.get("kind"),
    issuedOn: formData.get("issuedOn"),
    counterparty: formData.get("counterparty"),
    amount: formData.get("amount"),
    invoiceRegNo: formData.get("invoiceRegNo"),
  });
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  const r = await updateDocumentMeta(viewer.user.id, id, parsed.value, formData.get("done") === "1");
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 仕入れにひもづける */
export async function linkPurchaseAction(_prev: DocState, formData: FormData): Promise<DocState> {
  const id = documentId(formData);
  const viewer = await requireDocuments(`/documents/${Number.isSafeInteger(id) ? id : ""}`);
  const r = await linkToPurchase(viewer.user.id, id, Number(formData.get("purchaseId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

/** 仕入れとのひもづけを外す */
export async function unlinkPurchaseAction(_prev: DocState, formData: FormData): Promise<DocState> {
  const id = documentId(formData);
  const viewer = await requireDocuments(`/documents/${Number.isSafeInteger(id) ? id : ""}`);
  const r = await unlinkFromPurchase(viewer.user.id, id, Number(formData.get("purchaseId")));
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}
