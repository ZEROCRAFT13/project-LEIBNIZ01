import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SupplierForm } from "@/components/settings/master-forms";
import { Card, Loading } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { getSupplier } from "@/lib/masters";

export const metadata: Metadata = { title: "仕入先 | ZERO-BIT" };

export default function SupplierPage({ params, searchParams }: PageProps<"/settings/suppliers/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings/suppliers" className="text-sm text-blue-800 hover:underline">
        ← 仕入先
      </Link>
      <Suspense fallback={<Loading />}>
        <Supplier params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Supplier({
  params,
  searchParams,
}: {
  params: PageProps<"/settings/suppliers/[id]">["params"];
  searchParams: PageProps<"/settings/suppliers/[id]">["searchParams"];
}) {
  const [{ id }, { added }] = await Promise.all([params, searchParams]);
  await requirePurchaser(`/settings/suppliers/${encodeURIComponent(id)}`);
  const supplier = /^\d{1,15}$/.test(id) ? await getSupplier(Number(id)) : null;
  if (!supplier) notFound();
  return (
    <>
      <h1 className="text-2xl font-bold">{supplier.name}</h1>
      {added === "1" && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          追加しました。仕入れ・下書きの仕入先の選択肢に出ます。
        </p>
      )}
      <p className="text-sm text-stone-700">仕入れ {supplier.purchaseCount}件</p>
      <Card>
        <div className="p-5">
          <SupplierForm initial={supplier} />
        </div>
      </Card>
    </>
  );
}
