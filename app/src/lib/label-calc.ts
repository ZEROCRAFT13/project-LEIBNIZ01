// 管理番号シール（PT-P700・24mm テープ）の中身と大きさ。DBを使わないので、そのままテストできる。

import { isMgmtNo, normalizeSearch } from "@/lib/codes";

/** テープの幅ごとの、印刷できる高さ（mm）。PT-P700 は 24mm テープで高さ 18mm まで印刷できる */
export const TAPES = { 24: { tape: 24, printable: 18 } } as const;
export type TapeWidth = keyof typeof TAPES;

/** シール1枚の長さ（mm）。QR（印刷できる高さの正方形）＋文字の分 */
export const LABEL_LENGTH_MM = 62;

/** 1回に刷れる個体の数と、1個体あたりの枚数（本体と箱で2枚がふつう） */
export const MAX_UNITS = 50;
export const MAX_COPIES = 4;

/** 開発中・URL を決める前の仮の URL（本物のシールを刷る前に ZB_PUBLIC_URL を決める） */
export const PLACEHOLDER_PUBLIC_URL = "https://zerobit.example";

/** QR に入れる URL（お客様が読むと製品登録の画面が開く。組立の読み取りでは管理番号として扱う） */
export function labelUrl(publicUrl: string | undefined, mgmtNo: string): string {
  const base = (publicUrl?.trim() || PLACEHOLDER_PUBLIC_URL).replace(/\/+$/, "");
  return `${base}/r/${mgmtNo}`;
}

export function isPlaceholderUrl(publicUrl: string | undefined): boolean {
  return !publicUrl?.trim() || publicUrl.includes("example");
}

/** 印刷画面の URL の値（?u=ZB-…&u=ZB-…&copies=2）を確かめる。おかしな番号は捨て、同じ番号は1つにする */
export function parseLabelRequest(raw: { u?: string | string[]; copies?: string | string[] }): {
  mgmtNos: string[];
  copies: number;
} {
  const list = Array.isArray(raw.u) ? raw.u : raw.u ? [raw.u] : [];
  const mgmtNos = [
    ...new Set(
      list
        .flatMap((v) => v.split(","))
        .map((v) => normalizeSearch(v))
        .filter(isMgmtNo),
    ),
  ].slice(0, MAX_UNITS);
  const c = Number(Array.isArray(raw.copies) ? raw.copies[0] : raw.copies);
  const copies = Number.isInteger(c) && c >= 1 && c <= MAX_COPIES ? c : 2;
  return { mgmtNos, copies };
}
