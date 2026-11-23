// FBA の補充の計算（DB を使わない）
import { describe, expect, it } from "vitest";
import { addDays, diffDays, fbaQuantities, restockPlan } from "@/lib/fba-restock-calc";

const s = { leadDays: 10, windowDays: 14, coverDays: 30, warnDays: 3 };
const today = "2026-11-23";

describe("組立を始める期限", () => {
  it("1日1台売れて、在庫が20台なら：20日でなくなり、その10日前が期限。補充の目安は40−20＝20台", () => {
    expect(restockPlan({ fulfillable: 15, inbound: 5, soldInWindow: 14, today }, s)).toEqual({
      supply: 20,
      perDay: 1,
      daysLeft: 20,
      stockoutDate: "2026-12-13",
      startBy: "2026-12-03",
      suggestQty: 20,
      level: "ok",
    });
  });

  it("期限が3日以内なら「もうすぐ」、今日か過ぎていたら「今すぐ」", () => {
    expect(restockPlan({ fulfillable: 13, inbound: 0, soldInWindow: 14, today }, s)).toMatchObject({ startBy: "2026-11-26", level: "soon" });
    expect(restockPlan({ fulfillable: 14, inbound: 0, soldInWindow: 14, today }, s)).toMatchObject({ startBy: "2026-11-27", level: "ok" });
    expect(restockPlan({ fulfillable: 10, inbound: 0, soldInWindow: 14, today }, s)).toMatchObject({ startBy: today, level: "late" });
    expect(restockPlan({ fulfillable: 0, inbound: 0, soldInWindow: 14, today }, s)).toMatchObject({
      daysLeft: 0,
      startBy: "2026-11-13",
      level: "late",
      suggestQty: 40,
    });
  });

  it("残り日数は切り捨て、補充の目安は切り上げ。1日の販売ペースは小数2けたで見せる", () => {
    const p = restockPlan({ fulfillable: 5, inbound: 0, soldInWindow: 12, today }, s); // 1日 0.857…台
    expect(p).toMatchObject({ perDay: 0.86, daysLeft: 5, stockoutDate: "2026-11-28" });
    expect(p.suggestQty).toBe(Math.ceil((12 / 14) * 40 - 5)); // 30
  });

  it("売れていなければ期限は出さない。補充の目安も 0", () => {
    expect(restockPlan({ fulfillable: 3, inbound: 2, soldInWindow: 0, today }, s)).toEqual({
      supply: 5,
      perDay: 0,
      daysLeft: null,
      stockoutDate: null,
      startBy: null,
      suggestQty: 0,
      level: "no_sales",
    });
  });

  it("在庫が十分なら補充の目安は 0", () => {
    expect(restockPlan({ fulfillable: 100, inbound: 0, soldInWindow: 14, today }, s).suggestQty).toBe(0);
  });

  it("日付の足し引き（月・年をまたぐ）", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffDays("2026-11-23", "2026-12-03")).toBe(10);
  });
});

describe("FBA の在庫の数の読み方", () => {
  it("入庫中＝作業中・輸送中・受領中・倉庫の処理中・倉庫の移動中。売れて出荷待ちは別に数える", () => {
    expect(
      fbaQuantities({
        sellerSku: "X",
        inventoryDetails: {
          fulfillableQuantity: 7,
          inboundWorkingQuantity: 1,
          inboundShippedQuantity: 2,
          inboundReceivingQuantity: 3,
          reservedQuantity: { totalReservedQuantity: 9, pendingCustomerOrderQuantity: 4, fcProcessingQuantity: 2, pendingTransshipmentQuantity: 3 },
          unfulfillableQuantity: { totalUnfulfillableQuantity: 1 },
        },
      }),
    ).toEqual({ fulfillable: 7, inbound: 11, reserved: 4, unfulfillable: 1 });
  });

  it("欠けている・おかしな値は 0 として読む", () => {
    expect(fbaQuantities({ sellerSku: "X" })).toEqual({ fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0 });
    expect(fbaQuantities({ inventoryDetails: { fulfillableQuantity: -3, inboundShippedQuantity: 1.5 } })).toEqual({
      fulfillable: 0,
      inbound: 0,
      reserved: 0,
      unfulfillable: 0,
    });
  });
});
