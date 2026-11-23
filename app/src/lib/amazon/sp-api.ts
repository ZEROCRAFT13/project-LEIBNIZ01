import "server-only";
import { JP_MARKETPLACE_ID, type ApiOrder } from "@/lib/amazon/orders-map";

// SP-API への接続（Login with Amazon でアクセストークンを取り、日本＝極東の窓口に問い合わせる）。
// キーは環境変数（ローカルは app/.env.local、本番は Secret Manager）から読む。コードやログには書かない（ルール9）。
// 応答の本文はログに出さない（注文の中身が入るため）。失敗したときは HTTP の番号とエラーの種類だけを返す。
// Amazon に何かを送る操作（出荷通知）は、人が中身を見て承認したあとにだけ呼ぶ（呼ぶ側は lib/fbm-ship.ts。ルール4）。

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const FE_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
const USER_AGENT = "ZERO-BIT/0.1 (Language=TypeScript)";

export class SpApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export type SpApiConfig = { clientId: string; clientSecret: string; refreshToken: string; endpoint: string };

/** 環境変数から読む。足りなければ null（取り込みは動かさない） */
export function spApiConfigFromEnv(env: Record<string, string | undefined> = process.env): SpApiConfig | null {
  const clientId = env.SP_API_CLIENT_ID?.trim();
  const clientSecret = env.SP_API_CLIENT_SECRET?.trim();
  const refreshToken = env.SP_API_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, endpoint: env.SP_API_ENDPOINT?.trim() || FE_ENDPOINT };
}

export type OrdersApi = {
  /** 期間内に更新された（または作られた）注文。ページをたどって全部返す */
  searchOrders(params: { lastUpdatedAfter?: Date; createdAfter?: Date; merchantOnly: boolean }): Promise<ApiOrder[]>;
};

/** FBA の在庫（FBA Inventory API の inventorySummaries のうち、使う所だけ） */
export type FbaInventoryItem = {
  sellerSku?: string;
  fnSku?: string;
  totalQuantity?: number;
  lastUpdatedTime?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedQuantity?: {
      totalReservedQuantity?: number;
      pendingCustomerOrderQuantity?: number;
      pendingTransshipmentQuantity?: number;
      fcProcessingQuantity?: number;
    };
    unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  };
};

export type FbaInventoryApi = {
  /** 日本の FBA の在庫を全部（ページをたどる） */
  getFbaInventory(): Promise<FbaInventoryItem[]>;
};

/** 自社出荷の出品の数（Listings Items API） */
export type ListingQtyApi = {
  /** 出品の商品タイプ（数を変えるときに要る）と、Amazon 側の今の数。ない出品なら null */
  getListing(sellerId: string, sellerSku: string): Promise<{ productType: string; quantity: number | null } | null>;
  /** 自社出荷（DEFAULT）の数を変える。ACCEPTED 以外なら問題の番号を返す */
  setListingQuantity(
    sellerId: string,
    sellerSku: string,
    productType: string,
    quantity: number,
  ): Promise<{ status: string; issues: { code: string; severity: string }[] }>;
};

/** 出荷通知の1箱分（Orders API v0 confirmShipment の packageDetail） */
export type ShipConfirmPackage = {
  packageReferenceId: string;
  carrierCode: string;
  carrierName?: string;
  trackingNumber: string;
  /** ISO 8601 */
  shipDate: string;
  orderItems: { orderItemId: string; quantity: number }[];
};

export type ShipConfirmApi = {
  /** 1件の注文（明細の orderItemId を知るため）。ない注文なら null */
  getOrder(orderNo: string): Promise<ApiOrder | null>;
  /** 1箱分の出荷通知を送る。同じ packageReferenceId で送り直すと、Amazon 側の内容が直る */
  confirmShipment(orderNo: string, pkg: ShipConfirmPackage): Promise<void>;
};

type Fetch = typeof fetch;

/** エラーの応答から、種類（code）だけを取る。本文の中身は使わない */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { errors?: { code?: unknown }[]; error?: unknown };
    const c = body.errors?.[0]?.code ?? body.error;
    return typeof c === "string" ? c.slice(0, 60) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 出品の URL（セラー ID とセラー SKU は形を確かめてから入れる） */
function listingPath(sellerId: string, sellerSku: string): string {
  if (!/^[A-Z0-9]{8,20}$/.test(sellerId)) throw new SpApiError("出品者 ID（SP_API_SELLER_ID）の形がちがいます。", null, null);
  if (!/^[!-~]{1,40}$/.test(sellerSku)) throw new SpApiError("セラー SKU の形がちがいます。", null, null);
  return `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sellerSku)}`;
}

export function createSpApi(
  config: SpApiConfig,
  deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {},
): OrdersApi &
  ShipConfirmApi &
  FbaInventoryApi &
  ListingQtyApi & {
    getAccessToken(): Promise<string>;
  } {
  const doFetch = deps.fetch ?? fetch;
  const wait = deps.sleep ?? sleep;
  let token: { value: string; expiresAt: number } | null = null;

  /** ネットワークの失敗（つながらない・時間切れ）を、分かる言葉にする */
  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, init);
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SpApiError(
        timeout ? "Amazon からの返事がありません（時間切れ）。" : "Amazon に接続できませんでした。ネットワークを確かめてください。",
        null,
        timeout ? "timeout" : "network",
      );
    }
  }

  async function getAccessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await call(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new SpApiError("Amazon のログイン（LWA）に失敗しました。キーとリフレッシュトークンを確かめてください。", res.status, await errorCode(res));
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new SpApiError("Amazon のログイン（LWA）の応答が読めません。", res.status, null);
    const sec = typeof body.expires_in === "number" ? body.expires_in : 3600;
    token = { value: body.access_token, expiresAt: Date.now() + sec * 1000 };
    return token.value;
  }

  /**
   * 問い合わせる。混み合い（429）と一時的な失敗（5xx）は、間をあけて3回までやり直す
   * （送る操作の出荷通知も、同じ packageReferenceId なら何度送っても同じ結果になるので、やり直してよい）。
   * notFoundOk なら 404 は null を返す
   */
  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    query: URLSearchParams | null,
    body?: unknown,
    notFoundOk = false,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await call(`${config.endpoint}${path}${query ? `?${query.toString()}` : ""}`, {
        method,
        headers: {
          "x-amz-access-token": await getAccessToken(),
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
      if (notFoundOk && res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await wait(2000 * 2 ** attempt);
        continue;
      }
      const code = await errorCode(res);
      const hint =
        res.status === 403
          ? "権限がないか、アプリの承認が切れています。"
          : res.status === 429
            ? "問い合わせが多すぎます。少し待ってからやり直してください。"
            : "";
      const what = method === "GET" ? "問い合わせ" : "送信";
      throw new SpApiError(`Amazon への${what}に失敗しました（${res.status}${code ? ` ${code}` : ""}）。${hint}`, res.status, code);
    }
  }
  const get = (path: string, query: URLSearchParams) => request("GET", path, query);

  return {
    getAccessToken,
    async searchOrders({ lastUpdatedAfter, createdAfter, merchantOnly }) {
      const out: ApiOrder[] = [];
      let next: string | undefined;
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ marketplaceIds: JP_MARKETPLACE_ID, includedData: "FULFILLMENT", maxResultsPerPage: "100" });
        if (lastUpdatedAfter) q.set("lastUpdatedAfter", lastUpdatedAfter.toISOString());
        else if (createdAfter) q.set("createdAfter", createdAfter.toISOString());
        if (merchantOnly) q.set("fulfilledBy", "MERCHANT");
        if (next) q.set("paginationToken", next);
        const body = (await get("/orders/2026-01-01/orders", q)) as { orders?: ApiOrder[]; pagination?: { nextToken?: string } };
        out.push(...(body.orders ?? []));
        next = body.pagination?.nextToken;
        if (!next) return out;
      }
      throw new SpApiError("注文のページが多すぎます（5,000件を超えました）。期間を短くしてください。", null, null);
    },
    async getFbaInventory() {
      const out: FbaInventoryItem[] = [];
      let next: string | undefined;
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({
          details: "true",
          granularityType: "Marketplace",
          granularityId: JP_MARKETPLACE_ID,
          marketplaceIds: JP_MARKETPLACE_ID,
        });
        if (next) q.set("nextToken", next);
        const body = (await get("/fba/inventory/v1/summaries", q)) as {
          payload?: { inventorySummaries?: FbaInventoryItem[] };
          pagination?: { nextToken?: string };
        };
        out.push(...(body.payload?.inventorySummaries ?? []));
        next = body.pagination?.nextToken;
        if (!next) return out;
      }
      throw new SpApiError("FBA の在庫のページが多すぎます。", null, null);
    },
    async getListing(sellerId, sellerSku) {
      const q = new URLSearchParams({ marketplaceIds: JP_MARKETPLACE_ID, includedData: "summaries,fulfillmentAvailability" });
      const body = (await request("GET", listingPath(sellerId, sellerSku), q, undefined, true)) as {
        summaries?: { marketplaceId?: string; productType?: string }[];
        fulfillmentAvailability?: { fulfillmentChannelCode?: string; quantity?: number }[];
      } | null;
      if (!body) return null;
      const productType = body.summaries?.find((x) => x.marketplaceId === JP_MARKETPLACE_ID)?.productType ?? body.summaries?.[0]?.productType;
      if (!productType) throw new SpApiError("出品の商品タイプが読めません。", null, null);
      const q2 = body.fulfillmentAvailability?.find((x) => x.fulfillmentChannelCode === "DEFAULT")?.quantity;
      return { productType, quantity: Number.isInteger(q2) ? (q2 as number) : null };
    },
    async setListingQuantity(sellerId, sellerSku, productType, quantity) {
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) throw new SpApiError("出品数は 0〜999 の整数にしてください。", null, null);
      const q = new URLSearchParams({ marketplaceIds: JP_MARKETPLACE_ID, issueLocale: "ja_JP" });
      const body = (await request("PATCH", listingPath(sellerId, sellerSku), q, {
        productType,
        patches: [
          { op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity }] },
        ],
      })) as { status?: string; issues?: { code?: string; severity?: string }[] } | null;
      return {
        status: String(body?.status ?? ""),
        issues: (body?.issues ?? []).map((i) => ({ code: String(i.code ?? ""), severity: String(i.severity ?? "") })),
      };
    },
    async getOrder(orderNo) {
      if (!/^\d{3}-\d{7}-\d{7}$/.test(orderNo)) throw new SpApiError("注文番号の形がちがいます。", null, null);
      const q = new URLSearchParams({ includedData: "FULFILLMENT" });
      const body = (await request("GET", `/orders/2026-01-01/orders/${orderNo}`, q, undefined, true)) as { order?: ApiOrder } | null;
      return body?.order ?? null;
    },
    async confirmShipment(orderNo, pkg) {
      if (!/^\d{3}-\d{7}-\d{7}$/.test(orderNo)) throw new SpApiError("注文番号の形がちがいます。", null, null);
      // 出荷通知は Orders API v0 にだけある（v2026-01-01 にはない。v0 のうち廃止が決まっているのは読む操作だけ）
      await request("POST", `/orders/v0/orders/${orderNo}/shipmentConfirmation`, null, {
        marketplaceId: JP_MARKETPLACE_ID,
        packageDetail: pkg,
      });
    },
  };
}
