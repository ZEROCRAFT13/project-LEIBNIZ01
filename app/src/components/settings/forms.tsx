"use client";

import { useActionState } from "react";
import {
  addPartTimerAction,
  createEnrollmentAction,
  reissueEnrollmentAction,
  setPinAction,
  type CodeState,
  type MessageState,
} from "@/app/settings/actions";

// 設定画面の入力欄。結果（登録コードやエラー）をその場に出すために、ブラウザ側の部品にしている。

function hm(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

function CodeResult({ state }: { state: CodeState }) {
  if (!state) return null;
  if (state.kind === "error") {
    return (
      <p role="alert" className="rounded-md bg-red-100 px-4 py-3 text-red-900">
        {state.message}
      </p>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-1 rounded-md bg-blue-100 px-4 py-3 text-blue-950">
      <span className="text-sm">「{state.name}」の登録コード（{hm(state.expiresAt)} まで有効）</span>
      <span className="font-mono text-4xl font-bold tracking-widest">{state.code}</span>
      <span className="text-sm">
        組立用の端末で <span className="font-mono">/login/device</span> を開き、このコードを入れてください。
        コードはこの画面を閉じると二度と表示されません。
      </span>
    </div>
  );
}

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";
const buttonClass = "h-11 rounded-md bg-blue-800 px-4 font-bold text-white disabled:opacity-60";

export function NewDeviceForm() {
  const [state, action, pending] = useActionState<CodeState, FormData>(createEnrollmentAction, null);
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
          端末の名前（例: 組立台1のスマホ）
          <input name="name" required maxLength={40} className={inputClass} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          登録コードを出す
        </button>
      </form>
      <CodeResult state={state} />
    </div>
  );
}

export function ReissueButton({ deviceId }: { deviceId: number }) {
  const [state, action, pending] = useActionState<CodeState, FormData>(reissueEnrollmentAction, null);
  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <input type="hidden" name="deviceId" value={deviceId} />
        <button type="submit" disabled={pending} className="text-sm font-bold text-blue-800 underline">
          登録コードを出し直す
        </button>
      </form>
      <CodeResult state={state} />
    </div>
  );
}

function Message({ state }: { state: MessageState }) {
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

export function AddPartTimerForm() {
  const [state, action, pending] = useActionState<MessageState, FormData>(addPartTimerAction, null);
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
          名前（例: 鈴木（バイト））
          <input name="name" required maxLength={30} className={inputClass} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          追加する
        </button>
      </form>
      <Message state={state} />
    </div>
  );
}

export function SetPinForm({ userId, hasPin }: { userId: number; hasPin: boolean }) {
  const [state, action, pending] = useActionState<MessageState, FormData>(setPinAction, null);
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex items-end gap-2">
        <input type="hidden" name="userId" value={userId} />
        <label className="flex flex-col gap-1 text-sm">
          {hasPin ? "新しいPIN（4桁）" : "PIN（4桁）"}
          <input
            name="pin"
            required
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9０-９]{4}"
            maxLength={4}
            className={`${inputClass} w-28 font-mono text-lg tracking-widest`}
          />
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          {hasPin ? "決め直す" : "決める"}
        </button>
      </form>
      <Message state={state} />
    </div>
  );
}
