import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";

export const metadata: Metadata = { title: "設定 | ZERO-BIT" };

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">設定</h1>
      <Suspense fallback={<Loading />}>
        <SettingsMenu />
      </Suspense>
    </main>
  );
}

async function SettingsMenu() {
  await requireManager("/settings");
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      <li>
        <Link
          href="/settings/devices"
          className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
        >
          <span className="font-bold">組立用の端末</span>
          <span className="text-sm text-stone-600">組立台のスマホ・タブレットを登録する／なくした端末を無効にする</span>
        </Link>
      </li>
      <li>
        <Link
          href="/settings/workers"
          className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
        >
          <span className="font-bold">バイトとPIN</span>
          <span className="text-sm text-stone-600">
            バイトを追加する／PINを決める・ロックを解除する／辞めた人を止める
          </span>
        </Link>
      </li>
      <li>
        <Link
          href="/settings/parts"
          className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
        >
          <span className="font-bold">部品の型番</span>
          <span className="text-sm text-stone-600">
            仕入れ・入荷・組立で使う部品を追加する／シリアル・元箱の扱いを決める
          </span>
        </Link>
      </li>
      <li>
        <Link
          href="/settings/skus"
          className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
        >
          <span className="font-bold">機種と構成表</span>
          <span className="text-sm text-stone-600">機種（SKU）を作る／枠ごとに使ってよい型番を決める（組立のチェックに使う）</span>
        </Link>
      </li>
      <li>
        <Link
          href="/settings/suppliers"
          className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
        >
          <span className="font-bold">仕入先</span>
          <span className="text-sm text-stone-600">ショップ・代理店を追加する／インボイス登録番号・RMAの窓口</span>
        </Link>
      </li>
    </ul>
  );
}
