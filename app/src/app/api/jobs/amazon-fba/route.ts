import { type NextRequest } from "next/server";
import { syncFbaInventory } from "@/lib/amazon/fba-sync";
import { jobSecretOk } from "@/lib/amazon/job-auth";
import { createSpApi, spApiConfigFromEnv } from "@/lib/amazon/sp-api";
import { updateFbmPlanTasks } from "@/lib/fbm-plan";

// FBA の在庫と販売ペースの取り込み（Cloud Scheduler から1時間ごとに呼ぶ）。
// あわせて、自社出荷の作り置き・出品数の直しの ToDo を見直す（lib/fbm-plan.ts）。
// 合言葉（Authorization: Bearer …）がないと動かない。返すのは件数だけ。

export async function POST(request: NextRequest) {
  if (!jobSecretOk(request.headers.get("authorization"))) return new Response("Unauthorized", { status: 401 });
  const config = spApiConfigFromEnv();
  if (!config) return Response.json({ ok: false, error: "SP-API のキーが設定されていません" }, { status: 503 });
  const r = await syncFbaInventory(createSpApi(config), "incremental");
  let fbmPlan = null;
  try {
    fbmPlan = await updateFbmPlanTasks();
  } catch {
    // 次の回（1時間後）にやり直す
  }
  return Response.json({ ...r, fbmPlan }, { status: r.ok ? 200 : 502 });
}
