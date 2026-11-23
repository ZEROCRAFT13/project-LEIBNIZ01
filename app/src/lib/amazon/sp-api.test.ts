// SP-API への接続（本物には つながず、fetch をまねる）
import { describe, expect, it } from "vitest";
import { createSpApi, SpApiError, spApiConfigFromEnv } from "@/lib/amazon/sp-api";
import { fakeOrder } from "@/test/amazon-fixtures";

const config = { clientId: "id", clientSecret: "secret", refreshToken: "Atzr|dummy", endpoint: "https://sp.example" };

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: ((url: string) => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r(String(url));
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = json({ access_token: "Atza|access", expires_in: 3600 });

describe("設定", () => {
  it("3つそろっていなければ動かさない", () => {
    expect(spApiConfigFromEnv({ SP_API_CLIENT_ID: "a", SP_API_CLIENT_SECRET: "b" })).toBeNull();
    expect(spApiConfigFromEnv({ SP_API_CLIENT_ID: "a", SP_API_CLIENT_SECRET: "b", SP_API_REFRESH_TOKEN: "c" })).toMatchObject({
      endpoint: "https://sellingpartnerapi-fe.amazon.com",
    });
  });
});

describe("注文を取る", () => {
  it("ログインしてから、自社出荷・日本・出荷の情報つきで問い合わせ、ページをたどる", async () => {
    const { f, calls } = fakeFetch([
      token,
      json({ orders: [fakeOrder({ orderId: "503-1000000-0000001" })], pagination: { nextToken: "NEXT" } }),
      json({ orders: [fakeOrder({ orderId: "503-1000000-0000002" })] }),
    ]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    const orders = await api.searchOrders({ lastUpdatedAfter: new Date("2026-11-01T00:00:00Z"), merchantOnly: true });
    expect(orders.map((o) => o.orderId)).toEqual(["503-1000000-0000001", "503-1000000-0000002"]);

    expect(calls[0].url).toBe("https://api.amazon.com/auth/o2/token");
    expect(String(calls[0].init?.body)).toContain("grant_type=refresh_token");
    const first = new URL(calls[1].url);
    expect(first.pathname).toBe("/orders/2026-01-01/orders");
    expect(first.searchParams.get("marketplaceIds")).toBe("A1VC38T7YXB528");
    expect(first.searchParams.get("fulfilledBy")).toBe("MERCHANT");
    expect(first.searchParams.get("includedData")).toBe("FULFILLMENT"); // BUYER・RECIPIENT（個人情報）は頼まない
    expect(first.searchParams.get("lastUpdatedAfter")).toBe("2026-11-01T00:00:00.000Z");
    expect((calls[1].init?.headers as Record<string, string>)["x-amz-access-token"]).toBe("Atza|access");
    expect(new URL(calls[2].url).searchParams.get("paginationToken")).toBe("NEXT");
    // アクセストークンは使い回す（ログインは1回）
    expect(calls.filter((c) => c.url.includes("auth/o2")).length).toBe(1);
  });

  it("混み合い（429）はやり直す", async () => {
    const waits: number[] = [];
    const { f } = fakeFetch([token, json({ errors: [{ code: "QuotaExceeded" }] }, 429), json({ orders: [] })]);
    const api = createSpApi(config, { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(await api.searchOrders({ createdAfter: new Date(), merchantOnly: true })).toEqual([]);
    expect(waits).toEqual([2000]);
  });

  it("失敗したら HTTP の番号とエラーの種類だけを伝える（応答の本文は出さない）", async () => {
    const { f } = fakeFetch([token, json({ errors: [{ code: "Unauthorized", message: "見本 太郎 の注文は…" }] }, 403)]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    const e = await api.searchOrders({ createdAfter: new Date(), merchantOnly: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).message).toBe("Amazon への問い合わせに失敗しました（403 Unauthorized）。権限がないか、アプリの承認が切れています。");
    expect((e as SpApiError).message).not.toContain("見本");
  });

  it("ログインに失敗したら、キーを確かめるよう伝える", async () => {
    const { f } = fakeFetch([json({ error: "invalid_grant", error_description: "secret..." }, 400)]);
    const api = createSpApi(config, { fetch: f });
    await expect(api.getAccessToken()).rejects.toMatchObject({ status: 400, code: "invalid_grant" });
  });

  it("つながらないときは、ネットワークを確かめるよう伝える", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const api = createSpApi(config, { fetch: f });
    await expect(api.getAccessToken()).rejects.toMatchObject({ code: "network", message: expect.stringContaining("接続できませんでした") });
  });
});

describe("出荷通知", () => {
  const pkg = {
    packageReferenceId: "1",
    carrierCode: "Yamato Transport",
    trackingNumber: "1234-5678-9012",
    shipDate: "2026-11-16T03:00:00.000Z",
    orderItems: [{ orderItemId: "ITEM0", quantity: 1 }],
  };

  it("注文を1件取る（出荷の情報だけ）。ない注文は null", async () => {
    const { f, calls } = fakeFetch([token, json({ order: fakeOrder({ orderId: "503-1000000-0000009" }) }), json({ errors: [{ code: "NotFound" }] }, 404)]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    expect((await api.getOrder("503-1000000-0000009"))?.orderId).toBe("503-1000000-0000009");
    expect(calls[1].url).toBe("https://sp.example/orders/2026-01-01/orders/503-1000000-0000009?includedData=FULFILLMENT");
    expect(await api.getOrder("503-1000000-0000008")).toBeNull();
  });

  it("v0 の shipmentConfirmation に、日本のマーケットプレイスと1箱分を POST する（204 で成功）", async () => {
    const { f, calls } = fakeFetch([token, () => new Response(null, { status: 204 })]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    await api.confirmShipment("503-1000000-0000009", pkg);
    expect(calls[1].url).toBe("https://sp.example/orders/v0/orders/503-1000000-0000009/shipmentConfirmation");
    expect(calls[1].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ marketplaceId: "A1VC38T7YXB528", packageDetail: pkg });
    expect((calls[1].init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("失敗したら番号と種類だけを伝える。注文番号の形がちがえば送らない", async () => {
    const { f, calls } = fakeFetch([token, json({ errors: [{ code: "InvalidInput", message: "お客様の住所…" }] }, 400)]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    const e = await api.confirmShipment("503-1000000-0000009", pkg).catch((x) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect(e.message).toBe("Amazon への送信に失敗しました（400 InvalidInput）。");
    await expect(api.confirmShipment("../../x", pkg)).rejects.toThrow(/形がちがいます/);
    expect(calls).toHaveLength(2);
  });
});

describe("FBA の在庫", () => {
  it("日本のマーケットプレイスの在庫を、明細つきでページをたどって全部取る", async () => {
    const { f, calls } = fakeFetch([
      token,
      json({ payload: { inventorySummaries: [{ sellerSku: "A-FBA", inventoryDetails: { fulfillableQuantity: 3 } }] }, pagination: { nextToken: "N2" } }),
      json({ payload: { inventorySummaries: [{ sellerSku: "B-FBA" }] } }),
    ]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    expect((await api.getFbaInventory()).map((i) => i.sellerSku)).toEqual(["A-FBA", "B-FBA"]);
    const first = new URL(calls[1].url);
    expect(first.pathname).toBe("/fba/inventory/v1/summaries");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      details: "true",
      granularityType: "Marketplace",
      granularityId: "A1VC38T7YXB528",
      marketplaceIds: "A1VC38T7YXB528",
    });
    expect(new URL(calls[2].url).searchParams.get("nextToken")).toBe("N2");
  });
});

describe("出品数", () => {
  it("出品の商品タイプと今の自社出荷の数を読む。ない出品は null", async () => {
    const { f, calls } = fakeFetch([
      token,
      json({ summaries: [{ marketplaceId: "A1VC38T7YXB528", productType: "PERSONAL_COMPUTER" }], fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 2 }] }),
      json({ errors: [{ code: "NOT_FOUND" }] }, 404),
    ]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    expect(await api.getListing("A1SELLER0TEST", "ZB-X/FBM")).toEqual({ productType: "PERSONAL_COMPUTER", quantity: 2 });
    expect(calls[1].url).toBe(
      "https://sp.example/listings/2021-08-01/items/A1SELLER0TEST/ZB-X%2FFBM?marketplaceIds=A1VC38T7YXB528&includedData=summaries%2CfulfillmentAvailability",
    );
    expect(await api.getListing("A1SELLER0TEST", "ZB-NONE")).toBeNull();
  });

  it("自社出荷（DEFAULT）の数だけを PATCH で替える。受け付けなかったら問題の番号を返す", async () => {
    const { f, calls } = fakeFetch([token, json({ status: "ACCEPTED", issues: [] }), json({ status: "INVALID", issues: [{ code: "90220", severity: "ERROR", message: "…" }] })]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    expect(await api.setListingQuantity("A1SELLER0TEST", "ZB-X", "PERSONAL_COMPUTER", 3)).toEqual({ status: "ACCEPTED", issues: [] });
    expect(calls[1].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      productType: "PERSONAL_COMPUTER",
      patches: [{ op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: 3 }] }],
    });
    expect(await api.setListingQuantity("A1SELLER0TEST", "ZB-X", "PERSONAL_COMPUTER", 1)).toEqual({
      status: "INVALID",
      issues: [{ code: "90220", severity: "ERROR" }],
    });
  });

  it("出品者 ID・セラー SKU・数の形がおかしければ送らない", async () => {
    const { f, calls } = fakeFetch([token]);
    const api = createSpApi(config, { fetch: f, sleep: async () => {} });
    await expect(api.getListing("../x", "ZB-X")).rejects.toThrow(/出品者 ID/);
    await expect(api.setListingQuantity("A1SELLER0TEST", "ZB X", "PC", 1)).rejects.toThrow(/セラー SKU/);
    await expect(api.setListingQuantity("A1SELLER0TEST", "ZB-X", "PC", -1)).rejects.toThrow(/0〜999/);
    expect(calls).toHaveLength(0);
  });
});
