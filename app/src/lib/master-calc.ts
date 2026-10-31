// 部品の型番・仕入先の入力を確かめる。DBを使わないので、そのままテストできる。

export const PART_CATEGORIES = [
  "cpu",
  "gpu",
  "motherboard",
  "memory",
  "ssd",
  "psu",
  "cooler",
  "case",
  "fan",
  "os",
  "other",
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

export const SUPPLIER_KINDS = ["shop", "distributor", "other"] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];

type Raw = Record<string, unknown>;
// 番号（型番・JAN・登録番号・URL）は全角を半角にそろえる
const text = (v: unknown) => (typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim() : "");
// 名前やメモは、書いたとおりに残す（全角の（）などを変えない）。空白だけそろえる
const plain = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "");
const checked = (v: unknown) => v === "on" || v === "1" || v === "true" || v === true;

/**
 * JANコード（8桁か13桁）として正しいか。最後の1桁（チェックデジット）まで確かめるので、
 * 打ち間違いやバーコードの読み間違いに気づける。
 */
export function isValidJan(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // 右から数えて奇数番目（チェックデジットのすぐ左から）に3をかける
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export type PartModelInput = {
  category: PartCategory;
  maker: string;
  modelNo: string;
  name: string;
  janCode: string | null;
  serialRequired: boolean;
  keepBox: boolean;
  makerWarrantyMonths: number | null;
  active: boolean;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** 部品の型番の入力を確かめる */
export function parsePartModelInput(raw: Raw): Parsed<PartModelInput> {
  const errors: string[] = [];
  const category = PART_CATEGORIES.find((c) => c === raw.category);
  if (!category) errors.push("種類を選んでください。");

  const maker = plain(raw.maker);
  if (maker.length < 1 || maker.length > 60) errors.push("メーカーを入れてください（60文字まで）。");
  const modelNo = text(raw.modelNo).toUpperCase();
  if (modelNo.length < 1 || modelNo.length > 60) errors.push("型番を入れてください（60文字まで）。");
  const name = plain(raw.name);
  if (name.length < 1 || name.length > 100) errors.push("名前を入れてください（100文字まで）。");

  const jan = text(raw.janCode).replace(/[\s-]/g, "");
  let janCode: string | null = null;
  if (jan !== "") {
    if (!isValidJan(jan)) errors.push("JANコードが正しくありません（8桁か13桁。最後の1桁が合いません）。");
    else janCode = jan;
  }

  const w = text(raw.makerWarrantyMonths);
  let makerWarrantyMonths: number | null = null;
  if (w !== "") {
    if (!/^\d{1,3}$/.test(w) || Number(w) > 240) errors.push("メーカー保証は月数（0〜240）で入れてください。");
    else makerWarrantyMonths = Number(w);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      category: category!,
      maker,
      modelNo,
      name,
      janCode,
      serialRequired: checked(raw.serialRequired),
      keepBox: checked(raw.keepBox),
      makerWarrantyMonths,
      active: raw.active === undefined ? true : checked(raw.active),
    },
  };
}

export type SupplierInput = {
  name: string;
  kind: SupplierKind;
  invoiceRegNo: string | null;
  website: string | null;
  rmaContact: string | null;
  notes: string | null;
};

/** 仕入先の入力を確かめる */
export function parseSupplierInput(raw: Raw): Parsed<SupplierInput> {
  const errors: string[] = [];
  const name = plain(raw.name);
  if (name.length < 1 || name.length > 60) errors.push("仕入先の名前を入れてください（60文字まで）。");
  const kind = SUPPLIER_KINDS.find((k) => k === raw.kind);
  if (!kind) errors.push("種類を選んでください。");

  const reg = text(raw.invoiceRegNo).toUpperCase().replace(/[\s-]/g, "");
  let invoiceRegNo: string | null = null;
  if (reg !== "") {
    if (!/^T\d{13}$/.test(reg)) errors.push("インボイス登録番号は「T」と13桁の数字です。");
    else invoiceRegNo = reg;
  }

  const site = text(raw.website);
  let website: string | null = null;
  if (site !== "") {
    try {
      const u = new URL(site);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      website = u.toString();
    } catch {
      errors.push("サイトのURLは https:// から入れてください。");
    }
  }

  const rmaContact = plain(raw.rmaContact) || null;
  if (rmaContact && rmaContact.length > 200) errors.push("RMAの窓口が長すぎます（200文字まで）。");
  const notes = typeof raw.notes === "string" ? raw.notes.normalize("NFC").trim() || null : null;
  if (notes && notes.length > 500) errors.push("メモが長すぎます（500文字まで）。");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, kind: kind!, invoiceRegNo, website, rmaContact, notes } };
}
