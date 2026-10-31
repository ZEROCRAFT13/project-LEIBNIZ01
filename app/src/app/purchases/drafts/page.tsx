import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PasteMailForm } from "@/components/purchases/draft-forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { yen, ymd, ymdHm } from "@/lib/format";
import { SUPPORTED_SHOPS } from "@/lib/order-mail";
import { listOpenDrafts } from "@/lib/purchase-drafts";

export const metadata: Metadata = { title: "仕入れの下書き | ZERO-BIT" };

export default function DraftsPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/purchases" className="text-sm text-blue-800 hover:underline">
        ← 仕入れ・入荷
      </Link>
      <h1 className="text-2xl font-bold">メールから仕入れの下書き</h1>
      <Suspense fallback={<Loading />}>
        <Drafts />
      </Suspense>
    </main>
  );
}

async function Drafts() {
  await requirePurchaser("/purchases/drafts");
  const drafts = await listOpenDrafts();
  return (
    <>
      <Card title="注文確認メールを読み取る" aside={`対応：${SUPPORTED_SHOPS.join("・")}`}>
        <div className="p-5">
          <PasteMailForm />
        </div>
      </Card>
      <Card title={`確定待ちの下書き ${drafts.length}件`}>
        {drafts.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">確定待ちの下書きはありません。</p>
        ) : (
          <ul>
            {drafts.map((d) => (
              <li key={d.id} className="border-b border-stone-100 last:border-0">
                <Link
                  href={`/purchases/drafts/${d.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50"
                >
                  <span className="text-sm text-stone-700">{d.orderedOn ? ymd(d.orderedOn) : "日付不明"}</span>
                  <span className="font-medium">{d.supplier ?? "仕入先不明"}</span>
                  <span className="font-mono text-sm text-stone-600">{d.orderNo ?? "—"}</span>
                  <span className="font-mono">{d.total !== null ? yen(d.total) : "—"}</span>
                  <span className="text-xs text-stone-500">{d.lineCount}行・{ymdHm(d.createdAt)}</span>
                  {d.issues.length > 0 && <Tag tone="amber">気になる点 {d.issues.length}</Tag>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
