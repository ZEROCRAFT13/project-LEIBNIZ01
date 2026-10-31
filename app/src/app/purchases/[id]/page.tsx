import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReceiveLine } from "@/components/purchases/receive-line";
import { ShipmentPanel } from "@/components/purchases/shipment-panel";
import { UploadBox } from "@/components/documents/upload-box";
import { documentsForPurchase } from "@/lib/documents";
import { Card, Loading, Tag } from "@/components/ui";
import { requirePurchaser } from "@/lib/auth/session";
import { yen, ymd } from "@/lib/format";
import { documentKindLabel, label, partCategoryLabel, paymentMethodLabel, purchaseStatusLabel } from "@/lib/labels";
import { getPurchase, type PurchaseLineView } from "@/lib/purchasing";

export const metadata: Metadata = { title: "入荷 | ZERO-BIT" };

export default function PurchasePage({ params, searchParams }: PageProps<"/purchases/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/purchases" className="text-sm text-blue-800 hover:underline">
        ← 仕入れ・入荷
      </Link>
      <Suspense fallback={<Loading />}>
        <Purchase params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Purchase({
  params,
  searchParams,
}: {
  params: PageProps<"/purchases/[id]">["params"];
  searchParams: PageProps<"/purchases/[id]">["searchParams"];
}) {
  const [{ id }, { new: isNew, arrived }] = await Promise.all([params, searchParams]);
  await requirePurchaser(`/purchases/${encodeURIComponent(id)}`);
  const purchase = /^\d{1,15}$/.test(id) ? await getPurchase(Number(id)) : null;
  if (!purchase) notFound();

  const open = purchase.status !== "cancelled";
  const documents = await documentsForPurchase(purchase.id);
  const arrivedShipment = purchase.shipments.find((s) => String(s.id) === arrived);
  const firstOpen = purchase.lines.find((l) => l.model && l.items.length < l.qty && l.model.serialRequired);

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{purchase.supplier}</h1>
          <Tag
            tone={
              purchase.status === "received"
                ? "green"
                : purchase.status === "cancelled"
                  ? "gray"
                  : purchase.status === "ordered"
                    ? "amber"
                    : "blue"
            }
          >
            {label(purchaseStatusLabel, purchase.status)}
          </Tag>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-700">
          <div>
            <dt className="inline text-stone-500">注文日 </dt>
            <dd className="inline">{ymd(purchase.orderedOn)}</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">注文番号 </dt>
            <dd className="inline font-mono">{purchase.orderNo ?? "—"}</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">合計 </dt>
            <dd className="inline font-mono">
              {yen(purchase.total)}（うち消費税 {yen(purchase.tax)}）
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">支払い </dt>
            <dd className="inline">{label(paymentMethodLabel, purchase.paymentMethod)}</dd>
          </div>
        </dl>
      </header>

      {isNew === "1" && (
        <p role="status" className="rounded-md bg-blue-100 px-4 py-3 text-blue-950">
          仕入れを登録しました。部品が届いたら、この画面で箱のシリアルを読んで入荷してください。
        </p>
      )}

      {arrivedShipment && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          追跡番号 <span className="font-mono font-bold">{arrivedShipment.trackingNo}</span> の荷物が届きました。箱のシリアルを読んで入荷してください。
        </p>
      )}

      <Card title="発送" aside={purchase.shipments.length > 0 ? `${purchase.shipments.length}個口` : undefined}>
        <ShipmentPanel
          purchaseId={purchase.id}
          shipments={purchase.shipments}
          canAdd={open && purchase.status !== "received"}
          arrivedId={arrivedShipment?.id ?? null}
        />
      </Card>

      {purchase.lines.map((line) => (
        <LineCard
          key={line.id}
          purchaseId={purchase.id}
          line={line}
          open={open}
          autoFocus={line.id === firstOpen?.id}
        />
      ))}

      <Card title="書類（領収書・納品書・保証書）" aside={documents.length > 0 ? `${documents.length}件` : undefined}>
        <div className="flex flex-col gap-3 px-5 py-4">
          {documents.length > 0 && (
            <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200 text-sm">
              {documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <Tag tone={d.reviewStatus === "done" ? "green" : "amber"}>{label(documentKindLabel, d.kind)}</Tag>
                  <Link href={`/documents/${d.id}`} className="min-w-0 truncate text-blue-800 underline">
                    {d.originalName ?? `書類 #${d.id}`}
                  </Link>
                  {d.reviewStatus !== "done" && <span className="text-xs text-amber-800">要確認</span>}
                </li>
              ))}
            </ul>
          )}
          <UploadBox purchaseId={purchase.id} />
        </div>
      </Card>
    </>
  );
}

function LineCard({
  purchaseId,
  line,
  open,
  autoFocus,
}: {
  purchaseId: number;
  line: PurchaseLineView;
  open: boolean;
  autoFocus: boolean;
}) {
  const subtotal = line.qty * line.unitPrice;
  if (!line.model) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm text-stone-700">
          <span>{line.description}（入荷なし）</span>
          <span className="font-mono">
            {line.qty} × {yen(line.unitPrice)} = {yen(subtotal)}
          </span>
        </div>
      </Card>
    );
  }

  const received = line.items.length;
  const done = received >= line.qty;
  return (
    <Card
      title={line.model.name}
      aside={
        <span className={`font-mono font-bold ${done ? "text-green-800" : "text-stone-900"}`}>
          {done ? "✓ " : ""}
          {received} / {line.qty} 個
        </span>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-600">
          <span>{label(partCategoryLabel, line.model.category)}</span>
          <span>
            {line.model.maker} <span className="font-mono">{line.model.modelNo}</span>
          </span>
          <span className="font-mono">
            {yen(line.unitPrice)} × {line.qty} = {yen(subtotal)}
          </span>
          {line.model.keepBox && <Tag tone="blue">元箱を保管</Tag>}
          {!line.model.serialRequired && <Tag>シリアルなし</Tag>}
        </p>
        {open ? (
          <ReceiveLine
            purchaseId={purchaseId}
            lineId={line.id}
            serialRequired={line.model.serialRequired}
            keepBox={line.model.keepBox}
            remaining={line.qty - received}
            items={line.items}
            autoFocus={autoFocus}
          />
        ) : (
          <p className="text-sm text-stone-600">取り消した仕入れなので、入荷できません。</p>
        )}
      </div>
    </Card>
  );
}
