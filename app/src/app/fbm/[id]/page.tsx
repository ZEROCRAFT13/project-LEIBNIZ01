import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  InfoForm,
  LinkCandidateButton,
  LinkUnitForm,
  NotifiedButton,
  SendShipNoticeButton,
  ShipControls,
  TrackingForm,
  UnlinkButton,
} from "@/components/fbm/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { fbmStatusLabel, missingForFbmShip } from "@/lib/fbm-calc";
import { getFbmOrder } from "@/lib/fbm";
import { getShipNoticePreview, type ShipNoticePreview } from "@/lib/fbm-ship";
import { spApiConfigFromEnv } from "@/lib/amazon/sp-api";
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
  const notice = o.status === "shipped" ? await getShipNoticePreview(o.id, spApiConfigFromEnv() !== null) : null;

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

      {notice && !o.notifiedAt && (
        <Card title="Amazon への出荷通知">
          <ShipNotice orderId={o.id} notice={notice} overdue={o.daysLeft !== null && o.daysLeft < 0} />
        </Card>
      )}
      {notice && notice.history.length > 0 && <NoticeHistory notice={notice} />}
    </>
  );
}

const AMAZON_STATUS: Record<string, string> = { approved: "送信中", sent: "送れた", failed: "送れなかった" };

/** 送る中身を見せて、承認して送る。この画面から送れないときは、セラーセントラルで通知して記録する */
function ShipNotice({ orderId, notice, overdue }: { orderId: number; notice: ShipNoticePreview; overdue: boolean }) {
  const canSend = notice.blockers.length === 0;
  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-sm text-stone-700">
        次の内容を Amazon に送ります。送り状番号と個体が合っているか確かめてから、ボタンを押してください（押した人が承認した人として残ります）。
      </p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-stone-600">注文番号</dt>
        <dd className="font-mono">{notice.orderNo}</dd>
        <dt className="text-stone-600">運送会社</dt>
        <dd>
          {notice.carrier ? carrierLabel[notice.carrier] : "—"}
          {notice.carrierCode && <span className="ml-2 font-mono text-stone-600">（{notice.carrierCode}）</span>}
        </dd>
        <dt className="text-stone-600">発送日時</dt>
        <dd>{notice.shippedAt ? ymdHm(notice.shippedAt) : "—"}</dd>
      </dl>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-300 text-left text-stone-600">
            <th className="py-1 pr-3 font-medium">箱</th>
            <th className="py-1 pr-3 font-medium">送り状番号</th>
            <th className="py-1 font-medium">入っている個体</th>
          </tr>
        </thead>
        <tbody>
          {notice.boxes.map((b, i) => (
            <tr key={b.trackingNo} className="border-b border-stone-100 last:border-0">
              <td className="py-2 pr-3">{i + 1}</td>
              <td className="py-2 pr-3 font-mono">{b.trackingNo}</td>
              <td className="py-2 font-mono">
                {b.mgmtNos.map((m, j) => (
                  <span key={m} className="mr-3 inline-block">
                    {m}（{b.skuCodes[j]}）
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canSend ? (
        <SendShipNoticeButton orderId={orderId} overdue={overdue} disabled={false} />
      ) : (
        <ul className="rounded-md bg-amber-100 px-4 py-3 text-sm text-amber-950">
          {notice.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-stone-700">セラーセントラルで通知した場合</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-stone-700">
            セラーセントラルの注文管理で「出荷通知を送信」を行い、運送会社と送り状番号を入れたら、下のボタンで記録します。
          </p>
          <NotifiedButton orderId={orderId} overdue={overdue} />
        </div>
      </details>
    </div>
  );
}

function NoticeHistory({ notice }: { notice: ShipNoticePreview }) {
  return (
    <Card title="出荷通知の送信の記録">
      <ul>
        {notice.history.map((h) => (
          <li key={h.id} className="flex flex-col gap-1 border-b border-stone-100 px-5 py-3 text-sm last:border-0">
            <span className="flex flex-wrap items-center gap-x-3">
              <Tag tone={h.status === "sent" ? "blue" : h.status === "failed" ? "red" : "amber"}>{AMAZON_STATUS[h.status]}</Tag>
              <span>
                {ymdHm(h.approvedAt)} 承認：{h.approvedBy}
              </span>
              {h.finishedAt && <span className="text-stone-600">終了 {ymdHm(h.finishedAt)}</span>}
            </span>
            {h.error && <span className="text-red-900">{h.error}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
