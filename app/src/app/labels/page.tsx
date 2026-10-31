import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Loading, Tag } from "@/components/ui";
import { requireAssembler } from "@/lib/auth/session";
import { ymdHm } from "@/lib/format";
import { label, unitStatusLabel } from "@/lib/labels";
import { listLabelUnits } from "@/lib/label-print";

export const metadata: Metadata = { title: "管理番号シール | ZERO-BIT" };

export default function LabelsPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">管理番号シール</h1>
      <p className="text-sm text-stone-600">
        組立で発行した管理番号のシールを、事務所のPC（PT-P700・24mm テープ）で刷ります。1台につき本体と箱の2枚がふつうです。
      </p>
      <Suspense fallback={<Loading />}>
        <Units />
      </Suspense>
    </main>
  );
}

async function Units() {
  await requireAssembler("/labels");
  const units = await listLabelUnits();
  const notYet = units.filter((u) => !u.printedAt);
  return (
    <form action="/labels/print" method="get" className="flex flex-col gap-4">
      <Card title={`まだ刷っていない ${notYet.length}台`} aside="ここ2週間に刷ったものも下に出ます">
        {units.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">刷るシールはありません。</p>
        ) : (
          <ul>
            {units.map((u) => (
              <li key={u.mgmtNo} className="border-b border-stone-100 last:border-0">
                <label className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50">
                  <input type="checkbox" name="u" value={u.mgmtNo} defaultChecked={!u.printedAt} className="h-5 w-5" />
                  <span className="font-mono text-lg font-medium">{u.mgmtNo}</span>
                  <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                  <Tag>{label(unitStatusLabel, u.status)}</Tag>
                  <span className="ml-auto text-xs text-stone-500">
                    {u.printedAt ? `刷った ${ymdHm(u.printedAt)}` : `発行 ${ymdHm(u.createdAt)}`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          1台あたりの枚数
          <select name="copies" defaultValue="2" className="h-11 rounded-md border border-stone-400 bg-white px-3">
            <option value="1">1枚</option>
            <option value="2">2枚（本体と箱）</option>
            <option value="3">3枚</option>
            <option value="4">4枚</option>
          </select>
        </label>
        <button type="submit" className="h-11 rounded-md bg-blue-800 px-5 font-bold text-white">
          選んだシールを印刷の画面で開く
        </button>
        <Link href="/assembly" className="text-sm text-blue-800 underline">
          組立へ
        </Link>
      </div>
    </form>
  );
}
