// 注文確認メールの読み取り（金額の検算もふくむ。お金の計算なのでテストする: ルール10）
import { describe, expect, it } from "vitest";
import { dosparaMail } from "@/test/mail-fixtures";
import { itemKey, parseOrderMail, splitLineTotal } from "./order-mail";

describe("ドスパラの「ご注文確定のお知らせ」", () => {
  it("注文番号・注文日・支払い方法・明細・合計を読み取る", () => {
    const r = parseOrderMail(dosparaMail({}));
    expect(r).toEqual({
      parser: "dospara",
      supplierName: "ドスパラ",
      orderNo: "EC0000000001",
      orderedOn: "2026-10-30",
      paymentMethod: "card",
      total: 88900,
      lines: [
        { description: "メーカーC B850 ATX (B850 AM5 ATX)", unitPrice: 24980, qty: 2, lineTotal: 49960, kind: "item" },
        { description: "メーカーS NV4-1TB (NVMe Gen4 1TB)", unitPrice: 12980, qty: 3, lineTotal: 38940, kind: "item" },
      ],
      issues: [],
    });
  });

  it("宛名や住所は読み取った項目に入らない", () => {
    const r = JSON.stringify(parseOrderMail(dosparaMail({})));
    expect(r).not.toContain("見本 太郎");
    expect(r).not.toContain("大阪府");
  });

  it("送料があれば「部品以外」の行にする", () => {
    const r = parseOrderMail(dosparaMail({ shipping: 880 }));
    expect(r?.lines.at(-1)).toEqual({ description: "送料", qty: 1, unitPrice: 880, lineTotal: 880, kind: "fee" });
    expect(r?.total).toBe(89780);
    expect(r?.issues).toEqual([]);
  });

  it("明細の合計がメールの合計と合わなければ、気になる点に出す（値引き・ポイントなど）", () => {
    const r = parseOrderMail(dosparaMail({ total: 87900 }));
    expect(r?.issues).toEqual([
      "明細の合計（88,900円）がメールの合計（87,900円）と合いません。値引きやポイントの行がないか確かめてください。",
    ]);
  });

  it("単価と数量が同じ行に書いてあっても読める。日付の桁が1つでも読める", () => {
    const text = dosparaMail({ date: "2026/1/5" }).replace("(B850 AM5 ATX)\r\n単価", "(B850 AM5 ATX) 単価");
    const r = parseOrderMail(text);
    expect(r?.orderedOn).toBe("2026-01-05");
    expect(r?.lines[0]).toMatchObject({ description: "メーカーC B850 ATX (B850 AM5 ATX)", qty: 2, lineTotal: 49960 });
  });

  it("振込・代引きの支払いも見分ける", () => {
    expect(parseOrderMail(dosparaMail({ payment: "銀行振込" }))?.paymentMethod).toBe("bank");
    expect(parseOrderMail(dosparaMail({ payment: "代金引換" }))?.paymentMethod).toBe("cod");
  });

  it("全角の数字やコロンでも読める", () => {
    const r = parseOrderMail(dosparaMail({}).replace("EC0000000001", "ＥＣ０００００００００１"));
    expect(r?.orderNo).toBe("EC0000000001");
  });

  it("明細が読めなければ、そのことを気になる点に出す", () => {
    const r = parseOrderMail("ドスパラ\n【ご注文番号】 EC0000000002\n【受注日】 2026/10/30\n税込金額： 1,000円");
    expect(r?.issues).toContain("商品の明細が読み取れませんでした。");
  });

  it("ほかのショップのメールは読まない", () => {
    expect(parseOrderMail("Amazon.co.jp ご注文の確認 注文番号 249-0000000-0000000")).toBeNull();
    expect(parseOrderMail("")).toBeNull();
  });
});

describe("商品名をそろえる（型番の対応を覚える鍵）", () => {
  it("全角・大文字小文字・空白のちがいを気にしない", () => {
    expect(itemKey("ＡＳＲｏｃｋ  H610M-HVS")).toBe(itemKey("asrock h610m-hvs"));
  });
});

describe("金額を数量で割り切れないとき", () => {
  it.each([
    [33657, 5, [{ qty: 3, unitPrice: 6731 }, { qty: 2, unitPrice: 6732 }]],
    [11599, 6, [{ qty: 5, unitPrice: 1933 }, { qty: 1, unitPrice: 1934 }]],
    [224400, 30, [{ qty: 30, unitPrice: 7480 }]],
    [0, 2, [{ qty: 2, unitPrice: 0 }]],
  ])("%i円 ÷ %i個 → %o", (total, qty, expected) => {
    const parts = splitLineTotal(total, qty);
    expect(parts).toEqual(expected);
    expect(parts.reduce((s, p) => s + p.qty * p.unitPrice, 0)).toBe(total);
    expect(parts.reduce((s, p) => s + p.qty, 0)).toBe(qty);
  });

  it("どの組み合わせでも、合計と個数がぴったり合う", () => {
    for (let total = 0; total < 400; total += 7) {
      for (let qty = 1; qty <= 12; qty++) {
        const parts = splitLineTotal(total, qty);
        expect(parts.reduce((s, p) => s + p.qty * p.unitPrice, 0)).toBe(total);
        expect(parts.reduce((s, p) => s + p.qty, 0)).toBe(qty);
      }
    }
  });

  it("おかしな値は断る", () => {
    expect(() => splitLineTotal(100, 0)).toThrow();
    expect(() => splitLineTotal(-1, 1)).toThrow();
    expect(() => splitLineTotal(1.5, 1)).toThrow();
  });
});
