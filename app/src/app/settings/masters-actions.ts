"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requirePurchaser } from "@/lib/auth/session";
import { parsePartModelInput, parseSupplierInput } from "@/lib/master-calc";
import { createPartModel, createSupplier, updatePartModel, updateSupplier } from "@/lib/masters";

// 部品の型番と仕入先の追加・変更。最初に requirePurchaser で「代表・工場長がログインしているか」を確かめる。

export type MasterState = { ok: boolean; messages: string[]; at: number } | null;

function idOf(formData: FormData): number | null {
  const id = Number(formData.get("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 部品の型番を追加・保存する */
export async function savePartModelAction(_prev: MasterState, formData: FormData): Promise<MasterState> {
  const id = idOf(formData);
  const viewer = await requirePurchaser(id ? `/settings/parts/${id}` : "/settings/parts/new");
  const parsed = parsePartModelInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, messages: parsed.errors, at: Date.now() };
  const r = id
    ? await updatePartModel(viewer.user.id, id, parsed.value)
    : await createPartModel(viewer.user.id, parsed.value);
  if (!r.ok) return { ok: false, messages: [r.message], at: Date.now() };
  if (!id) redirect(`/settings/parts/${r.id}?added=1`);
  refresh();
  return { ok: true, messages: [r.message], at: Date.now() };
}

/** 仕入先を追加・保存する */
export async function saveSupplierAction(_prev: MasterState, formData: FormData): Promise<MasterState> {
  const id = idOf(formData);
  const viewer = await requirePurchaser(id ? `/settings/suppliers/${id}` : "/settings/suppliers/new");
  const parsed = parseSupplierInput(Object.fromEntries(formData));
  if (!parsed.ok) return { ok: false, messages: parsed.errors, at: Date.now() };
  const r = id
    ? await updateSupplier(viewer.user.id, id, parsed.value)
    : await createSupplier(viewer.user.id, parsed.value);
  if (!r.ok) return { ok: false, messages: [r.message], at: Date.now() };
  if (!id) redirect(`/settings/suppliers/${r.id}?added=1`);
  refresh();
  return { ok: true, messages: [r.message], at: Date.now() };
}
