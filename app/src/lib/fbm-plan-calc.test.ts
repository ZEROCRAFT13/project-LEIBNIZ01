// 自社出荷の作り方と出品数の計算（DB を使わない）
import { describe, expect, it } from "vitest";
import { buildableFromParts, fbmListingQty, stockShortage } from "@/lib/fbm-plan-calc";

const base = { fulfillment: "fbm" as const, policy: "stock" as const, ready: 2, buildable: 5, maxToOrder: 2, fbaFulfillable: null };

describe("Amazon に出す数", () => {
  it("作り置き：出荷待ちの台数だけ出す（部品で組める分は出さない）", () => {
    expect(fbmListingQty(base)).toEqual({ qty: 2, why: "出荷待ち 2台" });
  });

  it("注文を受けてから組む：出荷待ち＋部品で組める台数（上限まで）", () => {
    expect(fbmListingQty({ ...base, policy: "to_order" }).qty).toBe(4);
    expect(fbmListingQty({ ...base, policy: "to_order", buildable: 1 }).qty).toBe(3);
    expect(fbmListingQty({ ...base, policy: "to_order", ready: 0, buildable: 0 }).qty).toBe(0);
    expect(fbmListingQty({ ...base, policy: "to_order", maxToOrder: 0 }).qty).toBe(2);
  });

  it("両方の機種は、FBA に在庫があるあいだ 0。切れたら（まだ取り込んでいなければ）自社出荷の数", () => {
    expect(fbmListingQty({ ...base, fulfillment: "both", fbaFulfillable: 3 })).toMatchObject({ qty: 0, why: expect.stringContaining("FBA 3台") });
    expect(fbmListingQty({ ...base, fulfillment: "both", fbaFulfillable: 0 }).qty).toBe(2);
    expect(fbmListingQty({ ...base, fulfillment: "both", fbaFulfillable: null }).qty).toBe(2);
  });
});

describe("部品で組める台数", () => {
  it("必ず付ける枠ごとの在庫を、1台に要る数で割った最小", () => {
    expect(
      buildableFromParts([
        { required: true, anyPart: false, qty: 1, inStock: 5 }, // GPU
        { required: true, anyPart: false, qty: 2, inStock: 5 }, // メモリ 2枚ずつ → 2台
        { required: false, anyPart: false, qty: 1, inStock: 0 }, // 付けなくてもよい
        { required: true, anyPart: true, qty: 1, inStock: 0 }, // 自由枠
      ]),
    ).toBe(2);
  });

  it("必ず付ける枠がなければ 0（構成表ができていない）", () => {
    expect(buildableFromParts([])).toBe(0);
    expect(buildableFromParts([{ required: false, anyPart: false, qty: 1, inStock: 9 }])).toBe(0);
  });
});

describe("作り置きの不足", () => {
  it("出荷待ち＋組立中が目標に足りない数。注文を受けてから組む機種は 0", () => {
    expect(stockShortage("stock", 3, 1)).toBe(2);
    expect(stockShortage("stock", 3, 5)).toBe(0);
    expect(stockShortage("to_order", 3, 0)).toBe(0);
  });
});
