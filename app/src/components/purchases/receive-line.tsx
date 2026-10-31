"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  cancelReceiptAction,
  receiveBulkAction,
  receiveSerialAction,
  type ReceiveState,
} from "@/app/purchases/actions";
import { beep } from "@/components/beep";

type Item = { id: number; serialNo: string | null; boxLocation: string | null; status: string };

const inputClass = "h-12 rounded-md border border-stone-400 bg-white px-3";

// 仕入れの明細1行ぶんの入荷。
// シリアルのある部品は、箱のシリアルのバーコードを読む（読み取り機は文字を打ってEnterを押す）。
// 元箱を保管する部品は、棚番を一度入れれば次の読み取りでもそのまま使う。
export function ReceiveLine({
  purchaseId,
  lineId,
  serialRequired,
  keepBox,
  remaining,
  items,
  autoFocus,
}: {
  purchaseId: number;
  lineId: number;
  serialRequired: boolean;
  keepBox: boolean;
  remaining: number;
  items: Item[];
  autoFocus: boolean;
}) {
  const [serialState, receiveSerial, receivingSerial] = useActionState<ReceiveState, FormData>(receiveSerialAction, null);
  const [bulkState, receiveBulk, receivingBulk] = useActionState<ReceiveState, FormData>(receiveBulkAction, null);
  const [cancelState, cancel, cancelling] = useActionState<ReceiveState, FormData>(cancelReceiptAction, null);
  const [box, setBox] = useState(items.findLast((i) => i.boxLocation)?.boxLocation ?? "");
  const [serial, setSerial] = useState("");
  const [qty, setQty] = useState(String(remaining));
  const serialRef = useRef<HTMLInputElement>(null);

  const latest = [serialState, bulkState, cancelState]
    .filter((s): s is NonNullable<ReceiveState> => s != null)
    .sort((a, b) => b.at - a.at)[0];

  // 読んだ結果を音で知らせ、次の箱をすぐ読めるようにする
  useEffect(() => {
    if (!serialState) return;
    beep(serialState.ok);
    serialRef.current?.focus();
    serialRef.current?.select();
  }, [serialState]);

  // 入荷できたら、入れたシリアルを消す（失敗したときは残して見比べられるように）
  const [seen, setSeen] = useState(serialState);
  if (serialState !== seen) {
    setSeen(serialState);
    if (serialState?.ok) setSerial("");
  }

  const boxField = keepBox && (
    <label className="flex flex-col gap-1 text-sm font-medium">
      元箱の棚番
      <input
        name="box"
        value={box}
        onChange={(e) => setBox(e.target.value)}
        placeholder="例 B-07"
        autoComplete="off"
        className={`${inputClass} w-32 font-mono`}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      {remaining > 0 &&
        (serialRequired ? (
          <form action={receiveSerial} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="purchaseId" value={purchaseId} />
            <input type="hidden" name="lineId" value={lineId} />
            {boxField}
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
              箱のシリアル（バーコードを読む）
              <input
                ref={serialRef}
                name="serial"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                autoFocus={autoFocus}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className={`${inputClass} font-mono text-lg`}
              />
            </label>
            <button
              type="submit"
              disabled={receivingSerial}
              className="h-12 rounded-md bg-blue-800 px-5 font-bold text-white disabled:opacity-60"
            >
              入荷
            </button>
          </form>
        ) : (
          <form action={receiveBulk} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="purchaseId" value={purchaseId} />
            <input type="hidden" name="lineId" value={lineId} />
            {boxField}
            <label className="flex flex-col gap-1 text-sm font-medium">
              届いた数
              <input
                name="qty"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className={`${inputClass} w-24 text-right`}
              />
            </label>
            <button
              type="submit"
              disabled={receivingBulk}
              className="h-12 rounded-md bg-blue-800 px-5 font-bold text-white disabled:opacity-60"
            >
              まとめて入荷
            </button>
          </form>
        ))}

      {latest && (
        <p
          role={latest.ok ? "status" : "alert"}
          className={`rounded-md px-4 py-3 ${latest.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          {latest.ok ? "✓ " : "✗ "}
          {latest.message}
        </p>
      )}

      {items.length > 0 && (
        <ul aria-label="入荷した部品" className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
              <span className="font-mono">{it.serialNo ?? "（シリアルなし）"}</span>
              {it.boxLocation && <span className="text-stone-600">元箱 {it.boxLocation}</span>}
              {it.status === "in_stock" ? (
                <form action={cancel} className="ml-auto">
                  <input type="hidden" name="purchaseId" value={purchaseId} />
                  <input type="hidden" name="itemId" value={it.id} />
                  <button type="submit" disabled={cancelling} className="text-xs text-red-800 underline">
                    入荷を取り消す
                  </button>
                </form>
              ) : (
                <span className="ml-auto text-xs text-stone-500">使用済み</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
