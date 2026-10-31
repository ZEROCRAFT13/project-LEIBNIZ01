import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PartModelForm } from "@/components/settings/master-forms";
import { Card, Loading } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { getPartModel } from "@/lib/masters";

export const metadata: Metadata = { title: "部品の型番 | ZERO-BIT" };

export default function PartPage({ params, searchParams }: PageProps<"/settings/parts/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings/parts" className="text-sm text-blue-800 hover:underline">
        ← 部品の型番
      </Link>
      <Suspense fallback={<Loading />}>
        <Part params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Part({
  params,
  searchParams,
}: {
  params: PageProps<"/settings/parts/[id]">["params"];
  searchParams: PageProps<"/settings/parts/[id]">["searchParams"];
}) {
  const [{ id }, { added }] = await Promise.all([params, searchParams]);
  await requirePurchaser(`/settings/parts/${encodeURIComponent(id)}`);
  const part = /^\d{1,15}$/.test(id) ? await getPartModel(Number(id)) : null;
  if (!part) notFound();

  return (
    <>
      <h1 className="text-2xl font-bold">
        {part.name} <span className="font-mono text-lg text-stone-600">{part.modelNo}</span>
      </h1>
      {added === "1" && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          追加しました。仕入れ・下書きの部品の選択肢に出ます（開いている画面は読み込み直してください）。
        </p>
      )}
      <p className="text-sm text-stone-700">
        在庫 {part.inStock}個・この型番を使える機種 {part.skuCount}
        {part.skuCount === 0 && (
          <span className="ml-2 text-amber-800">
            （まだどの機種の構成表にも入っていないので、組立で使うと「構成表にない部品」として止まります。構成表の画面は次に作ります）
          </span>
        )}
      </p>
      <Card>
        <div className="p-5">
          <PartModelForm initial={part} />
        </div>
      </Card>
    </>
  );
}
