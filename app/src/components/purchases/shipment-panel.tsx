"use client";

import { useActionState, useState } from "react";
import { addShipmentAction, removeShipmentAction, type ReceiveState } from "@/app/purchases/actions";
import { ymd, ymdHm } from "@/lib/format";
import { carrierLabel, label } from "@/lib/labels";
import { CARRIERS } from "@/lib/purchase-calc";

type Shipment = { id: number; carrier: string; trackingNo: string; expectedOn: string | null; deliveredAt: Date | null };

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";

// 発送のお知らせが来たら、運送会社と追跡番号を入れる（何個口にも分かれていれば、その数だけ）
export function ShipmentPanel({
  purchaseId,
  shipments,
  canAdd,
  arrivedId,
}: {
  purchaseId: number;
  shipments: Shipment[];
  canAdd: boolean;
  arrivedId: number | null;
}) {
  const [addState, add, adding] = useActionState<ReceiveState, FormData>(addShipmentAction, null);
  const [removeState, remove, removing] = useActionState<ReceiveState, FormData>(removeShipmentAction, null);
  const [form, setForm] = useState({ carrier: "yamato", trackingNo: "", expectedOn: "" });

  // 登録できたら追跡番号の欄だけ空にする（運送会社は次の荷物でもたいてい同じ）
  const [seen, setSeen] = useState(addState);
  if (addState !== seen) {
    setSeen(addState);
    if (addState?.ok) setForm((f) => ({ ...f, trackingNo: "" }));
  }

  const latest = [addState, removeState]
    .filter((s): s is NonNullable<ReceiveState> => s != null)
    .sort((a, b) => b.at - a.at)[0];

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      {shipments.length === 0 ? (
        <p className="text-sm text-stone-600">まだ発送の連絡はありません。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200">
          {shipments.map((s) => (
            <li
              key={s.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm ${s.id === arrivedId ? "bg-green-50" : ""}`}
            >
              <span>{label(carrierLabel, s.carrier)}</span>
              <span className="font-mono">{s.trackingNo}</span>
              {s.expectedOn && <span className="text-stone-600">到着予定 {ymd(s.expectedOn)}</span>}
              {s.deliveredAt ? (
                <span className="font-bold text-green-800">届いた {ymdHm(s.deliveredAt)}</span>
              ) : (
                <span className="text-amber-800">輸送中</span>
              )}
              <form action={remove} className="ml-auto">
                <input type="hidden" name="purchaseId" value={purchaseId} />
                <input type="hidden" name="shipmentId" value={s.id} />
                <button type="submit" disabled={removing} className="text-xs text-red-800 underline">
                  消す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <form action={add} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="purchaseId" value={purchaseId} />
          <label className="flex flex-col gap-1 text-sm font-medium">
            運送会社
            <select
              name="carrier"
              value={form.carrier}
              onChange={(e) => setForm((f) => ({ ...f, carrier: e.target.value }))}
              className={inputClass}
            >
              {CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {carrierLabel[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
            追跡番号
            <input
              name="trackingNo"
              value={form.trackingNo}
              onChange={(e) => setForm((f) => ({ ...f, trackingNo: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            到着予定（あれば）
            <input
              name="expectedOn"
              type="date"
              value={form.expectedOn}
              onChange={(e) => setForm((f) => ({ ...f, expectedOn: e.target.value }))}
              className={inputClass}
            />
          </label>
          <button type="submit" disabled={adding} className="h-11 rounded-md bg-stone-800 px-4 font-bold text-white disabled:opacity-60">
            発送を登録
          </button>
        </form>
      )}

      {latest && (
        <p
          role={latest.ok ? "status" : "alert"}
          className={`rounded-md px-4 py-2 text-sm ${latest.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          {latest.message}
        </p>
      )}
    </div>
  );
}
