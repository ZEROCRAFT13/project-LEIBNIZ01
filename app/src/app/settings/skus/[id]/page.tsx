import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AddSlotForm, SkuHeaderForm, SlotCard } from "@/components/settings/sku-forms";
import { Card, Loading } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { listPartModels } from "@/lib/purchasing";
import { getSkuDetail } from "@/lib/skus";

export const metadata: Metadata = { title: "機種の構成表 | ZERO-BIT" };

export default function SkuPage({ params, searchParams }: PageProps<"/settings/skus/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings/skus" className="text-sm text-blue-800 hover:underline">
        ← 機種と構成表
      </Link>
      <Suspense fallback={<Loading />}>
        <Sku params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Sku({
  params,
  searchParams,
}: {
  params: PageProps<"/settings/skus/[id]">["params"];
  searchParams: PageProps<"/settings/skus/[id]">["searchParams"];
}) {
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  await requireManager(`/settings/skus/${encodeURIComponent(id)}`);
  const sku = /^\d{1,15}$/.test(id) ? await getSkuDetail(Number(id)) : null;
  if (!sku) notFound();
  const models = await listPartModels();
  const locked = sku.openUnits > 0;

  return (
    <>
      <h1 className="text-2xl font-bold">
        <span className="font-mono">{sku.code}</span>
      </h1>
      {created === "1" && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          機種を作りました。枠ごとに、使ってよい型番を足してください。
        </p>
      )}
      {locked && (
        <p className="rounded-md bg-blue-100 px-4 py-3 text-sm text-blue-950">
          組立中・組立予定の個体が {sku.openUnits}台 あるので、枠を消すことはできません。使ってよい型番と数は変えられます。
        </p>
      )}
      <Card>
        <div className="p-5">
          <SkuHeaderForm sku={sku} />
        </div>
      </Card>

      <h2 className="text-lg font-bold">構成表（{sku.slots.length}枠）</h2>
      <div className="flex flex-col gap-3">
        {sku.slots.map((s) => (
          <SlotCard key={s.id} skuId={sku.id} slot={s} models={models} locked={locked} />
        ))}
      </div>

      <Card title="枠を足す（ケースファンなど）">
        <div className="p-5">
          <AddSlotForm skuId={sku.id} />
        </div>
      </Card>
    </>
  );
}
