import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { SearchForm } from "@/components/trace/search-form";
import { Card, Loading, Tag } from "@/components/ui";
import { ymd, ymdHm, yen } from "@/lib/format";
import {
  channelLabel,
  label,
  linkMethodLabel,
  partStatusLabel,
  repairCoverageLabel,
  repairStatusLabel,
  rmaStatusLabel,
  slotLabel,
  unitStatusLabel,
} from "@/lib/labels";
import { getUnitTrace, type TracePart, type UnitTrace } from "@/lib/trace";

export const metadata: Metadata = { title: "個体トレース | ZERO-BIT" };

export default function UnitTracePage({ params }: PageProps<"/trace/[mgmtNo]">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/trace" className="text-sm text-blue-800 hover:underline">
            ← 個体トレース
          </Link>
          <h1 className="text-2xl font-bold">個体の履歴</h1>
        </div>
        <SearchForm />
      </div>
      <Suspense fallback={<Loading />}>
        <UnitTraceView params={params} />
      </Suspense>
    </main>
  );
}

async function UnitTraceView({ params }: { params: PageProps<"/trace/[mgmtNo]">["params"] }) {
  const { mgmtNo } = await params;
  const trace = await getUnitTrace(decodeURIComponent(mgmtNo));
  if (!trace) notFound();

  return (
    <>
      <Summary trace={trace} />
      <Timeline items={trace.timeline} />
      <PartsTable parts={trace.parts} totals={trace.totals} />
      {trace.removedParts.length > 0 && <RemovedParts parts={trace.removedParts} />}
      <div className="grid gap-5 lg:grid-cols-2">
        <Inspections items={trace.inspections} />
        <Repairs items={trace.repairs} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------

function Summary({ trace }: { trace: UnitTrace }) {
  const openRepair = trace.repairs.find((r) => r.status !== "returned" && r.status !== "cancelled");
  return (
    <Card>
      <div className="flex flex-wrap gap-x-10 gap-y-5 px-5 py-5">
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Tag tone="blue">{label(unitStatusLabel, trace.status)}</Tag>
            <WarrantyTag warranty={trace.warranty} />
            {trace.registration && <Tag tone="green">製品登録済み</Tag>}
            {openRepair && <Tag tone="amber">修理受付中</Tag>}
          </div>
          <p className="font-mono text-3xl font-medium tracking-wide">{trace.mgmtNo}</p>
          <p className="text-sm text-stone-700">
            <span className="font-mono">{trace.sku.code}</span>　{trace.sku.name}
          </p>
          {trace.notes && <p className="text-sm text-stone-600">メモ：{trace.notes}</p>}
        </div>
        <dl className="grid min-w-72 flex-[2] grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-3 text-sm">
          <Field label="販売">
            {trace.order
              ? `${label(channelLabel, trace.order.channel)}${trace.order.isFba ? "（FBA）" : ""}`
              : "まだ注文と紐づいていない"}
          </Field>
          <Field label="注文番号">
            {trace.order ? (
              <>
                <span className="font-mono">{trace.order.externalOrderNo}</span>
                <span className="block text-xs text-stone-500">{label(linkMethodLabel, trace.order.linkMethod)}</span>
              </>
            ) : (
              "—"
            )}
          </Field>
          <Field label="組立 / 検品">
            {trace.assembledBy ?? "—"} / {trace.inspectedBy ?? "未検品"}
          </Field>
          <Field label="自社からの出荷">
            {trace.shippedAt ? `${ymd(trace.shippedAt)}${trace.shipDestination === "fba" ? "（FBAへ納品）" : ""}` : "未出荷"}
          </Field>
          <Field label="保証">
            {trace.warranty.end ? (
              <>
                <span className="font-mono">
                  {trace.warranty.start} 〜 {trace.warranty.end}
                </span>
                <span className="block text-xs text-stone-500">
                  {trace.warranty.months}か月{trace.registration ? "（登録で延長）" : ""}
                </span>
              </>
            ) : (
              "出荷後に始まる"
            )}
          </Field>
        </dl>
      </div>
    </Card>
  );
}

function WarrantyTag({ warranty }: { warranty: UnitTrace["warranty"] }) {
  if (warranty.state === "active") return <Tag tone="green">保証内</Tag>;
  if (warranty.state === "expired") return <Tag tone="red">保証切れ</Tag>;
  return <Tag>保証前</Tag>;
}

function Field({ label: name, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-stone-500">{name}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function Timeline({ items }: { items: UnitTrace["timeline"] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="履歴" className="flex flex-wrap gap-1">
      {items.map((t, i) => (
        <div
          key={`${t.label}-${i}`}
          className={`flex min-w-36 flex-1 flex-col gap-0.5 border-t-4 bg-white px-4 py-3 ${
            t.label === "修理受付" ? "border-amber-600" : "border-blue-700"
          }`}
        >
          <span className="text-xs text-stone-500">{t.label}</span>
          <span className="font-mono text-sm font-medium">{ymd(t.at)}</span>
          {t.who && <span className="truncate text-xs text-stone-700">{t.who}</span>}
        </div>
      ))}
    </section>
  );
}

const th = "whitespace-nowrap border-b border-stone-300 px-3 py-2 text-left text-xs font-medium text-stone-500";
const td = "border-b border-stone-100 px-3 py-2.5 align-top text-sm";

function PartsTable({ parts, totals }: { parts: TracePart[]; totals: UnitTrace["totals"] }) {
  return (
    <Card
      title={`使っている部品 ${parts.length}点`}
      aside={
        <>
          部品原価（税込）<span className="font-mono font-medium text-stone-900"> {yen(totals.partsCostInclTax)}</span>
          　・　元箱の保管 {totals.boxesKept}点
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr>
              <th className={`${th} pl-5`}>区分</th>
              <th className={th}>品名</th>
              <th className={th}>シリアル</th>
              <th className={th}>購入日</th>
              <th className={th}>購入先</th>
              <th className={`${th} text-right`}>単価（税込）</th>
              <th className={th}>元箱</th>
              <th className={`${th} pr-5`}>メーカー保証・RMA</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={`${p.slot}-${p.serialNo ?? p.modelNo}`}>
                <td className={`${td} pl-5 whitespace-nowrap text-stone-600`}>{label(slotLabel, p.slot)}</td>
                <td className={td}>
                  <span className="font-medium">{p.name}</span>
                  <span className="block font-mono text-xs text-stone-500">
                    {p.maker} {p.modelNo}
                  </span>
                  {p.overrideReason && (
                    <span className="block text-xs text-amber-800">構成表外：{p.overrideReason}</span>
                  )}
                </td>
                <td className={`${td} whitespace-nowrap font-mono text-stone-700`}>{p.serialNo ?? "—"}</td>
                <td className={`${td} whitespace-nowrap font-mono`}>{ymd(p.purchasedOn)}</td>
                <td className={td}>
                  {p.supplier ?? "—"}
                  {p.supplierOrderNo && (
                    <span className="block font-mono text-xs text-stone-500">{p.supplierOrderNo}</span>
                  )}
                </td>
                <td className={`${td} whitespace-nowrap text-right font-mono`}>{yen(p.costInclTax)}</td>
                <td className={td}>{p.boxKept ? <Tag tone="blue">棚 {p.boxLocation}</Tag> : <Tag>なし</Tag>}</td>
                <td className={`${td} pr-5`}>
                  <span className="whitespace-nowrap text-stone-700">{makerWarranty(p.makerWarrantyMonths)}</span>
                  {p.rmaStatus && (
                    <span className="block text-xs text-amber-800">
                      {label(rmaStatusLabel, p.rmaStatus)} {p.rmaNo}
                    </span>
                  )}
                  {p.partStatus !== "installed" && (
                    <span className="block text-xs text-stone-500">{label(partStatusLabel, p.partStatus)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function makerWarranty(months: number | null): string {
  if (months == null) return "—";
  if (months % 12 === 0) return `${months / 12}年`;
  return `${months}か月`;
}

function RemovedParts({ parts }: { parts: TracePart[] }) {
  return (
    <Card title={`取り外した部品 ${parts.length}点`} aside="修理などで交換した部品の記録">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <th className={`${th} pl-5`}>区分</th>
              <th className={th}>品名・シリアル</th>
              <th className={th}>取り外した日</th>
              <th className={th}>理由</th>
              <th className={`${th} pr-5`}>RMA</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={`${p.slot}-${p.serialNo ?? p.modelNo}-removed`}>
                <td className={`${td} pl-5 text-stone-600`}>{label(slotLabel, p.slot)}</td>
                <td className={td}>
                  {p.name}
                  <span className="block font-mono text-xs text-stone-500">{p.serialNo ?? "—"}</span>
                </td>
                <td className={`${td} whitespace-nowrap font-mono`}>
                  {ymd(p.removedAt)}
                  {p.removedBy && <span className="block font-sans text-xs text-stone-500">{p.removedBy}</span>}
                </td>
                <td className={td}>{p.removeReason}</td>
                <td className={`${td} pr-5`}>
                  {p.rmaStatus ? (
                    <>
                      <Tag tone="amber">{label(rmaStatusLabel, p.rmaStatus)}</Tag>
                      <span className="block font-mono text-xs text-stone-500">{p.rmaNo}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Inspections({ items }: { items: UnitTrace["inspections"] }) {
  return (
    <Card title="検品の記録">
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-stone-600">まだ検品していません。</p>
      ) : (
        <ul>
          {items.map((i, n) => (
            <li key={n} className="flex flex-col gap-1 border-b border-stone-100 px-5 py-3 text-sm last:border-0">
              <span className="flex flex-wrap items-center gap-2">
                {i.result === "pass" ? <Tag tone="green">合格</Tag> : <Tag tone="red">不合格</Tag>}
                <span className="font-mono">{ymdHm(i.finishedAt)}</span>
                <span className="text-stone-600">{i.inspector}</span>
              </span>
              <span className="text-stone-700">
                負荷試験 {i.stressTestMinutes ?? "—"}分 ・ CPU最高 {i.maxCpuTempC ?? "—"}℃ ・ GPU最高{" "}
                {i.maxGpuTempC ?? "—"}℃ ・ 騒音 {i.noiseDb ?? "—"}dB
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Repairs({ items }: { items: UnitTrace["repairs"] }) {
  return (
    <Card title="修理の履歴">
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-stone-600">修理の受付はありません。</p>
      ) : (
        <ul>
          {items.map((r, n) => (
            <li key={n} className="flex flex-col gap-1 border-b border-stone-100 px-5 py-3 text-sm last:border-0">
              <span className="flex flex-wrap items-center gap-2">
                <Tag tone={r.status === "returned" ? "gray" : "amber"}>{label(repairStatusLabel, r.status)}</Tag>
                <span className="font-mono">{ymd(r.receivedAt)}</span>
                <span className="text-stone-600">{label(repairCoverageLabel, r.coverage)}</span>
              </span>
              <span className="font-medium">{r.symptom}</span>
              {r.note && <span className="text-stone-600">{r.note}</span>}
              {r.returnedAt && <span className="text-stone-600">返送：{ymd(r.returnedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
