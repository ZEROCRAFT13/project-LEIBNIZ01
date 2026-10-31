import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AddPartTimerForm, SetPinForm } from "@/components/settings/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { PIN_MAX_FAILS, listWorkerAccounts, type WorkerAccount } from "@/lib/auth/store";
import { deactivatePartTimerAction, unlockPinAction } from "../actions";

export const metadata: Metadata = { title: "バイトとPIN | ZERO-BIT" };

export default function WorkersPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings" className="text-sm text-blue-800 hover:underline">
        ← 設定
      </Link>
      <h1 className="text-2xl font-bold">バイトとPIN</h1>
      <Suspense fallback={<Loading />}>
        <Workers />
      </Suspense>
    </main>
  );
}

async function Workers() {
  await requireManager("/settings/workers");
  const accounts = await listWorkerAccounts();

  return (
    <>
      <Card title={`組立をする人 ${accounts.length}人`}>
        <ul>
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-col gap-3 border-b border-stone-100 px-5 py-4 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{a.name}</span>
                <PinTag account={a} />
              </div>
              <div className="flex flex-wrap items-start gap-4">
                <SetPinForm userId={a.id} hasPin={a.hasPin} />
                {a.locked && (
                  <form action={unlockPinAction} className="self-end">
                    <input type="hidden" name="userId" value={a.id} />
                    <button type="submit" className="h-11 rounded-md border border-blue-800 px-4 font-bold text-blue-800">
                      ロックを解除する
                    </button>
                  </form>
                )}
              </div>
              {a.kind === "part_time" && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-red-800">辞めたので利用を止める</summary>
                  <form action={deactivatePartTimerAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="userId" value={a.id} />
                    <p className="text-stone-700">ログインできなくなります。これまでの組立の記録は残ります。</p>
                    <button type="submit" className="h-10 w-fit rounded-md bg-red-700 px-4 font-bold text-white">
                      {a.name} さんの利用を止める
                    </button>
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="バイトを追加する">
        <div className="flex flex-col gap-2 p-5">
          <p className="text-sm text-stone-600">
            名前だけで登録します（メールアドレスやGoogleアカウントは作りません）。組立担当の役割が付きます。
          </p>
          <AddPartTimerForm />
        </div>
      </Card>

      <p className="text-xs text-stone-500">
        PINは4桁の数字です。1111 や 1234 のような分かりやすい番号は使えません。{PIN_MAX_FAILS}
        回続けて間違えるとロックされ、ここで解除するまでログインできません。
      </p>
    </>
  );
}

function PinTag({ account }: { account: WorkerAccount }) {
  if (!account.hasPin) return <Tag tone="amber">PIN未設定</Tag>;
  if (account.locked) return <Tag tone="red">ロック中</Tag>;
  if (account.failedCount > 0) return <Tag tone="amber">PIN設定済み（{account.failedCount}回まちがい）</Tag>;
  return <Tag tone="green">PIN設定済み</Tag>;
}
