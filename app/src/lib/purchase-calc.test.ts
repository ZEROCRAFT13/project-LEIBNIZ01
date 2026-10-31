// 仕入れの金額の計算と入力の確かめ（お金の計算なので必ずテストする: CLAUDE.md ルール10）
import { describe, expect, it } from "vitest";
import {
  isTrackingNo,
  normalizeBoxLocation,
  normalizeTracking,
  parsePurchaseInput,
  purchaseTotals,
  splitTax10,
} from "./purchase-calc";

describe("税込価格を税抜と消費税に分ける（10%）", () => {
  it.each([
    [98780, 89800, 8980],
    [52800, 48000, 4800],
    [110, 100, 10],
    [100, 91, 9], // 90.909… → 91
    [105, 95, 10], // 95.45… → 95
    [1, 1, 0],
    [0, 0, 0],
  ])("%i円 → 税抜 %i円 ＋ 税 %i円", (price, excl, tax) => {
    expect(splitTax10(price)).toEqual({ excl, tax });
    expect(excl + tax).toBe(price);
  });

  it("どの金額でも、税抜と税を足すと元の価格になる", () => {
    for (let p = 0; p < 5000; p++) {
      const { excl, tax } = splitTax10(p);
      expect(excl + tax).toBe(p);
      expect(tax).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("仕入れの合計", () => {
  it("数量×単価を足し、消費税は合計から1回だけ計算する（明細ごとの端数を積み上げない）", () => {
    const lines = [
      { qty: 2, unitPrice: 98780 },
      { qty: 1, unitPrice: 52800 },
      { qty: 1, unitPrice: 105 },
    ];
    expect(purchaseTotals(lines)).toEqual({ total: 250465, tax: 22770 });
    // 明細ごとに計算して足すと 8980×2 + 4800 + 10 = 22770（この例では同じ）。合計から1回で出す
    expect(purchaseTotals([{ qty: 3, unitPrice: 105 }])).toEqual({ total: 315, tax: 29 });
  });

  it("明細がなければ0円", () => {
    expect(purchaseTotals([])).toEqual({ total: 0, tax: 0 });
  });
});

describe("仕入れの入力を確かめる", () => {
  const today = "2026-11-01";
  const good = {
    supplierId: "2",
    orderNo: " ds-88120 ",
    orderedOn: "2026-10-30",
    paymentMethod: "card",
    tax: "",
    lines: [
      { partModelId: "3", description: "", qty: "2", unitPrice: "98,780" },
      { partModelId: null, description: "送料", qty: "1", unitPrice: "５５０" },
    ],
  };

  it("正しい入力は、合計を明細から計算し直し、消費税が空なら自動で入れる", () => {
    const r = parsePurchaseInput(good, today);
    expect(r).toEqual({
      ok: true,
      value: {
        supplierId: 2,
        orderNo: "ds-88120",
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        lines: [
          { partModelId: 3, description: "", qty: 2, unitPrice: 98780 },
          { partModelId: null, description: "送料", qty: 1, unitPrice: 550 },
        ],
        total: 198110,
        tax: 18010,
      },
    });
  });

  it("領収書の消費税を入れたら、その値を使う", () => {
    const r = parsePurchaseInput({ ...good, tax: "18,009" }, today);
    expect(r.ok && r.value.tax).toBe(18009);
  });

  it("注文番号が空なら null", () => {
    const r = parsePurchaseInput({ ...good, orderNo: "  " }, today);
    expect(r.ok && r.value.orderNo).toBeNull();
  });

  it.each([
    [{ supplierId: "" }, "仕入先を選んでください。"],
    [{ orderedOn: "2026-02-30" }, "注文日を正しく入れてください。"],
    [{ orderedOn: "2026-11-02" }, "注文日が未来になっています。"],
    [{ paymentMethod: "bitcoin" }, "支払い方法を選んでください。"],
    [{ lines: [] }, "明細を1行以上入れてください。"],
    [{ tax: "abc" }, "うち消費税は円の数字で入れてください（空なら自動で計算します）。"],
    [{ tax: "999999" }, "うち消費税が合計より大きくなっています。"],
    [
      { lines: [{ partModelId: null, description: "送料", qty: "1", unitPrice: "550" }] },
      "部品の明細が1行もありません（送料だけの仕入れは登録できません）。",
    ],
    [{ lines: [{ partModelId: "none", description: "", qty: "1", unitPrice: "1" }] }, "1行目：部品を選んでください。"],
    [{ lines: [{ partModelId: null, description: " ", qty: "1", unitPrice: "1" }] }, "1行目：部品以外（送料など）は内容を書いてください。"],
    [{ lines: [{ partModelId: "3", description: "", qty: "0", unitPrice: "1" }] }, "1行目：数量は1〜999にしてください。"],
    [{ lines: [{ partModelId: "3", description: "", qty: "1.5", unitPrice: "1" }] }, "1行目：数量は1〜999にしてください。"],
    [{ lines: [{ partModelId: "3", description: "", qty: "1", unitPrice: "-100" }] }, "1行目：単価（税込）を円で入れてください。"],
    [{ lines: [{ partModelId: "3", description: "", qty: "1", unitPrice: "" }] }, "1行目：単価（税込）を円で入れてください。"],
  ])("%o → 「%s」", (patch, message) => {
    const r = parsePurchaseInput({ ...good, ...patch }, today);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toContain(message);
  });

  it("部品を選んでいない行は、そのことだけを知らせる（送料の注意を重ねて出さない）", () => {
    const r = parsePurchaseInput({ ...good, lines: [{ partModelId: "none", description: "", qty: "1", unitPrice: "1" }] }, today);
    expect(!r.ok && r.errors).toEqual(["1行目：部品を選んでください。", "部品の明細が1行もありません（送料だけの仕入れは登録できません）。"]);
  });

  it("明細が多すぎると断る", () => {
    const lines = Array.from({ length: 51 }, () => ({ partModelId: "3", description: "", qty: "1", unitPrice: "1" }));
    const r = parsePurchaseInput({ ...good, lines }, today);
    expect(!r.ok && r.errors).toContain("明細は50行までです。");
  });

  it("明細が配列でないなど、壊れた入力でも落ちずに断る", () => {
    expect(parsePurchaseInput({ ...good, lines: "x" }, today).ok).toBe(false);
    expect(parsePurchaseInput({ ...good, lines: [null] }, today).ok).toBe(false);
  });
});

describe("元箱の棚番", () => {
  it.each([
    ["b-07", "B-07"],
    ["Ｂ－０７", "B-07"],
    [" B ー 07 ", "B-07"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeBoxLocation(raw)).toBe(expected);
  });
});

describe("追跡番号をそろえる", () => {
  it.each([
    ["1234-5678-9012", "123456789012"],
    ["１２３４ ５６７８ ９０１２", "123456789012"],
    ["a123456789012a", "123456789012"], // 送り状のバーコード（Codabar）の前後の文字
    ["D123456789012B", "123456789012"],
    ["tba-123456789", "TBA123456789"],
    ["AB12", "AB12"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeTracking(raw)).toBe(expected);
  });

  it("追跡番号として使える形か", () => {
    expect(isTrackingNo("123456789012")).toBe(true);
    expect(isTrackingNo("12345")).toBe(false);
    expect(isTrackingNo("1234-5678")).toBe(false);
  });
});
