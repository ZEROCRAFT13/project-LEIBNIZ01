// 自社出荷の入力の確かめ（DBを使わない）
import { describe, expect, it } from "vitest";
import { AMAZON_CARRIER_CODES, buildShipPackages, isAmazonOrderNo, missingForFbmShip, normalizeAmazonOrderNo, parseFbmOrderInput } from "@/lib/fbm-calc";

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

describe("Amazon への出荷通知の中身", () => {
  const units = [
    { mgmtNo: "ZB-2611-0001", skuId: 1, trackingNo: "1111-2222-3333" },
    { mgmtNo: "ZB-2611-0002", skuId: 1, trackingNo: "4444-5555-6666" },
    { mgmtNo: "ZB-2611-0003", skuId: 2, trackingNo: "4444-5555-6666" },
  ];
  const items = [
    { orderItemId: "A1", sellerSku: "X-FBM", skuId: 1, quantity: 2 },
    { orderItemId: "B1", sellerSku: "Y-FBM", skuId: 2, quantity: 1 },
  ];

  it("運送会社は Amazon の決まった配送業者コードにする。ほかの運送会社はこの画面から送らない", () => {
    expect(AMAZON_CARRIER_CODES.yamato).toBe("Yamato Transport");
    expect(AMAZON_CARRIER_CODES.sagawa).toBe("Sagawa Express");
    expect(AMAZON_CARRIER_CODES.japanpost).toBe("Japan Post");
    expect(AMAZON_CARRIER_CODES.seino).toBeUndefined();
    expect(AMAZON_CARRIER_CODES.other).toBeUndefined();
  });

  it("送り状番号ごとに1箱にまとめ、明細の番号と数を入れる。箱の番号は送り状番号が出てきた順", () => {
    expect(buildShipPackages(units, items)).toEqual({
      ok: true,
      packages: [
        { packageReferenceId: "1", trackingNumber: "1111-2222-3333", mgmtNos: ["ZB-2611-0001"], orderItems: [{ orderItemId: "A1", quantity: 1 }] },
        {
          packageReferenceId: "2",
          trackingNumber: "4444-5555-6666",
          mgmtNos: ["ZB-2611-0002", "ZB-2611-0003"],
          orderItems: [
            { orderItemId: "A1", quantity: 1 },
            { orderItemId: "B1", quantity: 1 },
          ],
        },
      ],
    });
  });

  it("同じ機種の明細が2つあれば、上から順に詰める。取り消された明細（数0）は使わない", () => {
    const r = buildShipPackages(units.slice(0, 2), [
      { orderItemId: "C0", sellerSku: "X-FBM", skuId: 1, quantity: 0 },
      { orderItemId: "A1", sellerSku: "X-FBM", skuId: 1, quantity: 1 },
      { orderItemId: "A2", sellerSku: "X-FBM", skuId: 1, quantity: 1 },
    ]);
    expect(r.ok && r.packages.map((p) => p.orderItems)).toEqual([[{ orderItemId: "A1", quantity: 1 }], [{ orderItemId: "A2", quantity: 1 }]]);
  });

  it("Amazon の注文と、結びついた個体の数が機種ごとに合わなければ送らない", () => {
    expect(buildShipPackages(units.slice(0, 2), items)).toMatchObject({ ok: false, errors: [expect.stringContaining("合わない")] });
    expect(buildShipPackages(units, [{ ...items[0], quantity: 3 }, items[1]])).toMatchObject({ ok: false });
  });

  it("出品が未登録の明細・送り状番号のない箱があれば送らない", () => {
    expect(buildShipPackages(units, [items[0], { ...items[1], skuId: null }])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("Y-FBM")]),
    });
    expect(buildShipPackages([{ ...units[0], trackingNo: null }], [{ ...items[0], quantity: 1 }])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("送り状番号")],
    });
  });

  it("同じ注文なら何度作っても同じ箱の番号になる（送り直すと Amazon 側で同じ箱が直る）", () => {
    expect(buildShipPackages(units, items)).toEqual(buildShipPackages(units, items));
  });
});
