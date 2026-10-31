import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ScanConsole } from "@/components/assembly/scan-console";
import { Loading } from "@/components/ui";
import { getAssembly, type AssemblySlot } from "@/lib/assembly";
import { label, unitStatusLabel } from "@/lib/labels";
import { getCurrentWorker } from "@/lib/worker-session";

export const metadata: Metadata = { title: "組立 | ZERO-BIT" };

export default function AssemblyUnitPage({ params, searchParams }: PageProps<"/assembly/[mgmtNo]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-5">
      <Link href="/assembly" className="text-sm text-blue-800 hover:underline">
        ← 組立のトップ
      </Link>
      <Suspense fallback={<Loading />}>
        <AssemblyUnit params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function AssemblyUnit({
  params,
  searchParams,
}: {
  params: PageProps<"/assembly/[mgmtNo]">["params"];
  searchParams: PageProps<"/assembly/[mgmtNo]">["searchParams"];
}) {
  const [{ mgmtNo }, { new: isNew }, worker] = await Promise.all([params, searchParams, getCurrentWorker()]);
  const view = await getAssembly(decodeURIComponent(mgmtNo));
  if (!view) notFound();

  const percent = view.total > 0 ? Math.round((view.filled / view.total) * 100) : 0;

  return (
    <>
      <header className="flex flex-col gap-2 rounded-lg bg-stone-900 px-4 py-4 text-white">
        <div className="flex justify-between gap-2 text-xs text-stone-300">
          <span>{label(unitStatusLabel, view.status)}</span>
          <span>{worker ? `${worker.name} さんが作業中` : "作業する人が未選択"}</span>
        </div>
        <p className="font-mono text-3xl font-medium tracking-wide">{view.mgmtNo}</p>
        <p className="text-sm text-stone-300">
          <span className="font-mono">{view.sku.code}</span>　{view.sku.name}
        </p>
        <div className="flex items-center gap-3">
          <div
            className="h-2 flex-1 overflow-hidden rounded bg-stone-700"
            role="progressbar"
            aria-valuenow={view.filled}
            aria-valuemin={0}
            aria-valuemax={view.total}
            aria-label="取り付けた部品の数"
          >
            <div className="h-2 bg-blue-400" style={{ width: `${percent}%` }} />
          </div>
          <span className="font-mono text-sm">
            {view.filled} / {view.total}
          </span>
        </div>
      </header>

      {isNew === "1" && view.filled === 0 && (
        <p className="rounded-md bg-blue-100 px-4 py-3 text-sm text-blue-950">
          管理番号 <span className="font-mono font-bold">{view.mgmtNo}</span> を発行しました。
          この番号のシールを本体と箱に貼ってから、部品を読んでください。（シールの印刷は次の段階で作ります）
        </p>
      )}

      {!worker ? (
        <p className="rounded-md bg-amber-100 px-4 py-3 text-amber-950">
          作業する人が選ばれていません。
          <Link href="/assembly" className="font-bold underline">
            組立のトップ
          </Link>
          で名前を選んでください。
        </p>
      ) : view.canScan ? (
        <ScanConsole mgmtNo={view.mgmtNo} complete={view.nextSlot === null} />
      ) : view.status === "inspecting" ? (
        <div role="status" className="flex flex-col gap-2 rounded-md bg-green-100 px-4 py-4 text-green-950">
          <p className="text-lg font-bold">✓ 組立が完了しました。検品に回してください。</p>
          <p className="text-sm">
            部品の付け外しは、ここではもうできません。
            <Link href={`/trace/${view.mgmtNo}`} className="ml-1 font-bold underline">
              個体の履歴を見る
            </Link>
          </p>
          <Link
            href="/assembly"
            className="mt-1 flex h-12 items-center justify-center rounded-md bg-green-700 font-bold text-white"
          >
            次の1台へ
          </Link>
        </div>
      ) : (
        <p className="rounded-md bg-stone-200 px-4 py-3 text-stone-900">
          この個体は「{label(unitStatusLabel, view.status)}」です。組立画面では部品を付け外しできません。
          <Link href={`/trace/${view.mgmtNo}`} className="ml-1 font-bold underline">
            個体の履歴を見る
          </Link>
        </p>
      )}

      <ul aria-label="使う部品" className="flex flex-col gap-2">
        {view.slots.map((s) => (
          <SlotRow key={s.slot} slot={s} isNext={view.canScan && s.slot === view.nextSlot} />
        ))}
      </ul>
    </>
  );
}

function SlotRow({ slot, isNext }: { slot: AssemblySlot; isNext: boolean }) {
  return (
    <li
      className={`flex items-start gap-3 rounded-lg border bg-white px-4 py-3 ${
        isNext ? "border-2 border-blue-700" : slot.done ? "border-stone-200 bg-stone-50" : "border-stone-300"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          slot.done ? "bg-blue-700 text-white" : "bg-stone-200 text-stone-700"
        }`}
      >
        {slot.done ? "✓" : ""}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center justify-between gap-2">
          <span className="font-bold">{slot.label}</span>
          {isNext && <span className="text-sm font-bold text-blue-800">次はこれ</span>}
          {slot.done && <span className="sr-only">取り付け済み</span>}
        </span>
        {slot.installed.length > 0 ? (
          slot.installed.map((p, i) => (
            <span key={i} className="text-sm text-stone-700">
              {p.name}
              {p.serialNo && <span className="ml-2 font-mono text-xs text-stone-500">{p.serialNo}</span>}
            </span>
          ))
        ) : (
          <span className="text-sm text-stone-600">使える部品：{slot.options.join(" / ")}</span>
        )}
      </div>
    </li>
  );
}
