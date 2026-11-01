"use client";

import { useActionState, useState } from "react";
import {
  cancelAction,
  createOrderAction,
  infoAction,
  linkUnitAction,
  notifiedAction,
  shipAction,
  syncNowAction,
  trackingAction,
  unlinkUnitAction,
  type FbmState,
} from "@/app/fbm/actions";
import { FBA_CARRIERS } from "@/lib/fba-calc";
import { carrierLabel } from "@/lib/labels";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";
const buttonClass = "h-11 rounded-md bg-blue-800 px-4 font-bold text-white disabled:opacity-60";

function Message({ state }: { state: FbmState }) {
  if (!state) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={`rounded-md px-3 py-2 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
    >
      {state.message}
    </p>
  );
}

type Sku = { id: number; code: string; name: string; sellerSku: string; listPrice: number | null; available: number };

/** 自社出荷の注文を登録する（SP-API で取り込めるようになるまでは、セラーセントラルの注文を見て手で） */
export function NewOrderForm({ skus, nowLocal }: { skus: Sku[]; nowLocal: string }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(createOrderAction, null);
  const [v, setV] = useState({
    orderNo: "",
    orderedAt: nowLocal,
    shipBy: "",
    skuId: skus.length === 1 ? String(skus[0].id) : "",
    qty: "1",
    totalAmount: "",
    note: "",
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    const val = e.target.value;
    setV((x) => ({ ...x, [k]: val }));
  };
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          Amazon の注文番号
          <input
            name="orderNo"
            value={v.orderNo}
            onChange={set("orderNo")}
            autoComplete="off"
            placeholder="503-1234567-1234567"
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          注文日時
          <input type="datetime-local" name="orderedAt" value={v.orderedAt} onChange={set("orderedAt")} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          出荷期限
          <input type="date" name="shipBy" value={v.shipBy} onChange={set("shipBy")} className={inputClass} />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          機種
          <select name="skuId" value={v.skuId} onChange={set("skuId")} className={inputClass}>
            <option value="">選んでください</option>
            {skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}（{s.sellerSku}）出せる {s.available}台
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-24 flex-col gap-1 text-sm font-medium">
          数
          <input name="qty" inputMode="numeric" value={v.qty} onChange={set("qty")} className={`${inputClass} font-mono`} />
        </label>
        <label className="flex w-44 flex-col gap-1 text-sm font-medium">
          注文の合計（税込・円）
          <input
            name="totalAmount"
            inputMode="numeric"
            value={v.totalAmount}
            onChange={set("totalAmount")}
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        メモ（任意）
        <input name="note" value={v.note} onChange={set("note")} maxLength={500} className={inputClass} />
        <span className="text-xs font-normal text-stone-500">
          お客様の名前・住所・電話番号は書かないでください（送り状はセラーセントラルや運送会社のシステムで作ります）。
        </span>
      </label>
      <div>
        <button type="submit" disabled={pending} className={buttonClass}>
          注文を登録する
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** 管理番号のシールを読んで注文に結びつける */
export function LinkUnitForm({ orderId }: { orderId: number }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(linkUnitAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <label htmlFor="fbm-code" className="text-sm font-medium">
        出荷する個体の管理番号のシールを読む
      </label>
      <div className="flex gap-2">
        <input
          id="fbm-code"
          name="code"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ZB-2611-0001"
          className={`${inputClass} min-w-0 flex-1 font-mono`}
        />
        <button type="submit" disabled={pending} className={buttonClass}>
          結びつける
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function LinkCandidateButton({ orderId, mgmtNo }: { orderId: number; mgmtNo: string }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(linkUnitAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="code" value={mgmtNo} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`${mgmtNo} を結びつける`}
        className="h-9 rounded-md border border-blue-800 px-3 text-sm font-bold text-blue-800"
      >
        結びつける
      </button>
      {state && !state.ok && <span className="text-sm text-red-800">{state.message}</span>}
    </form>
  );
}

export function UnlinkButton({ orderId, mgmtNo }: { orderId: number; mgmtNo: string }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(unlinkUnitAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="mgmtNo" value={mgmtNo} />
      <button type="submit" disabled={pending} aria-label={`${mgmtNo} を外す`} className="text-sm text-red-800 underline">
        外す
      </button>
      {state && !state.ok && <span className="text-sm text-red-800">{state.message}</span>}
    </form>
  );
}

export function TrackingForm({ orderId, mgmtNo, trackingNo }: { orderId: number; mgmtNo: string; trackingNo: string | null }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(trackingAction, null);
  const [v, setV] = useState(trackingNo ?? "");
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="mgmtNo" value={mgmtNo} />
      <input
        name="trackingNo"
        aria-label={`${mgmtNo} の送り状番号`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        autoComplete="off"
        placeholder="送り状番号"
        className="h-9 w-44 rounded-md border border-stone-400 bg-white px-2 font-mono text-sm"
      />
      <button
        type="submit"
        disabled={pending || v === (trackingNo ?? "")}
        className="h-9 rounded-md border border-stone-400 px-3 text-sm disabled:opacity-40"
      >
        保存
      </button>
      {state && <span className={`text-xs ${state.ok ? "text-green-800" : "text-red-800"}`}>{state.message}</span>}
    </form>
  );
}

export function InfoForm({ orderId, carrier, note, editable }: { orderId: number; carrier: string | null; note: string | null; editable: boolean }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(infoAction, null);
  const [v, setV] = useState({ carrier: carrier ?? "", note: note ?? "" });
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-44 flex-col gap-1 text-sm font-medium">
          運送会社
          <select
            name="carrier"
            value={v.carrier}
            onChange={(e) => setV((x) => ({ ...x, carrier: e.target.value }))}
            disabled={!editable}
            className={inputClass}
          >
            <option value="">選んでください</option>
            {FBA_CARRIERS.filter((c) => c !== "amazon").map((c) => (
              <option key={c} value={c}>
                {carrierLabel[c]}
              </option>
            ))}
          </select>
        </label>
        {!editable && v.carrier && <input type="hidden" name="carrier" value={v.carrier} />}
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          メモ
          <input
            name="note"
            value={v.note}
            onChange={(e) => setV((x) => ({ ...x, note: e.target.value }))}
            maxLength={500}
            className={inputClass}
          />
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          保存
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function ShipControls({ orderId, missing }: { orderId: number; missing: string[] }) {
  const [state, ship, shipping] = useActionState<FbmState, FormData>(shipAction, null);
  const [cancelState, cancel, cancelling] = useActionState<FbmState, FormData>(cancelAction, null);
  const [reason, setReason] = useState("");
  const shown = cancelState && (!state || cancelState.at > state.at) ? cancelState : state;
  return (
    <div className="flex flex-col gap-3">
      {missing.length > 0 && (
        <ul className="list-disc rounded-md bg-amber-100 py-2 pl-8 pr-3 text-sm text-amber-950">
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <form action={ship}>
        <input type="hidden" name="orderId" value={orderId} />
        <button
          type="submit"
          disabled={shipping || missing.length > 0}
          className="h-12 w-full rounded-md bg-blue-800 text-lg font-bold text-white disabled:opacity-50"
        >
          発送した
        </button>
      </form>
      <p className="text-xs text-stone-600">運送会社に渡してから押してください。押したあとは個体を外せません。</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-red-800">この注文を取り消す</summary>
        <form action={cancel} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="orderId" value={orderId} />
          <label className="flex flex-col gap-1">
            取り消しの理由
            <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={inputClass} />
          </label>
          <p className="text-stone-700">結びついた個体は外れて、出荷待ちに戻ります。Amazon 側の取り消しは、セラーセントラルで行ってください。</p>
          <button type="submit" disabled={cancelling} className="h-10 w-fit rounded-md bg-red-700 px-4 font-bold text-white">
            取り消す
          </button>
        </form>
      </details>
      <Message state={shown} />
    </div>
  );
}

/** セラーセントラルで出荷通知をしたら押す（ここから Amazon には送らない） */
export function NotifiedButton({ orderId, overdue }: { orderId: number; overdue: boolean }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(notifiedAction, null);
  const [reason, setReason] = useState("");
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      {overdue && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          出荷期限を過ぎました。遅れた理由
          <input
            name="delayReason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="例：部品の入荷待ちで組立が遅れた"
            className={inputClass}
          />
        </label>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        セラーセントラルで出荷通知をした
      </button>
      <Message state={state} />
    </form>
  );
}

/** Amazon から今すぐ取り込む */
export function SyncNowButton({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState<FbmState, FormData>(syncNowAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <button type="submit" disabled={pending || disabled} className={buttonClass}>
        {pending ? "取り込んでいます…" : "Amazon から今すぐ取り込む（直近7日）"}
      </button>
      <Message state={state} />
    </form>
  );
}
