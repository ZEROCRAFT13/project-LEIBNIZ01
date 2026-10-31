"use client";

import Link from "next/link";
import { useActionState } from "react";
import { markPrintedAction, type PrintState } from "@/app/labels/actions";

// 印刷の画面のボタン（印刷するときは隠れる）
export function LabelControls({ mgmtNos, count }: { mgmtNos: string[]; count: number }) {
  const [state, action, pending] = useActionState<PrintState, FormData>(markPrintedAction, null);
  return (
    <div className="flex flex-col gap-3 print:hidden">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => window.print()}
          className="h-12 rounded-md bg-blue-800 px-6 text-lg font-bold text-white"
        >
          印刷する（{count}枚）
        </button>
        <form action={action}>
          {mgmtNos.map((m) => (
            <input key={m} type="hidden" name="u" value={m} />
          ))}
          <button type="submit" disabled={pending} className="h-12 rounded-md border border-stone-400 px-4">
            刷れたので「刷った」にする
          </button>
        </form>
        <Link href="/labels" className="text-sm text-blue-800 underline">
          シールの一覧に戻る
        </Link>
      </div>
      {state && (
        <p
          role={state.ok ? "status" : "alert"}
          className={`rounded-md px-4 py-2 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
