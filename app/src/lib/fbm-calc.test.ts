// 自社出荷の入力の確かめ（DBを使わない）
import { describe, expect, it } from "vitest";
import { isAmazonOrderNo, missingForFbmShip, normalizeAmazonOrderNo, parseFbmOrderInput } from "@/lib/fbm-calc";

const now = new Date("2026-11-01T09:00:00+09:00");
const ok = { orderNo: "503-1234567-1234567", orderedAt: "2026-11-01T08:30", skuId: "3", qty: "1", totalAmount: "429,800" };

describe("注文番号", () => {
  it("全角・空白・長音のハイフンを直す", () => {
    expect(normalizeAmazonOrderNo(" ５０３ー１２３４５６７－１２３４５６７ ")).toBe("503-1234567-1234567");
    expect(isAmazonOrderNo("503-1234567-1234567")).toBe(true);
    expect(isAmazonOrderNo("503-1234567-1234")).toBe(false);
  });
});

describe("注文の登録", () => {
  it("日本時間の注文日時・円の整数で受け取る", () => {
    expect(parseFbmOrderInput({ ...ok, shipBy: "2026-11-03", note: " 急ぎ " }, now)).toEqual({
      ok: true,
      value: {
        orderNo: "503-1234567-1234567",
        orderedAt: new Date("2026-10-31T23:30:00Z"),
        shipBy: "2026-11-03",
        skuId: 3,
        qty: 1,
        totalAmount: 429800,
        note: "急ぎ",
      },
    });
  });

  it("足りない・おかしな入力は止める", () => {
    const r = parseFbmOrderInput({ orderNo: "503-123", orderedAt: "", skuId: "", qty: "0", totalAmount: "abc", shipBy: "11/3" }, now);
    expect(r.ok ? [] : r.errors).toEqual([
      "注文番号は「3けた-7けた-7けた」の数字です（例 503-1234567-1234567）。",
      "注文日時を入れてください。",
      "出荷期限は日付で入れてください。",
      "機種を選んでください。",
      "数は1〜10台で入れてください。",
      "注文の合計（税込）を円の数字で入れてください。",
    ]);
  });

  it("未来の注文日時と、数で割り切れない合計は止める", () => {
    const r = parseFbmOrderInput({ ...ok, orderedAt: "2026-11-02T09:00", qty: "3", totalAmount: "1000" }, now);
    expect(r.ok ? [] : r.errors).toEqual([
      "注文日時が未来になっています。",
      "合計が数で割り切れません。1台あたりの金額が分かるように、注文の合計をそのまま入れてください。",
    ]);
  });
});

describe("発送の前に足りないもの", () => {
  it("個体・送り状番号・運送会社", () => {
    expect(missingForFbmShip({ qty: 2, linked: 1, withoutTracking: 1, carrier: null })).toEqual([
      "個体があと 1台 足りません（管理番号を読んでください）",
      "送り状番号が入っていない箱が 1つ あります",
      "運送会社を選んでください",
    ]);
    expect(missingForFbmShip({ qty: 1, linked: 1, withoutTracking: 0, carrier: "yamato" })).toEqual([]);
  });
});
