import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InboxButton } from "@/components/documents/inbox-button";
import { UploadBox } from "@/components/documents/upload-box";
import { Card, Loading, Tag } from "@/components/ui";
import { requireDocuments } from "@/lib/auth/session";
import { inboxDir, listDocuments, type DocumentRow } from "@/lib/documents";
import { yen, ymd, ymdHm } from "@/lib/format";
import { documentKindLabel, documentSourceLabel, label } from "@/lib/labels";

export const metadata: Metadata = { title: "書類 | ZERO-BIT" };

export default function DocumentsPage({ searchParams }: PageProps<"/documents">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">書類</h1>
      <Suspense fallback={<Loading />}>
        <Documents searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Documents({ searchParams }: { searchParams: PageProps<"/documents">["searchParams"] }) {
  const [, { show }] = await Promise.all([requireDocuments("/documents"), searchParams]);
  const filter = show === "all" ? "all" : "needs_review";
  const rows = await listDocuments(filter);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="共有の取り込みフォルダ">
          <div className="p-5">
            <p className="mb-3 text-sm text-stone-600">
              スキャナーの保存先や、サイトからダウンロードした領収書・保証書の置き場所にします。
              取り込んだファイルは「取り込み済み」へ移ります（消しません）。
            </p>
            <InboxButton folder={inboxDir()} />
          </div>
        </Card>
        <Card title="ファイルを取り込む">
          <div className="p-5">
            <UploadBox />
          </div>
        </Card>
      </div>

      <Card
        title={filter === "all" ? `すべての書類（新しい順）` : `要確認 ${rows.length}件`}
        aside={
          <Link href={filter === "all" ? "/documents" : "/documents?show=all"} className="text-blue-800 underline">
            {filter === "all" ? "要確認だけ見る" : "すべて見る"}
          </Link>
        }
      >
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">
            {filter === "all" ? "まだ書類がありません。" : "要確認の書類はありません。"}
          </p>
        ) : (
          <ul>
            {rows.map((d) => (
              <li key={d.id} className="border-b border-stone-100 last:border-0">
                <Row doc={d} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Row({ doc }: { doc: DocumentRow }) {
  return (
    <Link
      href={`/documents/${doc.id}`}
      className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50 sm:grid-cols-[7rem_1fr_10rem_7rem_9rem]"
    >
      <span className="flex items-center gap-2">
        <Tag tone={doc.reviewStatus === "done" ? "green" : "amber"}>{label(documentKindLabel, doc.kind)}</Tag>
      </span>
      <span className="min-w-0 truncate text-sm">
        {doc.originalName ?? `書類 #${doc.id}`}
        <span className="ml-2 text-xs text-stone-500">
          {label(documentSourceLabel, doc.source)}・{ymdHm(doc.receivedAt)}
        </span>
      </span>
      <span className="text-sm text-stone-700">{doc.counterparty ?? "—"}</span>
      <span className="text-sm text-stone-700">{doc.issuedOn ? ymd(doc.issuedOn) : "—"}</span>
      <span className="text-right font-mono text-sm">
        {doc.amount !== null ? yen(doc.amount) : "—"}
        {doc.purchases.length > 0 && <span className="ml-2 text-xs text-stone-500">仕入れ#{doc.purchases.join(",")}</span>}
      </span>
    </Link>
  );
}
