import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { yen } from "@/lib/format";
import { listSkusWithSummary } from "@/lib/skus";

export const metadata: Metadata = { title: "機種と構成表 | ZERO-BIT" };

export default function SkusPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings" className="text-sm text-blue-800 hover:underline">
        ← 設定
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">機種と構成表</h1>
        <Link href="/settings/skus/new" className="flex h-11 items-center rounded-md bg-blue-800 px-5 font-bold text-white">
          ＋ 機種を作る
        </Link>
      </div>
      <p className="text-sm text-stone-600">
        機種ごとに「どの枠（CPU・GPU…）に、どの型番を使ってよいか」を決めます。組立で読んだ部品は、この構成表と照らし合わせます。
      </p>
      <Suspense fallback={<Loading />}>
        <Skus />
      </Suspense>
    </main>
  );
}

async function Skus() {
  await requireManager("/settings/skus");
  const rows = await listSkusWithSummary();
  return (
    <Card title={`${rows.length}機種`}>
      <ul>
        {rows.map((k) => (
          <li key={k.id} className="border-b border-stone-100 last:border-0">
            <Link
              href={`/settings/skus/${k.id}`}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50 ${k.active ? "" : "opacity-60"}`}
            >
              <span className="font-mono font-medium">{k.code}</span>
              <span>{k.name}</span>
              <span className="font-mono text-sm text-stone-600">{k.listPrice !== null ? yen(k.listPrice) : ""}</span>
              <span className="ml-auto flex flex-wrap gap-1">
                {!k.active && <Tag>使わない</Tag>}
                {k.amazonFulfillment && (
                  <Tag tone="blue">Amazon {k.amazonFulfillment === "both" ? "FBA＋自社出荷" : k.amazonFulfillment === "fba" ? "FBA" : "自社出荷"}</Tag>
                )}
                {k.missingListings > 0 && <Tag tone="amber">出品が未登録 {k.missingListings}</Tag>}
                <Tag>{k.slotCount}枠</Tag>
                {k.emptySlots > 0 && <Tag tone="amber">型番のない枠 {k.emptySlots}</Tag>}
                {k.openUnits > 0 && <Tag tone="blue">組立中 {k.openUnits}台</Tag>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
