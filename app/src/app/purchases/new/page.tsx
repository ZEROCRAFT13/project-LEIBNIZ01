import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PurchaseForm } from "@/components/purchases/purchase-form";
import { Loading } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { todayJst } from "@/lib/format";
import { listPartModels, listSuppliers } from "@/lib/purchasing";

export const metadata: Metadata = { title: "仕入れを登録 | ZERO-BIT" };

export default function NewPurchasePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/purchases" className="text-sm text-blue-800 hover:underline">
        ← 仕入れ・入荷
      </Link>
      <h1 className="text-2xl font-bold">仕入れを登録</h1>
      <p className="text-sm text-stone-600">
        注文したときに、領収書や注文確認メールを見ながら入れます。部品が届いたら、次の画面で箱のシリアルを読んで入荷します。
      </p>
      <Suspense fallback={<Loading />}>
        <Form />
      </Suspense>
    </main>
  );
}

async function Form() {
  await requirePurchaser("/purchases/new");
  const [suppliers, models] = await Promise.all([listSuppliers(), listPartModels()]);
  return <PurchaseForm suppliers={suppliers} models={models} today={todayJst()} />;
}
