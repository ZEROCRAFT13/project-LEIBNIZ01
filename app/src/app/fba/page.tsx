import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { fbaStatusLabel } from "@/lib/fba-calc";
import { listFbaShipments, listReadyForFba } from "@/lib/fba";
import { ymd } from "@/lib/format";
import { createShipmentAction } from "./actions";

export const metadata: Metadata = { title: "FBA 納品 | ZERO-BIT" };

export default function FbaPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">FBA 納品</h1>
      <p className="text-sm text-stone-600">
        セラーセントラルで納品プランを作り、ここでは「どの個体をどの納品で送ったか」を記録します（Amazon には何も送りません）。
      </p>
      <Suspense fallback={<Loading />}>
        <Shipments />
      </Suspense>
    </main>
  );
}

const tone = { draft: "amber", shipped: "blue", receiving: "blue", closed: "green", cancelled: "gray" } as const;

async function Shipments() {
  await requireManager("/fba");
  const [shipments, ready] = await Promise.all([listFbaShipments(), listReadyForFba()]);
  const bySku = new Map<string, number>();
  for (const u of ready) bySku.set(u.skuCode, (bySku.get(u.skuCode) ?? 0) + 1);

  return (
    <>
      <Card title={`FBA に送れる個体 ${ready.length}台`} aside="出荷待ちで、FBA（または両方）の機種">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          {ready.length === 0 ? (
            <span className="text-sm text-stone-600">今はありません。検品が終わると、ここに出ます。</span>
          ) : (
            [...bySku].map(([code, n]) => (
              <span key={code} className="rounded-md bg-stone-100 px-3 py-1 text-sm">
                <span className="font-mono">{code}</span> <span className="font-bold">{n}台</span>
              </span>
            ))
          )}
          <form action={createShipmentAction} className="ml-auto">
            <button type="submit" className="h-11 rounded-md bg-blue-800 px-5 font-bold text-white">
              ＋ 新しい納品を作る
            </button>
          </form>
        </div>
      </Card>

      <Card title="納品">
        {shipments.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">納品はまだありません。</p>
        ) : (
          <ul>
            {shipments.map((s) => (
              <li key={s.id} className="border-b border-stone-100 last:border-0">
                <Link
                  href={`/fba/${s.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50"
                >
                  <Tag tone={tone[s.status]}>{fbaStatusLabel[s.status]}</Tag>
                  <span className="font-mono font-medium">{s.amazonShipmentId ?? `下書き #${s.id}`}</span>
                  {s.destinationFc && <span className="font-mono text-sm text-stone-600">{s.destinationFc}</span>}
                  <span className="text-sm">{s.unitCount}台</span>
                  {(s.status === "shipped" || s.status === "receiving") && (
                    <span className="text-sm text-stone-700">
                      受領 {s.receivedCount} / {s.unitCount}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-stone-500">
                    {s.closedAt ? `完了 ${ymd(s.closedAt)}` : s.shippedAt ? `発送 ${ymd(s.shippedAt)}` : `作成 ${ymd(s.createdAt)}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
