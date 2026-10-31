import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { listAllSuppliers } from "@/lib/masters";

export const metadata: Metadata = { title: "仕入先 | ZERO-BIT" };

const kindLabel: Record<string, string> = { shop: "ショップ", distributor: "代理店", other: "その他" };

export default function SuppliersPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings" className="text-sm text-blue-800 hover:underline">
        ← 設定
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">仕入先</h1>
        <Link
          href="/settings/suppliers/new"
          className="flex h-11 items-center rounded-md bg-blue-800 px-5 font-bold text-white"
        >
          ＋ 仕入先を追加する
        </Link>
      </div>
      <Suspense fallback={<Loading />}>
        <Suppliers />
      </Suspense>
    </main>
  );
}

async function Suppliers() {
  await requirePurchaser("/settings/suppliers");
  const rows = await listAllSuppliers();
  return (
    <Card title={`${rows.length}件`}>
      <ul>
        {rows.map((s) => (
          <li key={s.id} className="border-b border-stone-100 last:border-0">
            <Link
              href={`/settings/suppliers/${s.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50"
            >
              <span className="font-medium">{s.name}</span>
              <Tag>{kindLabel[s.kind] ?? s.kind}</Tag>
              <span className="font-mono text-sm text-stone-600">{s.invoiceRegNo ?? "インボイス番号なし"}</span>
              <span className="ml-auto text-sm text-stone-600">仕入れ {s.purchaseCount}件</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
