import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NewOrderForm } from "@/components/fbm/forms";
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
        自社出荷の注文に、出荷待ちの個体を管理番号で結びつけて発送します。送り状はセラーセントラルや運送会社のシステムで作り、出荷通知もセラーセントラルで行います（ここから
        Amazon には何も送りません）。
      </p>
      <Suspense fallback={<Loading />}>
        <Orders />
      </Suspense>
    </main>
  );
}

async function Orders() {
  await requireManager("/fbm");
  const [orders, skus, nowLocal] = await Promise.all([listFbmOrders(), listFbmSkus(), nowLocalMinute()]);
  return (
    <>
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
