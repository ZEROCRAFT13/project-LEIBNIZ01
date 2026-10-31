import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SupplierForm } from "@/components/settings/master-forms";
import { Card, Loading } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "仕入先を追加 | ZERO-BIT" };

export default function NewSupplierPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings/suppliers" className="text-sm text-blue-800 hover:underline">
        ← 仕入先
      </Link>
      <h1 className="text-2xl font-bold">仕入先を追加</h1>
      <Suspense fallback={<Loading />}>
        <Form />
      </Suspense>
    </main>
  );
}

async function Form() {
  await requirePurchaser("/settings/suppliers/new");
  return (
    <Card>
      <div className="p-5">
        <SupplierForm />
      </div>
    </Card>
  );
}
