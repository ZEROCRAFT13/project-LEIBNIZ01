import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { label, partCategoryLabel } from "@/lib/labels";
import { listAllPartModels } from "@/lib/masters";

export const metadata: Metadata = { title: "部品の型番 | ZERO-BIT" };

export default function PartsPage({ searchParams }: PageProps<"/settings/parts">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings" className="text-sm text-blue-800 hover:underline">
        ← 設定
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">部品の型番</h1>
        <Link
          href="/settings/parts/new"
          className="flex h-11 items-center rounded-md bg-blue-800 px-5 font-bold text-white"
        >
          ＋ 型番を追加する
        </Link>
      </div>
      <Suspense fallback={<Loading />}>
        <Parts searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Parts({ searchParams }: { searchParams: PageProps<"/settings/parts">["searchParams"] }) {
  const [, { q }] = await Promise.all([requirePurchaser("/settings/parts"), searchParams]);
  const text = typeof q === "string" ? q.slice(0, 60) : "";
  const rows = await listAllPartModels(text);

  return (
    <>
      <form className="flex gap-2" role="search">
        <input
          name="q"
          defaultValue={text}
          placeholder="型番・名前・メーカー・JANで探す"
          aria-label="型番を探す"
          className="h-11 flex-1 rounded-md border border-stone-400 bg-white px-3"
        />
        <button type="submit" className="h-11 rounded-md border border-stone-400 px-4">
          探す
        </button>
      </form>
      <Card title={`${rows.length}件`}>
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">見つかりません。</p>
        ) : (
          <ul>
            {rows.map((p) => (
              <li key={p.id} className="border-b border-stone-100 last:border-0">
                <Link
                  href={`/settings/parts/${p.id}`}
                  className={`grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50 sm:grid-cols-[6rem_1fr_14rem_auto] ${p.active ? "" : "opacity-60"}`}
                >
                  <span className="text-sm text-stone-600">{label(partCategoryLabel, p.category)}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 text-sm text-stone-600">{p.maker}</span>
                  </span>
                  <span className="font-mono text-sm">{p.modelNo}</span>
                  <span className="flex flex-wrap gap-1">
                    {!p.active && <Tag>使わない</Tag>}
                    {p.keepBox && <Tag tone="blue">元箱</Tag>}
                    {!p.serialRequired && <Tag>シリアルなし</Tag>}
                    {p.skuCount === 0 && p.active && <Tag tone="amber">構成表になし</Tag>}
                    <Tag tone={p.inStock > 0 ? "green" : "gray"}>在庫 {p.inStock}</Tag>
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
