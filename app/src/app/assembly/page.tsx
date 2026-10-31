import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { UnitJump } from "@/components/assembly/unit-jump";
import { Card, Loading } from "@/components/ui";
import { listInProgress, listSkus, listWorkers } from "@/lib/assembly";
import { getCurrentWorker } from "@/lib/worker-session";
import { clearWorkerAction, selectWorkerAction, startUnitAction } from "./actions";

export const metadata: Metadata = { title: "組立 | ZERO-BIT" };

export default function AssemblyHomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold">組立</h1>
      <Suspense fallback={<Loading />}>
        <AssemblyHome />
      </Suspense>
    </main>
  );
}

async function AssemblyHome() {
  const worker = await getCurrentWorker();
  if (!worker) return <ChooseWorker />;

  const [inProgress, skus] = await Promise.all([listInProgress(), listSkus()]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-stone-900 px-4 py-3 text-white">
        <span>
          <span className="text-lg font-bold">{worker.name}</span>
          <span className="text-sm text-stone-300"> さんが作業中</span>
        </span>
        <form action={clearWorkerAction}>
          <button type="submit" className="h-11 rounded-md border border-stone-500 px-3 text-sm">
            交代する
          </button>
        </form>
      </div>

      <Card>
        <div className="p-4">
          <UnitJump />
        </div>
      </Card>

      <Card title={`組立中 ${inProgress.length}台`}>
        {inProgress.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">組立中の個体はありません。</p>
        ) : (
          <ul>
            {inProgress.map((u) => (
              <li key={u.mgmtNo} className="border-b border-stone-100 last:border-0">
                <Link
                  href={`/assembly/${u.mgmtNo}`}
                  className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50"
                >
                  <span className="font-mono text-lg font-medium">{u.mgmtNo}</span>
                  <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                  <span className="ml-auto text-sm text-stone-700">
                    {u.filled} / {u.total} 点{u.assembledBy ? `・${u.assembledBy}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="新しく組み立てる">
        <div className="flex flex-col gap-2 p-4">
          <p className="text-sm text-stone-600">
            機種を選ぶと管理番号が発行されます。発行された番号のシールを本体と箱に貼ってください。
          </p>
          {skus.map((s) => (
            <form key={s.id} action={startUnitAction}>
              <input type="hidden" name="skuId" value={s.id} />
              <button
                type="submit"
                className="flex min-h-14 w-full flex-col items-start rounded-md border border-stone-300 bg-white px-4 py-2 text-left hover:border-blue-700"
              >
                <span className="font-mono font-medium">{s.code}</span>
                <span className="text-sm text-stone-600">{s.name}</span>
              </button>
            </form>
          ))}
        </div>
      </Card>
    </>
  );
}

async function ChooseWorker() {
  const workers = await listWorkers();
  return (
    <Card title="作業する人を選んでください">
      <div className="flex flex-col gap-2 p-4">
        {workers.map((w) => (
          <form key={w.id} action={selectWorkerAction}>
            <input type="hidden" name="workerId" value={w.id} />
            <button
              type="submit"
              className="h-14 w-full rounded-md border border-stone-300 bg-white px-4 text-left text-lg font-medium hover:border-blue-700"
            >
              {w.name}
            </button>
          </form>
        ))}
        <p className="pt-2 text-xs text-stone-500">
          ※ ログイン機能ができるまでの仮の仕組みです。選んだ名前で、誰が組み立てたかが記録されます。
        </p>
      </div>
    </Card>
  );
}
