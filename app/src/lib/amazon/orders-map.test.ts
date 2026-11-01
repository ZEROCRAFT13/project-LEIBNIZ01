// SP-API の注文の読み取り（DBを使わない）
import { describe, expect, it } from "vitest";
import { jstDate, mapOrder, syncWindowFrom, yenFromMoney } from "@/lib/amazon/orders-map";
import { fakeOrder } from "@/test/amazon-fixtures";

describe("金額と日付", () => {
  it("円の整数だけを受け取る", () => {
    expect(yenFromMoney({ amount: "349800.00", currencyCode: "JPY" })).toBe(349800);
    expect(yenFromMoney({ amount: "349800", currencyCode: "JPY" })).toBe(349800);
    expect(yenFromMoney({ amount: "349800.50", currencyCode: "JPY" })).toBeNull();
    expect(yenFromMoney({ amount: "100.00", currencyCode: "USD" })).toBeNull();
    expect(yenFromMoney({ amount: "-1", currencyCode: "JPY" })).toBeNull();
    expect(yenFromMoney(undefined)).toBeNull();
  });

  it("出荷期限は日本の日付にする（UTC の 14:59 は日本の 23:59）", () => {
    expect(jstDate("2026-11-03T14:59:59Z")).toBe("2026-11-03");
    expect(jstDate("2026-11-03T15:00:00Z")).toBe("2026-11-04");
    expect(jstDate("x")).toBeNull();
  });
});

describe("注文を読む", () => {
  it("使う項目だけを取り出し、合計を計算する", () => {
    const r = mapOrder(
      fakeOrder({
        orderId: "503-1000000-0000001",
        items: [
          { sellerSku: "ZB-G5070-R7-FBM", qty: 2, unitPrice: "349800.00" },
          { sellerSku: "ZB-MOUSE", qty: 1, unitPrice: "1980.00" },
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      order: {
        orderNo: "503-1000000-0000001",
        createdAt: new Date("2026-11-01T01:00:00Z"),
        updatedAt: new Date("2026-11-01T01:05:00Z"),
        status: "UNSHIPPED",
        merchantFulfilled: true,
        shipBy: "2026-11-03",
        lines: [
          { sellerSku: "ZB-G5070-R7-FBM", asin: "B0ZBDUMMY2", qty: 2, unitPrice: 349800 },
          { sellerSku: "ZB-MOUSE", asin: "B0ZBDUMMY2", qty: 1, unitPrice: 1980 },
        ],
        total: 701580,
      },
    });
  });

  it("お客様の情報が混ざっていても、取り出さない", () => {
    const raw = { ...fakeOrder({ orderId: "503-1000000-0000002" }), buyer: { buyerName: "見本 太郎" }, recipient: { deliveryAddress: { city: "見本市" } } };
    const r = mapOrder(raw);
    expect(JSON.stringify(r)).not.toContain("見本");
  });

  it("数が0の明細（取り消された明細）は飛ばす", () => {
    const r = mapOrder(fakeOrder({ orderId: "503-1000000-0000003", items: [{ sellerSku: "A", qty: 0, unitPrice: "1.00" }] }));
    expect(r.ok && r.order.lines).toEqual([]);
  });

  it("読めないものは理由をつけて断る", () => {
    expect(mapOrder(fakeOrder({ orderId: "S01-123" }))).toMatchObject({ ok: false, orderNo: null });
    expect(mapOrder(fakeOrder({ orderId: "503-1000000-0000004", status: "WHATEVER" }))).toMatchObject({ ok: false, reason: "注文の状態が読めない" });
    expect(mapOrder(fakeOrder({ orderId: "503-1000000-0000005", items: [{ sellerSku: "A", qty: 1, unitPrice: "10.5" }] }))).toMatchObject({
      ok: false,
      reason: "単価が円の整数で読めない",
    });
    expect(mapOrder({ ...fakeOrder({ orderId: "503-1000000-0000006" }), salesChannel: { marketplaceId: "ATVPDKIKX0DER" } })).toMatchObject({
      ok: false,
      reason: "日本以外のマーケットプレイスの注文",
    });
  });

  it("出荷期限がなければ null、FBA の注文は印を付ける", () => {
    const r = mapOrder(fakeOrder({ orderId: "503-1000000-0000007", shipBy: null, fulfilledBy: "AMAZON" }));
    expect(r.ok && r.order).toMatchObject({ shipBy: null, merchantFulfilled: false });
  });
});

describe("取り込む期間", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  it("前回の続き（10分重ねる）。はじめては24時間前から。照合は7日前から", () => {
    expect(syncWindowFrom("incremental", new Date("2026-11-01T23:55:00Z"), now).toISOString()).toBe("2026-11-01T23:45:00.000Z");
    expect(syncWindowFrom("incremental", null, now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(syncWindowFrom("reconcile", new Date(), now).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(syncWindowFrom("manual", null, now).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});
