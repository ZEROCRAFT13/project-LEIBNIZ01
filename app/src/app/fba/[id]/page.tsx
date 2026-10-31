import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  AddReadyButton,
  AddUnitForm,
  InfoForm,
  ReceiptsForm,
  RemoveUnitButton,
  ShipControls,
  TrackingForm,
} from "@/components/fba/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { fbaStatusLabel, missingForShip } from "@/lib/fba-calc";
import { getFbaShipment, listReadyForFba } from "@/lib/fba";
import { ymdHm } from "@/lib/format";
import { label, unitStatusLabel } from "@/lib/labels";

export const metadata: Metadata = { title: "FBA 納品 | ZERO-BIT" };

export default function FbaShipmentPage({ params }: PageProps<"/fba/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/fba" className="text-sm text-blue-800 hover:underline">
        ← FBA 納品
      </Link>
      <Suspense fallback={<Loading />}>
        <Shipment params={params} />
      </Suspense>
    </main>
  );
}

async function Shipment({ params }: { params: PageProps<"/fba/[id]">["params"] }) {
  const { id } = await params;
  await requireManager(`/fba/${encodeURIComponent(id)}`);
  const s = /^\d{1,15}$/.test(id) ? await getFbaShipment(Number(id)) : null;
  if (!s) notFound();
  const draft = s.status === "draft";
  const ready = draft ? await listReadyForFba() : [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-bold">{s.amazonShipmentId ?? `下書き #${s.id}`}</h1>
        <Tag tone={draft ? "amber" : s.status === "closed" ? "green" : s.status === "cancelled" ? "gray" : "blue"}>
          {fbaStatusLabel[s.status]}
        </Tag>
        <span className="text-sm text-stone-600">
          作成 {ymdHm(s.createdAt)}
          {s.createdBy ? `・${s.createdBy}` : ""}
          {s.shippedAt && `・発送 ${ymdHm(s.shippedAt)}`}
          {s.closedAt && `・完了 ${ymdHm(s.closedAt)}`}
        </span>
      </div>

      <Card title="納品の情報">
        <div className="p-5">
          <InfoForm
            shipmentId={s.id}
            status={s.status}
            info={{ amazonShipmentId: s.amazonShipmentId, destinationFc: s.destinationFc, carrier: s.carrier, note: s.note }}
          />
        </div>
      </Card>

      {draft && (
        <Card title="個体を入れる">
          <div className="flex flex-col gap-4 p-5">
            <AddUnitForm shipmentId={s.id} />
            {ready.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">FBA に送れる個体（{ready.length}台）</p>
                <ul className="flex flex-col">
                  {ready.map((u) => (
                    <li key={u.mgmtNo} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-stone-100 py-2 last:border-0">
                      <span className="font-mono">{u.mgmtNo}</span>
                      <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                      {u.fulfillment === "both" && <Tag>両方（自社出荷にも使える）</Tag>}
                      <span className="ml-auto">
                        <AddReadyButton shipmentId={s.id} mgmtNo={u.mgmtNo} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card title={`入っている個体 ${s.units.length}台`} aside={s.bySku.map((r) => `${r.skuCode} ${r.sent}台`).join("・")}>
        {s.units.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">まだ入っていません。</p>
        ) : (
          <ul>
            {s.units.map((u) => (
              <li key={u.mgmtNo} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-100 px-5 py-3 last:border-0">
                <Link href={`/trace/${u.mgmtNo}`} className="font-mono font-medium text-blue-800 hover:underline">
                  {u.mgmtNo}
                </Link>
                <span className="font-mono text-sm text-stone-600">{u.skuCode}</span>
                <Tag tone={u.status === "ready" || u.status === "inbound_to_fba" || u.status === "at_fba" ? "gray" : "red"}>
                  {label(unitStatusLabel, u.status)}
                </Tag>
                <span className="ml-auto flex items-center gap-3">
                  <TrackingForm
                    shipmentId={s.id}
                    mgmtNo={u.mgmtNo}
                    trackingNo={u.trackingNo}
                    editable={s.status === "draft" || s.status === "shipped" || s.status === "receiving"}
                  />
                  {draft && <RemoveUnitButton shipmentId={s.id} mgmtNo={u.mgmtNo} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {draft && (
        <Card title="発送">
          <div className="p-5">
            <ShipControls
              shipmentId={s.id}
              unitCount={s.unitCount}
              missing={missingForShip({ amazonShipmentId: s.amazonShipmentId, unitCount: s.unitCount, notReady: s.notReady })}
            />
          </div>
        </Card>
      )}

      {(s.status === "shipped" || s.status === "receiving") && (
        <Card title="受領">
          <div className="p-5">
            <ReceiptsForm shipmentId={s.id} rows={s.bySku} />
          </div>
        </Card>
      )}

      {s.status === "closed" && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          全部受領されました。入っていた個体は「FBA 在庫」です。
        </p>
      )}
    </>
  );
}
