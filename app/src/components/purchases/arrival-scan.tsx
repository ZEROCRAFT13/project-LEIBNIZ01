"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { findArrivalAction, type ArrivalState } from "@/app/purchases/actions";
import { beep } from "@/components/beep";

// 荷物が届いたら、送り状の追跡番号のバーコードを読む（または注文番号を入れる）と、その仕入れが開く
export function ArrivalScan() {
  const [state, action, pending] = useActionState<ArrivalState, FormData>(findArrivalAction, null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state) return;
    beep(false);
    inputRef.current?.select();
  }, [state]);

  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          荷物が届いたら：送り状の追跡番号を読む（注文番号でも探せます）
          <input
            ref={inputRef}
            name="code"
            autoComplete="off"
            spellCheck={false}
            placeholder="例 1234-5678-9012"
            className="h-12 rounded-md border border-stone-400 bg-white px-3 font-mono text-lg"
          />
        </label>
        <button type="submit" disabled={pending} className="h-12 rounded-md bg-stone-800 px-5 font-bold text-white disabled:opacity-60">
          開く
        </button>
      </form>
      {state && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-amber-100 px-4 py-3 text-amber-950">
          <span>{state.message}</span>
          {state.purchaseIds?.map((id) => (
            <Link key={id} href={`/purchases/${id}`} className="font-bold underline">
              仕入れ #{id}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
