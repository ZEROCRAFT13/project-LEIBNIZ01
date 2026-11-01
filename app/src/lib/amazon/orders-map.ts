// Orders API v2026-01-01（searchOrders）の応答から、このシステムで使う項目だけを取り出す。DBを使わないので、そのままテストできる。
// 取り出すのは注文番号・日時・状態・出荷期限・出品（セラー SKU）・数・単価だけ。
// お客様の名前・住所・電話・メールは取り出さない（そもそも includedData に BUYER・RECIPIENT を入れないので届かない）。
// 金額は円の整数にする（小数があったり円でなかったりしたら、その注文は取り込まずに知らせる。ルール5）

export const JP_MARKETPLACE_ID = "A1VC38T7YXB528";

export const AMAZON_STATUSES = [
  "PENDING_AVAILABILITY",
  "PENDING",
  "UNSHIPPED",
  "PARTIALLY_SHIPPED",
  "SHIPPED",
  "CANCELLED",
  "UNFULFILLABLE",
] as const;
export type AmazonStatus = (typeof AMAZON_STATUSES)[number];

/** 応答の形（使うところだけ。知らない項目は無視する） */
export type ApiMoney = { amount?: string; currencyCode?: string };
export type ApiOrder = {
  orderId?: string;
  createdTime?: string;
  lastUpdatedTime?: string;
  salesChannel?: { marketplaceId?: string };
  fulfillment?: {
    fulfillmentStatus?: string;
    fulfilledBy?: string;
    shipByWindow?: { earliestDateTime?: string; latestDateTime?: string };
  };
  orderItems?: {
    orderItemId?: string;
    quantityOrdered?: number;
    product?: { asin?: string; sellerSku?: string; price?: { unitPrice?: ApiMoney } };
  }[];
};

export type AmazonOrderLine = { sellerSku: string; asin: string | null; qty: number; unitPrice: number };

export type AmazonOrder = {
  orderNo: string;
  createdAt: Date;
  updatedAt: Date;
  status: AmazonStatus;
  merchantFulfilled: boolean;
  /** 出荷期限の日（日本の日付）。分からなければ null */
  shipBy: string | null;
  lines: AmazonOrderLine[];
  /** 単価 × 数の合計（税込・円） */
  total: number;
};

export type MapResult = { ok: true; order: AmazonOrder } | { ok: false; orderNo: string | null; reason: string };

/** "349800.00" → 349800。円の整数でなければ null */
export function yenFromMoney(m: ApiMoney | undefined): number | null {
  if (!m || m.currencyCode !== "JPY" || typeof m.amount !== "string") return null;
  const t = m.amount.trim();
  const match = t.match(/^(\d{1,12})(?:\.(\d+))?$/);
  if (!match) return null;
  if (match[2] && /[^0]/.test(match[2])) return null; // 1円未満がある
  return Number(match[1]);
}

/** ISO の日時 → 日本の日付（YYYY-MM-DD） */
export function jstDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
}

function date(iso: string | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

export function mapOrder(o: ApiOrder): MapResult {
  const orderNo = typeof o.orderId === "string" && /^\d{3}-\d{7}-\d{7}$/.test(o.orderId) ? o.orderId : null;
  if (!orderNo) return { ok: false, orderNo: null, reason: "注文番号の形がちがう" };
  const createdAt = date(o.createdTime);
  const updatedAt = date(o.lastUpdatedTime);
  if (!createdAt || !updatedAt) return { ok: false, orderNo, reason: "注文の日時が読めない" };
  const status = AMAZON_STATUSES.find((s) => s === o.fulfillment?.fulfillmentStatus);
  if (!status) return { ok: false, orderNo, reason: "注文の状態が読めない" };
  if (o.salesChannel?.marketplaceId && o.salesChannel.marketplaceId !== JP_MARKETPLACE_ID) {
    return { ok: false, orderNo, reason: "日本以外のマーケットプレイスの注文" };
  }

  const lines: AmazonOrderLine[] = [];
  for (const item of o.orderItems ?? []) {
    const sellerSku = item.product?.sellerSku?.trim();
    const qty = item.quantityOrdered;
    if (!sellerSku) return { ok: false, orderNo, reason: "出品（セラー SKU）が読めない" };
    if (!Number.isInteger(qty) || (qty as number) < 0) return { ok: false, orderNo, reason: "数が読めない" };
    if (qty === 0) continue; // 取り消された明細など
    const unitPrice = yenFromMoney(item.product?.price?.unitPrice);
    if (unitPrice === null) return { ok: false, orderNo, reason: "単価が円の整数で読めない" };
    lines.push({ sellerSku, asin: item.product?.asin ?? null, qty: qty as number, unitPrice });
  }
  const latest = o.fulfillment?.shipByWindow?.latestDateTime;
  return {
    ok: true,
    order: {
      orderNo,
      createdAt,
      updatedAt,
      status,
      merchantFulfilled: o.fulfillment?.fulfilledBy === "MERCHANT",
      shipBy: latest ? jstDate(latest) : null,
      lines,
      total: lines.reduce((n, l) => n + l.unitPrice * l.qty, 0),
    },
  };
}

/** 取り込みの起点：前に成功した回の終わりから、少し重ねて取る（取りこぼし防止。同じ注文は注文番号で1つにまとまる） */
export const OVERLAP_MINUTES = 10;
export const FIRST_LOOKBACK_HOURS = 24;
export const RECONCILE_DAYS = 7;

export function syncWindowFrom(
  mode: "incremental" | "reconcile" | "manual",
  lastCursor: Date | null,
  now: Date,
): Date {
  if (mode !== "incremental") return new Date(now.getTime() - RECONCILE_DAYS * 86_400_000);
  if (!lastCursor) return new Date(now.getTime() - FIRST_LOOKBACK_HOURS * 3600_000);
  return new Date(lastCursor.getTime() - OVERLAP_MINUTES * 60_000);
}

/** 取り込みが止まっているとみなす時間 */
export const STALE_MINUTES = 30;
