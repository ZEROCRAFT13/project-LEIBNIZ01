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
