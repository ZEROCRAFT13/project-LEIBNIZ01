"use client";

import { useActionState, useState } from "react";
import {
  addUnitAction,
  cancelAction,
  infoAction,
  receiptsAction,
  removeUnitAction,
  shipAction,
  trackingAction,
  type FbaState,
} from "@/app/fba/actions";
import { carrierLabel } from "@/lib/labels";
import { FBA_CARRIERS, type FbaCarrier } from "@/lib/fba-calc";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";
const buttonClass = "h-11 rounded-md bg-blue-800 px-4 font-bold text-white disabled:opacity-60";

function Message({ state }: { state: FbaState }) {
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

/** 管理番号のシールを読んで納品に入れる（読み取り機は文字を打って Enter を押す） */
export function AddUnitForm({ shipmentId }: { shipmentId: number }) {
  const [state, action, pending] = useActionState<FbaState, FormData>(addUnitAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <label htmlFor="fba-code" className="text-sm font-medium">
        管理番号のシールを読む（本体か箱の QR でもよい）
      </label>
      <div className="flex gap-2">
        <input
          id="fba-code"
          name="code"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ZB-2611-0001"
          className={`${inputClass} min-w-0 flex-1 font-mono`}
        />
        <button type="submit" disabled={pending} className={buttonClass}>
          入れる
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** 出荷待ちの一覧から1台ずつ入れる */
export function AddReadyButton({ shipmentId, mgmtNo }: { shipmentId: number; mgmtNo: string }) {
  const [state, action, pending] = useActionState<FbaState, FormData>(addUnitAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="code" value={mgmtNo} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`${mgmtNo} を入れる`}
        className="h-9 rounded-md border border-blue-800 px-3 text-sm font-bold text-blue-800"
      >
        入れる
      </button>
      {state && !state.ok && <span className="text-sm text-red-800">{state.message}</span>}
    </form>
  );
}

export function RemoveUnitButton({ shipmentId, mgmtNo }: { shipmentId: number; mgmtNo: string }) {
  const [state, action, pending] = useActionState<FbaState, FormData>(removeUnitAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="mgmtNo" value={mgmtNo} />
      <button type="submit" disabled={pending} aria-label={`${mgmtNo} を外す`} className="text-sm text-red-800 underline">
        外す
      </button>
      {state && !state.ok && <span className="text-sm text-red-800">{state.message}</span>}
    </form>
  );
}

/** 箱（個体）ごとの送り状番号 */
export function TrackingForm({
  shipmentId,
  mgmtNo,
  trackingNo,
  editable,
}: {
  shipmentId: number;
  mgmtNo: string;
  trackingNo: string | null;
  editable: boolean;
}) {
  const [state, action, pending] = useActionState<FbaState, FormData>(trackingAction, null);
  const [v, setV] = useState(trackingNo ?? "");
  if (!editable) return <span className="font-mono text-sm text-stone-700">{trackingNo ?? "—"}</span>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
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
      <button type="submit" disabled={pending || v === (trackingNo ?? "")} className="h-9 rounded-md border border-stone-400 px-3 text-sm disabled:opacity-40">
        保存
      </button>
      {state && <span className={`text-xs ${state.ok ? "text-green-800" : "text-red-800"}`}>{state.message}</span>}
    </form>
  );
}

/** Amazon の出荷の番号・納品先の倉庫・運送会社・メモ */
export function InfoForm({
  shipmentId,
  status,
  info,
}: {
  shipmentId: number;
  status: string;
  info: { amazonShipmentId: string | null; destinationFc: string | null; carrier: FbaCarrier | null; note: string | null };
}) {
  const [state, action, pending] = useActionState<FbaState, FormData>(infoAction, null);
  const [v, setV] = useState({
    amazonShipmentId: info.amazonShipmentId ?? "",
    destinationFc: info.destinationFc ?? "",
    carrier: info.carrier ?? "",
    note: info.note ?? "",
  });
  const draft = status === "draft";
  const finished = status === "closed" || status === "cancelled";
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-52 flex-1 flex-col gap-1 text-sm font-medium">
          Amazon の出荷の番号
          <input
            name="amazonShipmentId"
            value={v.amazonShipmentId}
            onChange={(e) => setV((x) => ({ ...x, amazonShipmentId: e.target.value }))}
            readOnly={!draft}
            autoComplete="off"
            spellCheck={false}
            placeholder="FBA15XXXXXXX"
            className={`${inputClass} font-mono uppercase ${draft ? "" : "bg-stone-100"}`}
          />
        </label>
        <label className="flex w-32 flex-col gap-1 text-sm font-medium">
          納品先の倉庫
          <input
            name="destinationFc"
            value={v.destinationFc}
            onChange={(e) => setV((x) => ({ ...x, destinationFc: e.target.value }))}
            readOnly={finished}
            autoComplete="off"
            placeholder="NRT5"
            className={`${inputClass} font-mono uppercase`}
          />
        </label>
        <label className="flex w-44 flex-col gap-1 text-sm font-medium">
          運送会社
          <select
            name="carrier"
            value={v.carrier}
            onChange={(e) => setV((x) => ({ ...x, carrier: e.target.value }))}
            disabled={finished}
            className={inputClass}
          >
            <option value="">選んでください</option>
            {FBA_CARRIERS.map((c) => (
              <option key={c} value={c}>
                {carrierLabel[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        メモ
        <input
          name="note"
          value={v.note}
          onChange={(e) => setV((x) => ({ ...x, note: e.target.value }))}
          maxLength={500}
          className={inputClass}
        />
      </label>
      {finished && v.carrier && <input type="hidden" name="carrier" value={v.carrier} />}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass}>
          保存
        </button>
        {draft && (
          <span className="text-xs text-stone-600">番号と倉庫は、セラーセントラルで納品プランを作ると決まります。</span>
        )}
      </div>
      <Message state={state} />
    </form>
  );
}

/** 発送した（入れた個体は「FBA へ輸送中」になる）・下書きを取り消す */
export function ShipControls({ shipmentId, unitCount, missing }: { shipmentId: number; unitCount: number; missing: string[] }) {
  const [state, ship, shipping] = useActionState<FbaState, FormData>(shipAction, null);
  const [cancelState, cancel, cancelling] = useActionState<FbaState, FormData>(cancelAction, null);
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
        <input type="hidden" name="shipmentId" value={shipmentId} />
        <button
          type="submit"
          disabled={shipping || missing.length > 0}
          className="h-12 w-full rounded-md bg-blue-800 text-lg font-bold text-white disabled:opacity-50"
        >
          発送した（{unitCount}台を「FBA へ輸送中」にする）
        </button>
      </form>
      <p className="text-xs text-stone-600">
        箱に FBA の商品ラベルと配送ラベルを貼り、運送会社に渡してから押してください。押したあとは個体を出し入れできません。
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-red-800">この納品を取り消す</summary>
        <form action={cancel} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <p className="text-stone-700">入れた個体は出荷待ちに戻り、ほかの納品に入れられます。</p>
          <button type="submit" disabled={cancelling} className="h-10 w-fit rounded-md bg-red-700 px-4 font-bold text-white">
            取り消す
          </button>
        </form>
      </details>
      <Message state={shown} />
    </div>
  );
}

/** 受領数（機種ごと）。全部受領されたら完了になる */
export function ReceiptsForm({
  shipmentId,
  rows,
}: {
  shipmentId: number;
  rows: { skuId: number; skuCode: string; sent: number; received: number }[];
}) {
  const [state, action, pending] = useActionState<FbaState, FormData>(receiptsAction, null);
  const [v, setV] = useState<Record<number, string>>(() => Object.fromEntries(rows.map((r) => [r.skuId, String(r.received)])));
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-stone-600">
            <th className="py-1 font-medium">機種</th>
            <th className="py-1 text-right font-medium">送った</th>
            <th className="py-1 text-right font-medium">受領済み</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.skuId} className="border-t border-stone-100">
              <td className="py-2 font-mono">{r.skuCode}</td>
              <td className="py-2 text-right font-mono">{r.sent}</td>
              <td className="py-2 text-right">
                <input
                  name={`received_${r.skuId}`}
                  aria-label={`${r.skuCode} の受領数`}
                  inputMode="numeric"
                  value={v[r.skuId] ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setV((x) => ({ ...x, [r.skuId]: val }));
                  }}
                  className="h-10 w-20 rounded-md border border-stone-400 bg-white px-2 text-right font-mono"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-stone-600">
        セラーセントラルの納品の「受領済み」の数を入れます。全部受領されると完了になり、個体は「FBA 在庫」になります。
      </p>
      <button type="submit" disabled={pending} className={buttonClass}>
        受領数を保存
      </button>
      <Message state={state} />
    </form>
  );
}
