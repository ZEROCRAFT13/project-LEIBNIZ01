// FBA の補充：在庫・販売ペースから、欠品しそうな日・組立を始める期限・補充の目安を出す（計算だけ。ルール5）
//   在庫（supply）    = 販売できる数 + これから販売できるようになる数（納品の作業中・輸送中・受領中、倉庫の処理中）
//                      + このシステムで組立中・検品中・出荷待ちの個体（まだ FBA の納品にも自社出荷の注文にも入れていないもの）
//   1日の販売ペース   = 直近 windowDays 日（今日は途中なので入れない）に売れた台数 ÷ windowDays
//   残り日数          = 在庫 ÷ 1日の販売ペース（切り捨て）
//   欠品しそうな日    = 今日 + 残り日数
//   組立を始める期限  = 欠品しそうな日 − 組立から FBA 受領までの日数（leadDays）
//   補充の目安        = 1日の販売ペース ×（leadDays + coverDays）− 在庫（切り上げ。足りていれば 0）
// 日付は日本時間の YYYY-MM-DD で扱う

import type { FbaInventoryItem } from "@/lib/amazon/sp-api";

export type RestockSettings = { leadDays: number; windowDays: number; coverDays: number; warnDays: number };
export const DEFAULT_RESTOCK: RestockSettings = { leadDays: 10, windowDays: 14, coverDays: 30, warnDays: 3 };

export type RestockLevel = "late" | "soon" | "ok" | "no_sales";

export type RestockPlan = {
  supply: number;
  /** 1日の販売ペース（小数2けた） */
  perDay: number;
  daysLeft: number | null;
  stockoutDate: string | null;
  startBy: string | null;
  suggestQty: number;
  /** late … 組立を始める期限を過ぎた／今日まで、soon … warnDays 日以内、ok … まだ先、no_sales … 売れていない */
  level: RestockLevel;
};

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 日付の差（b − a、日） */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function restockPlan(
  input: { fulfillable: number; inbound: number; pipeline?: number; soldInWindow: number; today: string },
  s: RestockSettings = DEFAULT_RESTOCK,
): RestockPlan {
  const supply = Math.max(0, input.fulfillable) + Math.max(0, input.inbound) + Math.max(0, input.pipeline ?? 0);
  const perDayRaw = s.windowDays > 0 ? Math.max(0, input.soldInWindow) / s.windowDays : 0;
  const perDay = Math.round(perDayRaw * 100) / 100;
  if (perDayRaw === 0) {
    return { supply, perDay: 0, daysLeft: null, stockoutDate: null, startBy: null, suggestQty: 0, level: "no_sales" };
  }
  const daysLeft = Math.floor(supply / perDayRaw);
  const stockoutDate = addDays(input.today, daysLeft);
  const startBy = addDays(stockoutDate, -s.leadDays);
  const suggestQty = Math.max(0, Math.ceil(perDayRaw * (s.leadDays + s.coverDays) - supply - 1e-9));
  const until = diffDays(input.today, startBy);
  const level: RestockLevel = until <= 0 ? "late" : until <= s.warnDays ? "soon" : "ok";
  return { supply, perDay, daysLeft, stockoutDate, startBy, suggestQty, level };
}

/** 組立を始める期限の日の終わり（日本時間 23:59:59）。ToDo の期限にする */
export function endOfJstDay(ymd: string): Date {
  return new Date(`${ymd}T23:59:59+09:00`);
}

/** FBA Inventory API の1行 → 販売できる数・これから販売できるようになる数・売れて出荷待ち・販売不可 */
export function fbaQuantities(item: FbaInventoryItem): { fulfillable: number; inbound: number; reserved: number; unfulfillable: number } {
  const d = item.inventoryDetails ?? {};
  const n = (v: number | undefined) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);
  const r = d.reservedQuantity ?? {};
  return {
    fulfillable: n(d.fulfillableQuantity),
    inbound:
      n(d.inboundWorkingQuantity) +
      n(d.inboundShippedQuantity) +
      n(d.inboundReceivingQuantity) +
      n(r.fcProcessingQuantity) +
      n(r.pendingTransshipmentQuantity),
    reserved: n(r.pendingCustomerOrderQuantity),
    unfulfillable: n(d.unfulfillableQuantity?.totalUnfulfillableQuantity),
  };
}
