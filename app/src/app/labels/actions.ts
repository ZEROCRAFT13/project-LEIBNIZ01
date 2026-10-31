"use server";

import { refresh } from "next/cache";
import { requireAssembler } from "@/lib/auth/session";
import { parseLabelRequest } from "@/lib/label-calc";
import { markLabelsPrinted } from "@/lib/label-print";

export type PrintState = { ok: boolean; message: string; at: number } | null;

/** シールを刷った印を付ける（印刷の画面で、刷れたことを確かめてから押す） */
export async function markPrintedAction(_prev: PrintState, formData: FormData): Promise<PrintState> {
  const viewer = await requireAssembler("/labels");
  const { mgmtNos } = parseLabelRequest({ u: formData.getAll("u").map(String) });
  const n = await markLabelsPrinted(viewer.user.id, mgmtNos);
  refresh();
  return { ok: n > 0, message: n > 0 ? `${n}台を「刷った」にしました。` : "印を付ける個体がありません。", at: Date.now() };
}
