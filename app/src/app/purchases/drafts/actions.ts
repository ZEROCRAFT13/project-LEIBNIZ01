"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requirePurchaser } from "@/lib/auth/session";
import { confirmDraft, createDraftFromMail, discardDraft, type LineChoice } from "@/lib/purchase-drafts";

// 仕入れの下書きの操作。どれも最初に requirePurchaser で「代表・工場長がログインしているか」を確かめる。
// 貼り付けたメールの本文はログにも DB にも残さない（宛名・住所が入っているため）。

export type DraftFormState = {
  message: string;
  existingDraftId?: number;
  existingPurchaseId?: number;
  at: number;
} | null;

/** 注文確認メールの本文を貼り付けて、下書きを作る */
export async function createDraftAction(_prev: DraftFormState, formData: FormData): Promise<DraftFormState> {
  const viewer = await requirePurchaser("/purchases/drafts");
  const r = await createDraftFromMail(viewer.user.id, String(formData.get("mail") ?? ""));
  if (!r.ok) return { ...r, at: Date.now() };
  redirect(`/purchases/drafts/${r.id}`);
}

/** 下書きを確かめて、仕入れとして確定する */
export async function confirmDraftAction(_prev: DraftFormState, formData: FormData): Promise<DraftFormState> {
  const draftId = Number(formData.get("draftId"));
  const viewer = await requirePurchaser(`/purchases/drafts/${Number.isSafeInteger(draftId) ? draftId : ""}`);
  const count = Number(formData.get("lineCount"));
  const choices: LineChoice[] = [];
  for (let i = 0; i < (Number.isSafeInteger(count) ? Math.min(count, 200) : 0); i++) {
    const v = String(formData.get(`line-${i}`) ?? "");
    choices.push(v === "other" ? { other: true } : { partModelId: Number(v) });
  }
  const r = await confirmDraft(viewer.user.id, draftId, {
    supplierId: Number(formData.get("supplierId")),
    orderedOn: String(formData.get("orderedOn") ?? ""),
    paymentMethod: String(formData.get("paymentMethod") ?? ""),
    choices,
  });
  if (!r.ok) return { ...r, at: Date.now() };
  redirect(`/purchases/${r.purchaseId}?new=1`);
}

/** 下書きを捨てる */
export async function discardDraftAction(formData: FormData): Promise<void> {
  const draftId = Number(formData.get("draftId"));
  const viewer = await requirePurchaser("/purchases/drafts");
  await discardDraft(viewer.user.id, draftId);
  refresh();
  redirect("/purchases/drafts");
}
