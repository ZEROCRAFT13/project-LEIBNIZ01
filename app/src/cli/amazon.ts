// SP-API のコマンド（事務所の PC で、app/.env.local のキーを使って動かす）。
//   npm run amazon:check      … つながるか確かめる。直近30日の自社出荷の注文の「件数」だけを表示する（中身は出さない）
//   npm run amazon:sync       … 取り込みを1回動かす（前回の続きから）
//   npm run amazon:reconcile  … 直近7日を見直して取り込む
//   npm run amazon:watch      … 5分ごとに取り込み、1日1回照合する（本番の定期実行ができるまで、事務所の PC で動かしておく）
// 本番では Cloud Scheduler が /api/jobs/amazon-orders を呼ぶので、このコマンドは確かめるときだけ使う。
import { mapOrder } from "@/lib/amazon/orders-map";
import { syncAmazonOrders } from "@/lib/amazon/order-sync";
import { createSpApi, SpApiError, spApiConfigFromEnv } from "@/lib/amazon/sp-api";
import { getPool } from "@/lib/db";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local がなければ、環境変数だけで動かす
}

async function main(cmd: string | undefined): Promise<number> {
  const config = spApiConfigFromEnv();
  if (!config) {
    console.error("✗ app/.env.local に SP_API_CLIENT_ID・SP_API_CLIENT_SECRET・SP_API_REFRESH_TOKEN を入れてください。");
    return 1;
  }
  const api = createSpApi(config);

  if (cmd === "check") {
    await api.getAccessToken();
    console.log("✓ Amazon にログインできました（LWA）");
    const orders = await api.searchOrders({ createdAfter: new Date(Date.now() - 30 * 86_400_000), merchantOnly: true });
    const mapped = orders.map(mapOrder);
    const by: Record<string, number> = {};
    for (const m of mapped) if (m.ok) by[m.order.status] = (by[m.order.status] ?? 0) + 1;
    console.log(`✓ 直近30日の自社出荷の注文：${orders.length}件`, by);
    const bad = mapped.filter((m) => !m.ok).length;
    if (bad > 0) console.log(`！ 読めなかった注文：${bad}件（取り込むときに ToDo で知らせます）`);
    return 0;
  }
  if (cmd === "sync" || cmd === "reconcile") {
    const r = await syncAmazonOrders(api, cmd === "sync" ? "incremental" : "reconcile");
    if (r.ok) {
      console.log("✓ 取り込みました", r.summary);
      return 0;
    }
    console.error("✗ 取り込めませんでした：", r.error);
    return 1;
  }
  if (cmd === "watch") {
    console.log("5分ごとに取り込みます（止めるときは Ctrl+C）");
    let lastReconcile = 0;
    for (;;) {
      const daily = Date.now() - lastReconcile > 24 * 3600_000;
      const r = await syncAmazonOrders(api, daily ? "reconcile" : "incremental");
      const at = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      if (r.ok) {
        if (daily) lastReconcile = Date.now();
        console.log(`${at} ✓ ${daily ? "照合" : "取り込み"}：新しい注文 ${r.summary.created}件・更新 ${r.summary.updated}件`);
      } else {
        console.error(`${at} ✗ ${r.error}（ToDo に出しました。5分後にやり直します）`);
      }
      await new Promise((res) => setTimeout(res, 5 * 60_000));
    }
  }
  console.error("使い方：npm run amazon:check | amazon:sync | amazon:reconcile | amazon:watch");
  return 1;
}

main(process.argv[2])
  .catch((e: unknown) => {
    // キーや応答の本文は出さない。種類と HTTP の番号だけ
    console.error("✗", e instanceof SpApiError ? e.message : e instanceof Error ? e.message : "不明なエラー");
    return 1;
  })
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  });
