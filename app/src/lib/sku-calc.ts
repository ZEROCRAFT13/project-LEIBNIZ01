// 機種（SKU）と構成表の枠の入力を確かめる。DBを使わないので、そのままテストできる。

import { PART_CATEGORIES, type PartCategory } from "@/lib/master-calc";

/** 新しい機種を「ひな形」から作るときの枠（ゲーミングPCのふつうの構成） */
export const DEFAULT_SLOTS: { slot: string; category: PartCategory; qty: number; required: boolean; anyPart: boolean }[] = [
  { slot: "CPU", category: "cpu", qty: 1, required: true, anyPart: false },
  { slot: "GPU", category: "gpu", qty: 1, required: true, anyPart: false },
  { slot: "MB", category: "motherboard", qty: 1, required: true, anyPart: false },
  { slot: "MEMORY", category: "memory", qty: 1, required: true, anyPart: false },
  { slot: "SSD", category: "ssd", qty: 1, required: true, anyPart: false },
  { slot: "PSU", category: "psu", qty: 1, required: true, anyPart: false },
  { slot: "COOLER", category: "cooler", qty: 1, required: true, anyPart: false },
  { slot: "CASE", category: "case", qty: 1, required: true, anyPart: false },
  { slot: "OS", category: "os", qty: 1, required: true, anyPart: false },
  // ケースファンは、付けなくても完了できる（Amazon 用の機種は「必ず付ける」に変えて型番を固定する）
  { slot: "FAN", category: "fan", qty: 3, required: false, anyPart: false },
  // 自由枠：登録済みの部品なら何でも（Wi-Fiカード、追加のSSDなど）
  { slot: "EXTRA", category: "other", qty: 5, required: false, anyPart: true },
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

export type SlotInput = { slot: string; category: PartCategory; qty: number; required: boolean; anyPart: boolean };

/**
 * 枠の名前（例 GPU、MEMORY、FAN_FRONT）と種類と数を確かめる。
 * 種類に "any" を選ぶと自由枠（登録済みの部品なら何でも）。optional が付いていれば「付けなくてもよい」
 */
export function parseSlotInput(raw: Record<string, unknown>): Parsed<SlotInput> {
  const errors: string[] = [];
  const slot = (typeof raw.slot === "string" ? raw.slot : "").normalize("NFKC").toUpperCase().trim().replace(/[\s-]+/g, "_");
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(slot)) {
    errors.push("枠の名前は英大文字で始め、英大文字・数字・_ で20文字までにしてください（例 FAN_FRONT）。");
  }
  const anyPart = raw.category === "any";
  const category = anyPart ? "other" : PART_CATEGORIES.find((c) => c === raw.category);
  if (!category) errors.push("枠に入れる部品の種類を選んでください。");
  const required = !(raw.optional === "on" || raw.optional === "1");
  const q = num(raw.qty);
  const qty = /^\d{1,2}$/.test(q) ? Number(q) : 0;
  if (qty < 1 || qty > 20) errors.push("数は1〜20にしてください。");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { slot, category: category!, qty, required, anyPart } };
}
