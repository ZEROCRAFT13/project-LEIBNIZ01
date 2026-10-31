// 仕入れの金額の計算と、入力の確かめ。DBを使わないので、そのままテストできる（CLAUDE.md ルール5・10）。
// 金額はすべて円の整数。部品の消費税は10%。

export const PAYMENT_METHODS = ["card", "bank", "cash", "cod", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MAX_LINES = 50;
export const MAX_QTY = 999;
export const MAX_UNIT_PRICE = 10_000_000;

/**
 * 税込価格を税抜と消費税（10%）に分ける。税抜は 価格÷1.1 を四捨五入
 * （÷11 なので、ちょうど .5 になることはない）
 */
export function splitTax10(priceInclTax: number): { excl: number; tax: number } {
  const excl = Math.round((priceInclTax * 10) / 11);
  return { excl, tax: priceInclTax - excl };
}

export type LineInput = {
  /** 部品の型番（送料・手数料などは null） */
  partModelId: number | null;
  description: string;
  qty: number;
  /** 税込の単価 */
  unitPrice: number;
};

/** 明細から合計（税込）と、領収書に消費税の記載がないときに使う消費税を出す */
export function purchaseTotals(lines: Pick<LineInput, "qty" | "unitPrice">[]): { total: number; tax: number } {
  const total = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  return { total, tax: splitTax10(total).tax };
}

export type PurchaseInput = {
  supplierId: number;
  /** 仕入先の注文番号（ないときは null） */
  orderNo: string | null;
  /** 'YYYY-MM-DD' */
  orderedOn: string;
  paymentMethod: PaymentMethod;
  lines: LineInput[];
  total: number;
  /** 領収書のうち消費税 */
  tax: number;
};

export type Parsed = { ok: true; value: PurchaseInput } | { ok: false; errors: string[] };

function int(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.normalize("NFKC").replace(/[,\s円¥]/g, "") : "";
  return /^\d+$/.test(s) ? Number(s) : null;
}

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 画面から届いた値を確かめて、登録できる形にする。
 * 合計は明細から計算し直す（画面の表示は信じない）。消費税は空なら計算した値を使う。
 */
export function parsePurchaseInput(
  raw: {
    supplierId: unknown;
    orderNo: unknown;
    orderedOn: unknown;
    paymentMethod: unknown;
    tax: unknown;
    lines: unknown;
  },
  today: string,
): Parsed {
  const errors: string[] = [];

  const supplierId = int(raw.supplierId);
  if (!supplierId) errors.push("仕入先を選んでください。");

  const orderNoText = typeof raw.orderNo === "string" ? raw.orderNo.normalize("NFKC").trim() : "";
  if (orderNoText.length > 60) errors.push("注文番号が長すぎます（60文字まで）。");

  const orderedOn = typeof raw.orderedOn === "string" ? raw.orderedOn : "";
  if (!isDate(orderedOn)) errors.push("注文日を正しく入れてください。");
  else if (orderedOn > today) errors.push("注文日が未来になっています。");

  const paymentMethod = PAYMENT_METHODS.find((m) => m === raw.paymentMethod);
  if (!paymentMethod) errors.push("支払い方法を選んでください。");

  const lines: LineInput[] = [];
  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  if (rawLines.length === 0) errors.push("明細を1行以上入れてください。");
  if (rawLines.length > MAX_LINES) errors.push(`明細は${MAX_LINES}行までです。`);
  rawLines.slice(0, MAX_LINES).forEach((l: unknown, i) => {
    const row = (l ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const isOther = row.partModelId === null || row.partModelId === ""; // 部品以外（送料など）
    const partModelId = isOther ? null : int(row.partModelId);
    if (!isOther && !partModelId) errors.push(`${n}行目：部品を選んでください。`);
    const description = typeof row.description === "string" ? row.description.trim() : "";
    if (isOther && (description.length < 1 || description.length > 100)) {
      errors.push(`${n}行目：部品以外（送料など）は内容を書いてください。`);
    }
    const qty = int(row.qty);
    if (!qty || qty > MAX_QTY) errors.push(`${n}行目：数量は1〜${MAX_QTY}にしてください。`);
    const unitPrice = int(row.unitPrice);
    if (unitPrice === null || unitPrice > MAX_UNIT_PRICE) errors.push(`${n}行目：単価（税込）を円で入れてください。`);
    lines.push({ partModelId, description, qty: qty ?? 0, unitPrice: unitPrice ?? 0 });
  });
  if (rawLines.length > 0 && !lines.some((l) => l.partModelId !== null)) {
    errors.push("部品の明細が1行もありません（送料だけの仕入れは登録できません）。");
  }

  const { total, tax: defaultTax } = purchaseTotals(lines);
  const taxText = typeof raw.tax === "string" ? raw.tax.trim() : raw.tax;
  const tax = taxText === "" || taxText == null ? defaultTax : int(taxText);
  if (tax === null) errors.push("うち消費税は円の数字で入れてください（空なら自動で計算します）。");
  else if (tax > total) errors.push("うち消費税が合計より大きくなっています。");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      supplierId: supplierId!,
      orderNo: orderNoText || null,
      orderedOn,
      paymentMethod: paymentMethod!,
      lines,
      total,
      tax: tax!,
    },
  };
}

/** 元箱の棚番をそろえる（例: ｂ－７ → B-7） */
export function normalizeBoxLocation(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[‐‑‒–—―ー−－]/g, "-")
    .replace(/\s+/g, "");
}

// ---------------------------------------------------------------------
// 発送（追跡番号）
// ---------------------------------------------------------------------

export const CARRIERS = ["yamato", "sagawa", "japanpost", "seino", "amazon", "other"] as const;
export type Carrier = (typeof CARRIERS)[number];

/**
 * 追跡番号をそろえる。ハイフン・空白を取り、全角を半角・英字を大文字にする。
 * 送り状のバーコード（Codabar）を読むと前後に A〜D が付くことがあるので、数字を挟んでいれば外す。
 * 例: 「1234-5678-9012」「ａ123456789012ａ」→ 123456789012
 */
export function normalizeTracking(raw: string): string {
  const s = raw.normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const codabar = s.match(/^[A-D](\d{6,30})[A-D]$/);
  return codabar ? codabar[1] : s;
}

export function isTrackingNo(s: string): boolean {
  return /^[0-9A-Z]{6,30}$/.test(s);
}
