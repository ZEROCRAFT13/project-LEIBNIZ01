import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { UnitJump } from "@/components/assembly/unit-jump";
import { Card, Loading, Tag } from "@/components/ui";
import { requireInspector } from "@/lib/auth/session";
import { ymdHm } from "@/lib/format";
import { listInspectionQueue } from "@/lib/inspection";
import { stageLabel } from "@/lib/inspection-calc";

export const metadata: Metadata = { title: "検品 | ZERO-BIT" };

export default function InspectionHomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold">検品</h1>
      <Suspense fallback={<Loading />}>
        <InspectionHome />
      </Suspense>
    </main>
  );
}

async function InspectionHome() {
  const viewer = await requireInspector("/inspection");
  const queue = await listInspectionQueue();

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-stone-900 px-4 py-3 text-white">
        <span>
          <span className="text-lg font-bold">{viewer.user.name}</span>
          <span className="text-sm text-stone-300"> さんが検品</span>
        </span>
        <Link href="/assembly" className="text-sm text-stone-300 underline">
          組立へ
        </Link>
      </div>

      <Card>
        <div className="p-4">
          <UnitJump basePath="/inspection" label="管理番号のシールを読む（検品を始める・続ける）" />
        </div>
      </Card>

      <Card title={`検品待ち ${queue.length}台`} aside="組立を完了した順">
        {queue.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">検品待ちの個体はありません。</p>
        ) : (
          <ul>
            {queue.map((u) => {
              const own = u.assembledById === viewer.user.id;
              return (
                <li key={u.mgmtNo} className="border-b border-stone-100 last:border-0">
                  <Link
                    href={`/inspection/${u.mgmtNo}`}
                    className="flex min-h-14 flex-col gap-1 px-5 py-3 hover:bg-blue-50"
                  >
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-lg font-medium">{u.mgmtNo}</span>
                      <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                      <Tag tone="blue">{stageLabel[u.stage]}</Tag>
                      {own && <Tag tone="amber">自分で組んだので検品できない</Tag>}
                    </span>
                    <span className="text-sm text-stone-600">
                      組立 {u.assembledBy ?? "—"}・{ymdHm(u.assembledAt)}
                    </span>
                    {u.lastFail && <span className="text-sm text-red-800">前回の不合格：{u.lastFail}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
