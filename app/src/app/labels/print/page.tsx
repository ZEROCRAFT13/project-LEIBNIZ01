import type { Metadata } from "next";
import { Suspense } from "react";
import { LabelControls } from "@/components/label-controls";
import { Loading } from "@/components/ui";
import { requireAssembler } from "@/lib/auth/session";
import { LABEL_LENGTH_MM, TAPES, isPlaceholderUrl, labelUrl, parseLabelRequest } from "@/lib/label-calc";
import { getLabelUnits, qrSvg } from "@/lib/label-print";

export const metadata: Metadata = { title: "シールを印刷 | ZERO-BIT" };

const tape = TAPES[24];

// 1枚＝1ページ。PT-P700 のテープ（24mm 幅）に合わせた大きさ
const pageCss = `
@page { size: ${LABEL_LENGTH_MM}mm ${tape.tape}mm; margin: 0; }
@media print {
  html, body { background: #fff !important; margin: 0 !important; }
  .label-sheet { zoom: 1 !important; gap: 0 !important; }
  .label { border: 0 !important; break-after: page; }
}
@media screen { .label-sheet { zoom: 1.6; } }
`;

export default function PrintLabelsPage({ searchParams }: PageProps<"/labels/print">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 print:m-0 print:block print:max-w-none print:p-0">
      <style>{pageCss}</style>
      <Suspense fallback={<Loading />}>
        <Labels searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Labels({ searchParams }: { searchParams: PageProps<"/labels/print">["searchParams"] }) {
  const [, sp] = await Promise.all([requireAssembler("/labels"), searchParams]);
  const { mgmtNos, copies } = parseLabelRequest(sp);
  const units = await getLabelUnits(mgmtNos);
  const publicUrl = process.env.ZB_PUBLIC_URL;
  const labels = await Promise.all(
    units.map(async (u) => ({ ...u, url: labelUrl(publicUrl, u.mgmtNo), svg: await qrSvg(labelUrl(publicUrl, u.mgmtNo)) })),
  );

  return (
    <>
      <div className="flex flex-col gap-3 print:hidden">
        <h1 className="text-2xl font-bold">シールを印刷</h1>
        {isPlaceholderUrl(publicUrl) && (
          <p role="alert" className="rounded-md bg-amber-100 px-4 py-3 text-sm text-amber-950">
            QR の中の URL が仮（{labelUrl(publicUrl, "ZB-…")}）です。お客様に渡す本物のシールを刷る前に、製品登録のページの URL
            を決めて <span className="font-mono">ZB_PUBLIC_URL</span> に入れてください。試し刷りはこのままで大丈夫です。
          </p>
        )}
        {labels.length === 0 && (
          <p className="rounded-md bg-red-100 px-4 py-3 text-red-900">刷る管理番号が選ばれていません。シールの一覧から選んでください。</p>
        )}
        {labels.length > 0 && <LabelControls mgmtNos={labels.map((l) => l.mgmtNo)} count={labels.length * copies} />}
        <details className="text-sm text-stone-700">
          <summary className="cursor-pointer font-medium">PT-P700 で刷るときの設定</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>PT-P700 を事務所の PC に USB でつなぎ、24mm のテープを入れる</li>
            <li>印刷の画面でプリンターに PT-P700 を選び、余白は「なし」、倍率は「100%（実際のサイズ）」にする</li>
            <li>用紙のサイズが選べるときは、幅 24mm・長さ {LABEL_LENGTH_MM}mm にする（プリンターの設定で長さを決める場合もある）</li>
            <li>はじめは1枚だけ刷って、QR がスマホや読み取り機で読めるか確かめる</li>
          </ul>
        </details>
        <p className="text-xs text-stone-500">下は実物より大きく表示しています（印刷は実物の大きさ）。</p>
      </div>

      <div className="label-sheet flex flex-col items-start gap-2">
        {labels.flatMap((l) =>
          Array.from({ length: copies }, (_, i) => (
            <div
              key={`${l.mgmtNo}-${i}`}
              className="label border border-dashed border-stone-400"
              style={{
                width: `${LABEL_LENGTH_MM}mm`,
                height: `${tape.tape}mm`,
                padding: `${(tape.tape - tape.printable) / 2}mm 2mm`,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                gap: "2.5mm",
                background: "#fff",
                color: "#000",
                overflow: "hidden",
              }}
            >
              <div
                aria-label={`QR（${l.url}）`}
                role="img"
                style={{ width: `${tape.printable}mm`, height: `${tape.printable}mm`, flex: "none" }}
                // QR は qrcode が作った SVG（中身は管理番号の URL だけ）
                dangerouslySetInnerHTML={{ __html: l.svg.replace("<svg ", '<svg width="100%" height="100%" ') }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "1mm", minWidth: 0 }}>
                <span
                  style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "4.6mm", fontWeight: 700, lineHeight: 1 }}
                >
                  {l.mgmtNo}
                </span>
                <span style={{ fontSize: "2.4mm", lineHeight: 1.1 }}>ZERO-BIT・{l.skuCode}</span>
              </div>
            </div>
          )),
        )}
      </div>
    </>
  );
}
