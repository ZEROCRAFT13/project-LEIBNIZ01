import "server-only";
import { JP_MARKETPLACE_ID, type ApiOrder } from "@/lib/amazon/orders-map";

// SP-API への接続（Login with Amazon でアクセストークンを取り、日本＝極東の窓口に問い合わせる）。
// キーは環境変数（ローカルは app/.env.local、本番は Secret Manager）から読む。コードやログには書かない（ルール9）。
// 応答の本文はログに出さない（注文の中身が入るため）。失敗したときは HTTP の番号とエラーの種類だけを返す。
// ここからは読むだけ。Amazon に何かを送る操作（出荷通知・出品数）は、承認の仕組みと一緒に別に作る（ルール4）。

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

export function createSpApi(config: SpApiConfig, deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}): OrdersApi & {
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

  /** GET。混み合い（429）と一時的な失敗（5xx）は、間をあけて3回までやり直す */
  async function get(path: string, query: URLSearchParams): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await call(`${config.endpoint}${path}?${query.toString()}`, {
        headers: { "x-amz-access-token": await getAccessToken(), "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.json();
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
      throw new SpApiError(`Amazon への問い合わせに失敗しました（${res.status}${code ? ` ${code}` : ""}）。${hint}`, res.status, code);
    }
  }

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
  };
}
