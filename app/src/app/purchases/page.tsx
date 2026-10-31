import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrivalScan } from "@/components/purchases/arrival-scan";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { yen, ymd } from "@/lib/format";
import { label, purchaseStatusLabel } from "@/lib/labels";
import { countOpenDrafts } from "@/lib/purchase-drafts";
import { listPurchases, type PurchaseRow } from "@/lib/purchasing";

export const metadata: Metadata = { title: "仕入れ | ZERO-BIT" };

export default function PurchasesPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">仕入れ・入荷</h1>
        <Link
          href="/purchases/new"
          className="flex h-11 items-center rounded-md bg-blue-800 px-5 font-bold text-white hover:bg-blue-900"
        >
          ＋ 仕入れを登録する
        </Link>
      </div>
      <Suspense fallback={<Loading />}>
        <PurchaseList />
      </Suspense>
    </main>
  );
}

const statusTone = {
  ordered: "amber",
  in_transit: "blue",
  partially_received: "blue",
  received: "green",
  cancelled: "gray",
} as const;

async function PurchaseList() {
  await requirePurchaser("/purchases");
  const [rows, drafts] = await Promise.all([listPurchases(), countOpenDrafts()]);
  const waiting = rows.filter((r) => ["ordered", "in_transit", "partially_received"].includes(r.status));

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <span>
            <span className="font-bold">メールから仕入れの下書き</span>
            <span className="ml-2 text-sm text-stone-600">注文確認メールを貼り付けると、明細を読み取ります</span>
          </span>
          <Link
            href="/purchases/drafts"
            className="flex h-11 items-center gap-2 rounded-md border border-blue-800 px-4 font-bold text-blue-800"
          >
            下書き{drafts > 0 && <Tag tone="amber">確定待ち {drafts}</Tag>}
          </Link>
        </div>
      </Card>
      <Card>
        <div className="p-5">
          <ArrivalScan />
        </div>
      </Card>
      <Card title={`入荷待ち ${waiting.length}件`} aside="入荷待ちを上に、新しい順">
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">まだ仕入れがありません。</p>
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.id} className="border-b border-stone-100 last:border-0">
                <Row row={r} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Row({ row }: { row: PurchaseRow }) {
  return (
    <Link
      href={`/purchases/${row.id}`}
      className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50 sm:grid-cols-[6.5rem_10rem_1fr_7rem_8rem]"
    >
      <span className="text-sm text-stone-700">{ymd(row.orderedOn)}</span>
      <span className="font-medium">{row.supplier}</span>
      <span className="hidden font-mono text-sm text-stone-600 sm:block">{row.orderNo ?? "—"}</span>
      <span className="text-right font-mono">{yen(row.total)}</span>
      <span className="col-span-3 flex items-center gap-2 sm:col-span-1 sm:justify-end">
        <Tag tone={statusTone[row.status as keyof typeof statusTone] ?? "gray"}>
          {label(purchaseStatusLabel, row.status)}
        </Tag>
        <span className="text-xs text-stone-600">
          {row.received}/{row.expected}点
        </span>
      </span>
    </Link>
  );
}
