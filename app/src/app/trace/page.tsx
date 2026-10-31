import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SearchForm } from "@/components/trace/search-form";
import type { Metadata } from "next";
import { Card, Tag } from "@/components/ui";
import { label, unitStatusLabel } from "@/lib/labels";
import { searchUnits, type SearchHit } from "@/lib/trace";

export const metadata: Metadata = { title: "個体トレース | ZERO-BIT" };

const matchedByLabel: Record<SearchHit["matchedBy"], string> = {
  mgmt_no: "管理番号",
  order: "注文番号",
  serial: "部品のシリアル",
};

export default function TraceSearchPage({ searchParams }: PageProps<"/trace">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">個体トレース</h1>
      <Suspense fallback={<SearchForm />}>
        <SearchSection searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function SearchSection({ searchParams }: { searchParams: PageProps<"/trace">["searchParams"] }) {
  const { q } = await searchParams;
  const text = typeof q === "string" ? q : "";

  if (text.trim() === "") {
    return (
      <>
        <SearchForm />
        <p className="text-sm text-stone-600">
          お客様から伝えられた管理番号（本体のシール）、Amazonの注文番号、部品のシリアル番号で探せます。
          全角や小文字、「2609-0118」のような省略でも探せます。
        </p>
      </>
    );
  }

  const hits = await searchUnits(text);
  // 1台に決まったら、そのまま詳しい画面へ
  if (hits.length === 1) redirect(`/trace/${hits[0].mgmtNo}`);

  return (
    <>
      <SearchForm defaultValue={text} />
      {hits.length === 0 ? (
        <Card>
          <p className="px-5 py-6 text-sm text-stone-700">
            「{text}」に当てはまる個体は見つかりませんでした。番号を確かめて、もう一度探してください。
          </p>
        </Card>
      ) : (
        <Card title={`「${text}」の検索結果 ${hits.length}件`}>
          <ul>
            {hits.map((h) => (
              <li key={`${h.mgmtNo}-${h.matchedBy}-${h.detail}`} className="border-b border-stone-100 last:border-0">
                <Link
                  href={`/trace/${h.mgmtNo}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-blue-50"
                >
                  <span className="font-mono text-base font-medium">{h.mgmtNo}</span>
                  <span className="font-mono text-sm text-stone-600">{h.skuCode}</span>
                  <Tag>{label(unitStatusLabel, h.status)}</Tag>
                  <span className="text-sm text-stone-600">
                    {matchedByLabel[h.matchedBy]}で一致{h.detail ? `：${h.detail}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
