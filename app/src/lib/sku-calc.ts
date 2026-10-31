// 機種（SKU）と構成表の枠の入力を確かめる。DBを使わないので、そのままテストできる。

import { PART_CATEGORIES, type PartCategory } from "@/lib/master-calc";

/** 新しい機種を「ひな形」から作るときの枠（ゲーミングPCのふつうの構成） */
export const DEFAULT_SLOTS: { slot: string; category: PartCategory }[] = [
  { slot: "CPU", category: "cpu" },
  { slot: "GPU", category: "gpu" },
  { slot: "MB", category: "motherboard" },
  { slot: "MEMORY", category: "memory" },
  { slot: "SSD", category: "ssd" },
  { slot: "PSU", category: "psu" },
  { slot: "COOLER", category: "cooler" },
  { slot: "CASE", category: "case" },
  { slot: "OS", category: "os" },
];

export type SkuInput = { code: string; name: string; listPrice: number | null; active: boolean };
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const plain = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "");
const num = (v: unknown) => (typeof v === "string" ? v.normalize("NFKC").replace(/[,\s円¥]/g, "") : "");

/** 機種コードをそろえる（大文字・半角、空白を取る。例 zb－g5070－r7 → ZB-G5070-R7） */
export function normalizeSkuCode(raw: string): string {
  return raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .replace(/\s+/g, "");
}

export function parseSkuInput(raw: Record<string, unknown>): Parsed<SkuInput> {
  const errors: string[] = [];
  const code = normalizeSkuCode(typeof raw.code === "string" ? raw.code : "");
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(code)) {
    errors.push("機種コードは英大文字・数字・ハイフンで3〜30文字にしてください（例 ZB-G5070-R7）。");
  }
  const name = plain(raw.name);
  if (name.length < 1 || name.length > 100) errors.push("機種の名前を入れてください（100文字まで）。");
  const p = num(raw.listPrice);
  let listPrice: number | null = null;
  if (p !== "") {
    if (!/^\d{1,9}$/.test(p)) errors.push("定価（税込）は円の数字で入れてください。");
    else listPrice = Number(p);
  }
  const active = raw.active === undefined ? true : raw.active === "on" || raw.active === "1";
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { code, name, listPrice, active } };
}

export type SlotInput = { slot: string; category: PartCategory; qty: number };

/** 枠の名前（例 GPU、MEMORY、FAN_FRONT）と種類と数を確かめる */
export function parseSlotInput(raw: Record<string, unknown>): Parsed<SlotInput> {
  const errors: string[] = [];
  const slot = (typeof raw.slot === "string" ? raw.slot : "").normalize("NFKC").toUpperCase().trim().replace(/[\s-]+/g, "_");
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(slot)) {
    errors.push("枠の名前は英大文字で始め、英大文字・数字・_ で20文字までにしてください（例 FAN_FRONT）。");
  }
  const category = PART_CATEGORIES.find((c) => c === raw.category);
  if (!category) errors.push("枠に入れる部品の種類を選んでください。");
  const q = num(raw.qty);
  const qty = /^\d{1,2}$/.test(q) ? Number(q) : 0;
  if (qty < 1 || qty > 20) errors.push("数は1〜20にしてください。");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { slot, category: category!, qty } };
}
