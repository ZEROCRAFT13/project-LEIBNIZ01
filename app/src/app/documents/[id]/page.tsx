import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DocumentMetaForm, PurchaseLinks } from "@/components/documents/document-editor";
import { Card, Loading, Tag } from "@/components/ui";
import { requireDocuments } from "@/lib/auth/session";
import { getDocument, recentPurchaseOptions } from "@/lib/documents";
import { ymdHm } from "@/lib/format";
import { documentKindLabel, documentSourceLabel, label } from "@/lib/labels";

export const metadata: Metadata = { title: "書類 | ZERO-BIT" };

export default function DocumentPage({ params }: PageProps<"/documents/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/documents" className="text-sm text-blue-800 hover:underline">
        ← 書類
      </Link>
      <Suspense fallback={<Loading />}>
        <DocumentView params={params} />
      </Suspense>
    </main>
  );
}

async function DocumentView({ params }: { params: PageProps<"/documents/[id]">["params"] }) {
  const { id } = await params;
  await requireDocuments(`/documents/${encodeURIComponent(id)}`);
  const doc = /^\d{1,15}$/.test(id) ? await getDocument(Number(id)) : null;
  if (!doc) notFound();
  const options = await recentPurchaseOptions();
  const fileUrl = `/documents/${doc.id}/file`;
  const isImage = doc.mimeType.startsWith("image/") && doc.mimeType !== "image/heic";

  return (
    <>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{label(documentKindLabel, doc.kind)}</h1>
          <Tag tone={doc.reviewStatus === "done" ? "green" : "amber"}>
            {doc.reviewStatus === "done" ? "確認済み" : "要確認"}
          </Tag>
        </div>
        <p className="break-all text-sm text-stone-600">
          {doc.originalName ?? `書類 #${doc.id}`}・{label(documentSourceLabel, doc.source)}・取り込み {ymdHm(doc.receivedAt)}・
          {Math.ceil(doc.byteSize / 1024).toLocaleString()}KB
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card
          title="中身"
          aside={
            <a href={`${fileUrl}?download=1`} className="text-blue-800 underline">
              ダウンロード
            </a>
          }
        >
          <div className="p-3">
            {doc.mimeType === "application/pdf" ? (
              <iframe src={fileUrl} title="書類の中身" className="h-[75vh] w-full rounded border border-stone-200" />
            ) : isImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- ログインが要るファイルなので画像の最適化は使わない
              <img src={fileUrl} alt="書類の写真" className="mx-auto max-h-[75vh] rounded border border-stone-200" />
            ) : (
              <p className="px-2 py-6 text-sm text-stone-600">
                この形式（iPhoneの写真 HEIC）はブラウザで表示できません。「ダウンロード」で開いてください。
              </p>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          <Card title="項目">
            <div className="p-5">
              <DocumentMetaForm
                documentId={doc.id}
                meta={{
                  kind: doc.kind,
                  issuedOn: doc.issuedOn,
                  counterparty: doc.counterparty,
                  amount: doc.amount,
                  invoiceRegNo: doc.invoiceRegNo,
                  reviewStatus: doc.reviewStatus,
                }}
              />
            </div>
          </Card>
          <Card title="ひもづけ">
            <div className="p-5">
              <PurchaseLinks
                documentId={doc.id}
                linked={doc.linkedPurchases.map((p) => ({
                  id: p.id,
                  label: `${p.orderedOn} ${p.supplier} ${p.orderNo ?? ""}`.trim(),
                }))}
                options={options}
              />
            </div>
          </Card>
          <p className="text-xs text-stone-500">
            取り込んだファイルは、書き換えも削除もできません（電子帳簿保存法）。項目を直した履歴は記録に残ります。
          </p>
        </div>
      </div>
    </>
  );
}
