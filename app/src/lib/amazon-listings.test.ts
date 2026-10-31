// 機種ごとの Amazon の出荷方法と出品（セラー SKU・ASIN）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { neededListings, normalizeAsin, normalizeSellerSku, parseAmazonInput, parseSkuInput } from "@/lib/sku-calc";
import { createSku, getSkuDetail, listSkusWithSummary, setAmazonListings } from "@/lib/skus";

let owner: number;
let skuId: number;

const input = (raw: Record<string, unknown>) => {
  const r = parseAmazonInput(raw);
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
};

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  const s = parseSkuInput({ code: "ZB-G5070TI-R7", name: "ゲーミングPC RTX 5070 Ti / Ryzen 7" });
  if (!s.ok) throw new Error();
  const r = await createSku(owner, s.value, null);
  if (!r.ok) throw new Error(r.message);
  skuId = r.id;
});

afterAll(async () => {
  await getPool().end();
});

describe("入力の確かめ（DBなし）", () => {
  it("出荷方法ごとに要る出品", () => {
    expect(neededListings("fba")).toEqual(["fba"]);
    expect(neededListings("fbm")).toEqual(["fbm"]);
    expect(neededListings("both")).toEqual(["fba", "fbm"]);
    expect(neededListings(null)).toEqual([]);
  });

  it("全角で入れても半角にする。ASIN は大文字、セラー SKU の大文字・小文字はそのまま", () => {
    expect(normalizeAsin(" ｂ０ｚｂｄｕｍｍｙ１ ")).toBe("B0ZBDUMMY1");
    expect(normalizeSellerSku(" ＺＢ-g5070-FBA ")).toBe("ZB-g5070-FBA");
  });

  it("出品はセラー SKU と ASIN の両方か、両方空", () => {
    expect(input({ fulfillment: "fba", fbaSellerSku: "ZB-1", fbaAsin: "b0zbdummy1" })).toEqual({
      fulfillment: "fba",
      fba: { sellerSku: "ZB-1", asin: "B0ZBDUMMY1" },
      fbm: null,
    });
    expect(input({ fulfillment: "none" })).toEqual({ fulfillment: null, fba: null, fbm: null });
    const r = parseAmazonInput({ fulfillment: "both", fbaSellerSku: "ZB 1", fbmAsin: "B0" });
    expect(r.ok ? [] : r.errors).toEqual([
      "FBA 用のセラー SKU は、半角の英数字と記号（空白なし）で40文字までにしてください。",
      "FBA 用の ASIN は、英数字10文字で入れてください（例 B0XXXXXXXX）。",
      "自社出荷用のセラー SKU は、半角の英数字と記号（空白なし）で40文字までにしてください。",
      "自社出荷用の ASIN は、英数字10文字で入れてください（例 B0XXXXXXXX）。",
    ]);
  });

  it("FBA 用と自社出荷用に同じセラー SKU は使えない。出荷方法は決まった値だけ", () => {
    const r = parseAmazonInput({
      fulfillment: "both",
      fbaSellerSku: "ZB-1",
      fbaAsin: "B0ZBDUMMY1",
      fbmSellerSku: "ZB-1",
      fbmAsin: "B0ZBDUMMY1",
    });
    expect(r.ok ? [] : r.errors).toEqual(["FBA 用と自社出荷用には、別のセラー SKU を使ってください。"]);
    expect(parseAmazonInput({ fulfillment: "amazon" }).ok).toBe(false);
  });
});

describe("保存（ダミーデータの DB）", () => {
  it("作ったばかりの機種は Amazon で売らない", async () => {
    expect(await getSkuDetail(skuId)).toMatchObject({ amazonFulfillment: null, missingListings: 0, listings: [] });
  });

  it("自社出荷にして、出品を登録する前は「未登録」が数えられる", async () => {
    expect(await setAmazonListings(owner, skuId, input({ fulfillment: "fbm" }))).toMatchObject({ ok: true });
    expect((await listSkusWithSummary()).find((s) => s.id === skuId)).toMatchObject({
      amazonFulfillment: "fbm",
      missingListings: 1,
    });
  });

  it("出品を登録すると「未登録」がなくなる。同じ内容で保存しても増えない", async () => {
    const v = input({ fulfillment: "fbm", fbmSellerSku: "ZB-G5070TI-R7-FBM", fbmAsin: "B0ZBDUMMY3" });
    await setAmazonListings(owner, skuId, v);
    await setAmazonListings(owner, skuId, v);
    const d = await getSkuDetail(skuId);
    expect(d).toMatchObject({ missingListings: 0 });
    expect(d?.listings).toEqual([
      { id: expect.any(Number), fulfillment: "fbm", sellerSku: "ZB-G5070TI-R7-FBM", asin: "B0ZBDUMMY3", active: true },
    ]);
  });

  it("セラー SKU を変えると、前の出品は止めて新しく登録する（記録が残る）", async () => {
    await setAmazonListings(owner, skuId, input({ fulfillment: "fbm", fbmSellerSku: "ZB-5070TI-FBM", fbmAsin: "B0ZBDUMMY3" }));
    const d = await getSkuDetail(skuId);
    expect(d?.listings.map((l) => [l.sellerSku, l.active])).toEqual([
      ["ZB-5070TI-FBM", true],
      ["ZB-G5070TI-R7-FBM", false],
    ]);
  });

  it("前に止めたセラー SKU に戻すと、その出品を使い直す", async () => {
    await setAmazonListings(owner, skuId, input({ fulfillment: "fbm", fbmSellerSku: "ZB-G5070TI-R7-FBM", fbmAsin: "B0ZBDUMMY3" }));
    const d = await getSkuDetail(skuId);
    expect(d?.listings).toHaveLength(2);
    expect(d?.listings.filter((l) => l.active).map((l) => l.sellerSku)).toEqual(["ZB-G5070TI-R7-FBM"]);
  });

  it("別の機種で使っているセラー SKU は断る", async () => {
    const r = await setAmazonListings(owner, skuId, input({ fulfillment: "fbm", fbmSellerSku: "ZB-G5070-R7-FBA", fbmAsin: "B0ZBDUMMY3" }));
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("もう別の出品で使っています") });
    // 断ったときは何も変わらない
    expect((await getSkuDetail(skuId))?.listings.filter((l) => l.active).map((l) => l.sellerSku)).toEqual(["ZB-G5070TI-R7-FBM"]);
  });

  it("空にして保存すると、その出品を止める。Amazon で売らないにもできる", async () => {
    await setAmazonListings(owner, skuId, input({ fulfillment: "none" }));
    const d = await getSkuDetail(skuId);
    expect(d).toMatchObject({ amazonFulfillment: null, missingListings: 0 });
    expect(d?.listings.every((l) => !l.active)).toBe(true);
  });

  it("ダミーデータ：バリューモデルは FBA、ZB-G5070-R7 は両方", async () => {
    const rows = await listSkusWithSummary();
    expect(rows.find((s) => s.code === "ZB-G5060-R5")).toMatchObject({ amazonFulfillment: "fba", missingListings: 0 });
    expect(rows.find((s) => s.code === "ZB-G5070-R7")).toMatchObject({ amazonFulfillment: "both", missingListings: 0 });
  });
});
