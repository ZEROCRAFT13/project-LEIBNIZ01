import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ConfirmDraftForm } from "@/components/purchases/draft-forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { yen } from "@/lib/format";
import { getDraft } from "@/lib/purchase-drafts";
import { listPartModels, listSuppliers } from "@/lib/purchasing";
import { discardDraftAction } from "../actions";

export const metadata: Metadata = { title: "仕入れの下書き | ZERO-BIT" };

export default function DraftPage({ params }: PageProps<"/purchases/drafts/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/purchases/drafts" className="text-sm text-blue-800 hover:underline">
        ← 下書きの一覧
      </Link>
      <Suspense fallback={<Loading />}>
        <Draft params={params} />
      </Suspense>
    </main>
  );
}

async function Draft({ params }: { params: PageProps<"/purchases/drafts/[id]">["params"] }) {
  const { id } = await params;
  await requirePurchaser(`/purchases/drafts/${encodeURIComponent(id)}`);
  const draft = /^\d{1,15}$/.test(id) ? await getDraft(Number(id)) : null;
  if (!draft) notFound();
  const [suppliers, models] = await Promise.all([listSuppliers(), listPartModels()]);
  const sum = draft.lines.reduce((s, l) => s + l.lineTotal, 0);

  return (
    <>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">下書き：{draft.orderNo ?? "注文番号なし"}</h1>
        <Tag tone={draft.status === "open" ? "amber" : draft.status === "confirmed" ? "green" : "gray"}>
          {draft.status === "open" ? "確定待ち" : draft.status === "confirmed" ? "確定済み" : "捨てた"}
        </Tag>
      </header>

      {draft.status === "confirmed" && draft.purchaseId && (
        <p className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          確定して仕入れにしました。
          <Link href={`/purchases/${draft.purchaseId}`} className="ml-1 font-bold underline">
            仕入れを開く
          </Link>
        </p>
      )}

      {draft.issues.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-md bg-amber-100 px-4 py-3 text-amber-950">
          <p className="font-bold">読み取りで気になった点</p>
          {draft.issues.map((m) => (
            <p key={m}>・{m}</p>
          ))}
        </div>
      )}

      <p className="flex flex-wrap gap-x-6 text-sm text-stone-700">
        <span>
          メールの合計 <span className="font-mono">{draft.total !== null ? yen(draft.total) : "—"}</span>
        </span>
        <span>
          明細の合計 <span className="font-mono">{yen(sum)}</span>
          {draft.total !== null && sum === draft.total && <span className="ml-1 text-green-800">✓ 一致</span>}
        </span>
        <span>
          うち消費税{" "}
          <span className="font-mono">{draft.tax !== null ? `${yen(draft.tax)}（メールの額）` : "合計から計算"}</span>
        </span>
      </p>

      {draft.status === "open" && (
        <>
          <Card title="確かめて確定する">
            <div className="p-5">
              <ConfirmDraftForm
                draftId={draft.id}
                suppliers={suppliers}
                models={models}
                initial={{ supplierId: draft.supplierId, orderedOn: draft.orderedOn, paymentMethod: draft.paymentMethod }}
                lines={draft.lines}
              />
            </div>
          </Card>
          <details className="text-sm">
            <summary className="cursor-pointer text-red-800">この下書きを捨てる（キャンセルした注文など）</summary>
            <form action={discardDraftAction} className="mt-2">
              <input type="hidden" name="draftId" value={draft.id} />
              <button type="submit" className="h-10 rounded-md bg-red-700 px-4 font-bold text-white">
                捨てる
              </button>
            </form>
          </details>
        </>
      )}
    </>
  );
}
