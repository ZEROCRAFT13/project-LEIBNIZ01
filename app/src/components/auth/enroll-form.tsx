"use client";

import { useActionState } from "react";
import { enrollAction, type FormState } from "@/app/login/actions";

// 組立用の端末として登録する（代表がPCで出した8桁の登録コードを入れる）
export function EnrollForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(enrollAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label htmlFor="enroll-code" className="font-medium">
        登録コード（8桁）
      </label>
      <input
        id="enroll-code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="1234-5678"
        required
        className="h-14 rounded-md border border-stone-400 bg-white px-4 font-mono text-2xl tracking-widest"
      />
      {state && (
        <p role="alert" className="rounded-md bg-red-100 px-4 py-3 text-red-900">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-14 rounded-md bg-blue-800 text-lg font-bold text-white disabled:opacity-60"
      >
        {pending ? "確認中…" : "この端末を登録する"}
      </button>
    </form>
  );
}
