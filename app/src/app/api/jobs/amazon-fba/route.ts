import { type NextRequest } from "next/server";
import { syncFbaInventory } from "@/lib/amazon/fba-sync";
import { jobSecretOk } from "@/lib/amazon/job-auth";
import { createSpApi, spApiConfigFromEnv } from "@/lib/amazon/sp-api";

// FBA の在庫と販売ペースの取り込み（Cloud Scheduler から1時間ごとに呼ぶ）。
// 合言葉（Authorization: Bearer …）がないと動かない。返すのは件数だけ。

export async function POST(request: NextRequest) {
  if (!jobSecretOk(request.headers.get("authorization"))) return new Response("Unauthorized", { status: 401 });
  const config = spApiConfigFromEnv();
  if (!config) return Response.json({ ok: false, error: "SP-API のキーが設定されていません" }, { status: 503 });
  const r = await syncFbaInventory(createSpApi(config), "incremental");
  return Response.json(r, { status: r.ok ? 200 : 502 });
}
