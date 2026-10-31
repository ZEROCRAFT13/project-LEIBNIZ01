import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NewSkuForm } from "@/components/settings/sku-forms";
import { Card, Loading } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { listSkusWithSummary } from "@/lib/skus";

export const metadata: Metadata = { title: "機種を作る | ZERO-BIT" };

export default function NewSkuPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings/skus" className="text-sm text-blue-800 hover:underline">
        ← 機種と構成表
      </Link>
      <h1 className="text-2xl font-bold">機種を作る</h1>
      <Suspense fallback={<Loading />}>
        <Form />
      </Suspense>
    </main>
  );
}

async function Form() {
  await requireManager("/settings/skus/new");
  const skus = await listSkusWithSummary();
  return (
    <Card>
      <div className="p-5">
        <NewSkuForm skus={skus.map(({ id, code, name }) => ({ id, code, name }))} />
      </div>
    </Card>
  );
}
