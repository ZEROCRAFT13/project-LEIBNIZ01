import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  InfoForm,
  LinkCandidateButton,
  LinkUnitForm,
  NotifiedButton,
  ShipControls,
  TrackingForm,
  UnlinkButton,
} from "@/components/fbm/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { fbmStatusLabel, missingForFbmShip } from "@/lib/fbm-calc";
import { getFbmOrder } from "@/lib/fbm";
import { yen, ymdHm } from "@/lib/format";
import { carrierLabel, label, unitStatusLabel } from "@/lib/labels";

export const metadata: Metadata = { title: "自社出荷 | ZERO-BIT" };

export default function FbmOrderPage({ params }: PageProps<"/fbm/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/fbm" className="text-sm text-blue-800 hover:underline">
        ← 自社出荷
      </Link>
      <Suspense fallback={<Loading />}>
        <Order params={params} />
      </Suspense>
    </main>
  );
}

async function Order({ params }: { params: PageProps<"/fbm/[id]">["params"] }) {
  const { id } = await params;
  await requireManager(`/fbm/${encodeURIComponent(id)}`);
  const o = /^\d{1,15}$/.test(id) ? await getFbmOrder(Number(id)) : null;
  if (!o) notFound();
  const open = o.status === "open";

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-bold">{o.orderNo}</h1>
        <Tag tone={open ? "amber" : o.status === "shipped" ? "blue" : "gray"}>{fbmStatusLabel[o.status]}</Tag>
        {o.status === "shipped" && !o.notifiedAt && <Tag tone="red">出荷通知がまだ</Tag>}
      </div>
      <p className="text-sm text-stone-700">
        注文 {ymdHm(o.orderedAt)}
        {o.shipBy && `・出荷期限 ${o.shipBy}`}・合計 {yen(o.totalAmount)}
        {o.createdBy && `・登録 ${o.createdBy}`}
        {o.shippedAt && `・発送 ${ymdHm(o.shippedAt)}`}
        {o.notifiedAt && `・出荷通知 ${ymdHm(o.notifiedAt)}（${o.notifiedBy ?? ""}）`}
      </p>
      {o.cancelReason && <p className="rounded-md bg-stone-200 px-4 py-3 text-sm">取り消しの理由：{o.cancelReason}</p>}

      <Card title="商品">
        <ul>
          {o.lines.map((l) => (
            <li key={l.skuId} className="flex flex-wrap items-center gap-x-4 px-5 py-3 text-sm">
              <span className="font-mono font-medium">{l.skuCode}</span>
              <span>{l.skuName}</span>
              <span className="font-mono">× {l.qty}</span>
              <span className="ml-auto font-mono">1台 {yen(l.unitPrice)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {open && (
        <Card title="個体を結びつける">
          <div className="flex flex-col gap-4 p-5">
            <LinkUnitForm orderId={o.id} />
            {o.candidates.length > 0 && o.linked < o.qty && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">出せる個体（検品が早く終わった順）</p>
                <ul>
                  {o.candidates.map((c) => (
                    <li key={c.mgmtNo} className="flex items-center gap-4 border-b border-stone-100 py-2 last:border-0">
                      <span className="font-mono">{c.mgmtNo}</span>
                      <span className="font-mono text-sm text-stone-600">{c.skuCode}</span>
                      <span className="ml-auto">
                        <LinkCandidateButton orderId={o.id} mgmtNo={c.mgmtNo} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {o.candidates.length === 0 && o.linked < o.qty && (
              <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-950">
                出荷待ちの個体がありません。組立・検品を急いでください。
              </p>
            )}
          </div>
        </Card>
      )}

      <Card title={`出荷する個体 ${o.linked} / ${o.qty}台`}>
        {o.units.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">まだ結びついていません。</p>
        ) : (
          <ul>
            {o.units.map((u) => (
              <li key={u.mgmtNo} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-100 px-5 py-3 last:border-0">
                <Link href={`/trace/${u.mgmtNo}`} className="font-mono font-medium text-blue-800 hover:underline">
                  {u.mgmtNo}
                </Link>
                <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                <Tag>{label(unitStatusLabel, u.status)}</Tag>
                <span className="ml-auto flex items-center gap-3">
                  {open || o.status === "shipped" ? (
                    <TrackingForm orderId={o.id} mgmtNo={u.mgmtNo} trackingNo={u.trackingNo} />
                  ) : (
                    <span className="font-mono text-sm">{u.trackingNo ?? "—"}</span>
                  )}
                  {open && <UnlinkButton orderId={o.id} mgmtNo={u.mgmtNo} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="運送会社とメモ">
        <div className="p-5">
          {o.status === "cancelled" ? (
            <p className="text-sm text-stone-700">
              {o.carrier ? carrierLabel[o.carrier] : "—"}・{o.note ?? ""}
            </p>
          ) : (
            <InfoForm orderId={o.id} carrier={o.carrier} note={o.note} editable={open} />
          )}
        </div>
      </Card>

      {open && (
        <Card title="発送">
          <div className="p-5">
            <ShipControls
              orderId={o.id}
              missing={missingForFbmShip({
                qty: o.qty,
                linked: o.linked,
                withoutTracking: o.units.filter((u) => !u.trackingNo).length,
                carrier: o.carrier,
              })}
            />
          </div>
        </Card>
      )}

      {o.status === "shipped" && !o.notifiedAt && (
        <Card title="Amazon への出荷通知">
          <div className="flex flex-col gap-3 p-5">
            <p className="text-sm text-stone-700">
              セラーセントラルの注文管理で、この注文の「出荷通知を送信」を行い、運送会社と送り状番号（
              {o.units.map((u) => u.trackingNo).join("、")}）を入れてください。終わったら下のボタンを押します。
            </p>
            <NotifiedButton orderId={o.id} overdue={o.daysLeft !== null && o.daysLeft < 0} />
          </div>
        </Card>
      )}
    </>
  );
}
