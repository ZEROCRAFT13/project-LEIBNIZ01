// FBA 納品の入力の確かめと集計（DBを使わない）
import { describe, expect, it } from "vitest";
import {
  missingForShip,
  normalizeAmazonShipmentId,
  normalizeTracking,
  parseReceipts,
  parseShipmentInfo,
  summarizeBySku,
} from "@/lib/fba-calc";

describe("番号をそろえる", () => {
  it("Amazon の出荷の番号は全角・小文字・空白を直す", () => {
    expect(normalizeAmazonShipmentId(" ｆｂａ１５ abcd1234 ")).toBe("FBA15ABCD1234");
  });

  it("送り状番号は空白を取り、全角のハイフンや長音は - にする", () => {
    expect(normalizeTracking(" ４５６７ー８９０１－２３４５ ")).toBe("4567-8901-2345");
    expect(normalizeTracking("456789012345")).toBe("456789012345");
  });
});

describe("納品の見出し", () => {
  it("下書きのうちは空でもよい", () => {
    expect(parseShipmentInfo({})).toEqual({
      ok: true,
      value: { amazonShipmentId: null, destinationFc: null, carrier: null, note: null },
    });
  });

  it("番号・倉庫・運送会社をそろえて受け取る", () => {
    expect(parseShipmentInfo({ amazonShipmentId: "fba15abcd1234", destinationFc: "nrt5", carrier: "yamato", note: " 2箱 " })).toEqual({
      ok: true,
      value: { amazonShipmentId: "FBA15ABCD1234", destinationFc: "NRT5", carrier: "yamato", note: "2箱" },
    });
  });

  it("形のちがうものは止める", () => {
    const r = parseShipmentInfo({ amazonShipmentId: "15ABCD", destinationFc: "成田", carrier: "kuroneko" });
    expect(r.ok ? [] : r.errors).toEqual([
      "Amazon の出荷の番号は「FBA」で始まる英数字です（例 FBA15ABCD1234）。",
      "納品先の倉庫は英数字3〜5文字です（例 NRT5）。",
      "運送会社を選び直してください。",
    ]);
  });
});

describe("発送の前に足りないもの", () => {
  it("個体・Amazon の番号・出荷待ちでない個体", () => {
    expect(missingForShip({ amazonShipmentId: null, unitCount: 0, notReady: 0 })).toEqual([
      "個体が1台も入っていません",
      "Amazon の出荷の番号（FBA15…）が入っていません",
    ]);
    expect(missingForShip({ amazonShipmentId: "FBA15ABCD1234", unitCount: 3, notReady: 1 })).toEqual([
      "出荷待ちでない個体が 1台 入っています",
    ]);
    expect(missingForShip({ amazonShipmentId: "FBA15ABCD1234", unitCount: 3, notReady: 0 })).toEqual([]);
  });
});

describe("機種ごとの台数と受領数", () => {
  const units = [
    { skuId: 2, skuCode: "ZB-G5070-R7" },
    { skuId: 1, skuCode: "ZB-G5060-R5" },
    { skuId: 1, skuCode: "ZB-G5060-R5" },
  ];

  it("送った台数を数え、受領数を並べる", () => {
    const s = summarizeBySku(units, [{ skuId: 1, receivedQty: 2 }]);
    expect(s).toEqual({
      rows: [
        { skuId: 1, skuCode: "ZB-G5060-R5", sent: 2, received: 2 },
        { skuId: 2, skuCode: "ZB-G5070-R7", sent: 1, received: 0 },
      ],
      sent: 3,
      received: 2,
      allReceived: false,
    });
    expect(summarizeBySku(units, [{ skuId: 1, receivedQty: 2 }, { skuId: 2, receivedQty: 1 }]).allReceived).toBe(true);
    expect(summarizeBySku([], []).allReceived).toBe(false);
  });

  it("受領数は 0〜送った台数の整数。空欄はそのまま", () => {
    const { rows } = summarizeBySku(units, []);
    expect(parseReceipts({ received_1: "２", received_2: "" }, rows)).toEqual({ ok: true, value: [{ skuId: 1, receivedQty: 2 }] });
    const r = parseReceipts({ received_1: "3", received_2: "x" }, rows);
    expect(r.ok ? [] : r.errors).toEqual([
      "ZB-G5060-R5 の受領数（3）が、送った台数（2）より多くなっています。",
      "ZB-G5070-R7 の受領数は数字で入れてください。",
    ]);
  });
});
