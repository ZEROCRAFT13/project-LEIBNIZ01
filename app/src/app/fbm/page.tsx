import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NewOrderForm, SendListingQtyButton, SyncNowButton } from "@/components/fbm/forms";
import { fbmPolicyLabel } from "@/lib/fbm-plan-calc";
import { getFbmPlanRows } from "@/lib/fbm-plan";
import { getSyncHealth } from "@/lib/amazon/order-sync";
import { spApiConfigFromEnv } from "@/lib/amazon/sp-api";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { fbmStatusLabel } from "@/lib/fbm-calc";
import { listFbmOrders, listFbmSkus, nowLocalMinute } from "@/lib/fbm";
import { yen, ymdHm } from "@/lib/format";

export const metadata: Metadata = { title: "自社出荷 | ZERO-BIT" };

export default function FbmPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">自社出荷（Amazon）</h1>
      <p className="text-sm text-stone-600">
        自社出荷の注文に、出荷待ちの個体を管理番号で結びつけて発送します。送り状はセラーセントラルや運送会社のシステムで作ります。Amazon
        への出荷通知と出品数の反映は、ここで中身を確かめて承認してから送ります。
      </p>
      <Suspense fallback={<Loading />}>
        <Orders />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <ListingQty />
      </Suspense>
    </main>
  );
}

async function Orders() {
  await requireManager("/fbm");
  const configured = spApiConfigFromEnv() !== null;
  const [orders, skus, nowLocal, health] = await Promise.all([
    listFbmOrders(),
    listFbmSkus(),
    nowLocalMinute(),
    getSyncHealth(configured),
  ]);
  return (
    <>
      <Card title="Amazon からの取り込み" aside={configured ? "5分ごと（本番）・1日1回の照合" : "SP-API のキーが未設定"}>
        <div className="flex flex-col gap-3 px-5 py-4 text-sm">
          {configured ? (
            <p className={health.stale ? "font-bold text-red-800" : "text-stone-700"}>
              最後に成功：{health.lastSuccessAt ? ymdHm(health.lastSuccessAt) : "まだ一度もありません"}
              {health.stale && "（30分以上成功していません）"}
              {health.lastError && `・最後のエラー：${health.lastError}`}
            </p>
          ) : (
            <p className="text-stone-700">
              app/.env.local に SP-API のキー（SP_API_CLIENT_ID・SP_API_CLIENT_SECRET・SP_API_REFRESH_TOKEN）を入れると、注文が自動で入り ToDo
              に並びます。それまでは下の「注文を登録する」で手で入れてください。
            </p>
          )}
          <SyncNowButton disabled={!configured} />
        </div>
      </Card>

      <Card title="注文">
        {orders.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">自社出荷の注文はまだありません。</p>
        ) : (
          <ul>
            {orders.map((o) => (
              <li key={o.id} className="border-b border-stone-100 last:border-0">
                <Link href={`/fbm/${o.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50">
                  <Tag tone={o.status === "open" ? "amber" : o.status === "shipped" ? "blue" : "gray"}>{fbmStatusLabel[o.status]}</Tag>
                  {o.status === "shipped" && !o.notifiedAt && <Tag tone="red">出荷通知がまだ</Tag>}
                  <span className="font-mono font-medium">{o.orderNo}</span>
                  <span className="font-mono text-sm text-stone-600">
                    {o.skuCode} × {o.qty}
                  </span>
                  <span className="font-mono text-sm">{yen(o.totalAmount)}</span>
                  {o.status === "open" && (
                    <span className="text-sm">
                      個体 {o.linked} / {o.qty}
                    </span>
                  )}
                  <span className="ml-auto text-xs">
                    {o.status === "open" && o.shipBy ? (
                      <span className={o.daysLeft !== null && o.daysLeft <= 0 ? "font-bold text-red-800" : "text-stone-600"}>
                        出荷期限 {o.shipBy}
                        {o.daysLeft !== null && (o.daysLeft < 0 ? "（過ぎています）" : o.daysLeft === 0 ? "（今日）" : `（あと${o.daysLeft}日）`)}
                      </span>
                    ) : (
                      <span className="text-stone-500">{o.shippedAt ? `発送 ${ymdHm(o.shippedAt)}` : `注文 ${ymdHm(o.orderedAt)}`}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="注文を登録する" aside="SP-API で取り込めるようになるまでは手で">
        <div className="p-5">
          {skus.length === 0 ? (
            <p className="text-sm text-stone-600">
              自社出荷で売っている機種がありません。「設定 → 機種と構成表」で、出荷方法を「自社出荷」か「両方」にして、自社出荷用の出品を登録してください。
            </p>
          ) : (
            <NewOrderForm skus={skus} nowLocal={nowLocal} />
          )}
        </div>
      </Card>
    </>
  );
}

/** 自社出荷の出品数：機種ごとに出す数を計算し、承認して Amazon に反映する */
async function ListingQty() {
  await requireManager("/fbm");
  const configured = spApiConfigFromEnv() !== null;
  const sellerId = Boolean(process.env.SP_API_SELLER_ID?.trim());
  const rows = await getFbmPlanRows();
  const changed = rows.filter((r) => r.changed);
  const canSend = configured && sellerId;
  return (
    <Card title="Amazon の出品数（自社出荷）" aside="承認してから送る">
      <div className="flex flex-col gap-3 px-5 py-4">
        {!canSend && (
          <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-950">
            {configured ? "出品者 ID（SP_API_SELLER_ID）" : "SP-API のキー"}
            が設定されていないので、ここからは送れません。数の計算だけ見られます。
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-stone-600">自社出荷（または両方）で、自社出荷用の出品がある機種がありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-stone-300 text-left text-stone-600">
                  <th className="py-1 pr-3 font-medium">機種</th>
                  <th className="py-1 pr-3 font-medium">作り方</th>
                  <th className="py-1 pr-3 font-medium">出す数</th>
                  <th className="py-1 pr-3 font-medium">最後に送った数</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.skuId} className="border-b border-stone-100 align-top last:border-0">
                    <td className="py-2 pr-3">
                      <span className="font-mono">{r.skuCode}</span>
                      <span className="block font-mono text-xs text-stone-600">{r.sellerSku}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {fbmPolicyLabel[r.policy]}
                      {r.policy === "stock" && <span className="block text-xs text-stone-600">目標 {r.target}台</span>}
                      {r.shortage > 0 && <Tag tone="amber">あと{r.shortage}台組む</Tag>}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="text-lg font-bold">{r.qty}台</span>
                      <span className="block text-xs text-stone-600">{r.why}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {r.lastQty === null ? "まだ送っていない" : `${r.lastQty}台`}
                      {r.lastSentAt && <span className="block text-xs text-stone-600">{ymdHm(r.lastSentAt)}</span>}
                    </td>
                    <td className="py-2">
                      {r.changed && (
                        <SendListingQtyButton items={[{ skuId: r.skuId, qty: r.qty }]} label="この数で反映（承認）" disabled={!canSend} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {changed.length > 1 && (
          <SendListingQtyButton
            items={changed.map((r) => ({ skuId: r.skuId, qty: r.qty }))}
            label={`変わった ${changed.length}機種をまとめて反映（承認）`}
            disabled={!canSend}
          />
        )}
        <p className="text-xs text-stone-600">
          注文が入ると Amazon は自分で数を減らします。ここで出荷待ちが増えた・部品が入ったときなどに、数を見て反映してください（ずれていると ToDo
          に出ます）。
        </p>
      </div>
    </Card>
  );
}
