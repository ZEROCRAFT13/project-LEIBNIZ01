import { type NextRequest } from "next/server";
import { jobSecretOk } from "@/lib/amazon/job-auth";
import { syncAmazonOrders, type SyncMode } from "@/lib/amazon/order-sync";
import { createSpApi, spApiConfigFromEnv } from "@/lib/amazon/sp-api";

// 自社出荷の注文の取り込み（Cloud Scheduler から5分ごとに incremental、1日1回 reconcile で呼ぶ）。
// 合言葉（Authorization: Bearer …）がないと動かない。返すのは件数だけ（注文の中身は返さない）。

export async function POST(request: NextRequest) {
  if (!jobSecretOk(request.headers.get("authorization"))) return new Response("Unauthorized", { status: 401 });
  const config = spApiConfigFromEnv();
  if (!config) return Response.json({ ok: false, error: "SP-API のキーが設定されていません" }, { status: 503 });
  const m = request.nextUrl.searchParams.get("mode");
  const mode: SyncMode = m === "reconcile" ? "reconcile" : "incremental";
  const r = await syncAmazonOrders(createSpApi(config), mode);
  return Response.json(r, { status: r.ok ? 200 : 502 });
}
