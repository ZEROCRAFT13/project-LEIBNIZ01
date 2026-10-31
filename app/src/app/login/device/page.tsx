import type { Metadata } from "next";
import Link from "next/link";
import { EnrollForm } from "@/components/auth/enroll-form";

export const metadata: Metadata = { title: "組立用の端末を登録 | ZERO-BIT" };

export default function EnrollDevicePage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-8">
      <h1 className="text-2xl font-bold">組立用の端末を登録</h1>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-700">
        <li>代表が自分のPCで「設定 → 組立用の端末」を開き、登録コードを出す</li>
        <li>このスマホ（組立台の端末）で、そのコードを下に入れる</li>
        <li>登録すると、この端末では名前とPINでログインできるようになる</li>
      </ol>
      <EnrollForm />
      <Link href="/login" className="text-sm text-blue-800 hover:underline">
        ← ログインに戻る
      </Link>
    </main>
  );
}
