"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { pinLoginAction, type FormState } from "@/app/login/actions";

type Worker = { id: number; name: string; locked: boolean };

// 組立端末のログイン。名前を押して、4桁のPINを押すと自動で送る（手袋でも押せる大きさ）
export function PinPad({ workers }: { workers: Worker[] }) {
  const [selected, setSelected] = useState<Worker | null>(null);
  const [pin, setPin] = useState("");
  const [state, action, pending] = useActionState<FormState, FormData>(pinLoginAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  // 間違えたら入力を消して、もう一度入れられるようにする（結果が届いた表示のときに消す）
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    setPin("");
  }

  useEffect(() => {
    if (pin.length === 4 && !pending) formRef.current?.requestSubmit();
  }, [pin, pending]);

  const press = (d: string) => setPin((p) => (p.length < 4 ? p + d : p));

  // 物理キーボード（テンキー）でも入れられるように
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.normalize("NFKC");
      if (/^\d$/.test(key)) setPin((p) => (p.length < 4 ? p + key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Escape") {
        setSelected(null);
        setPin("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (workers.length === 0) {
    return (
      <p className="rounded-md bg-amber-100 px-4 py-3 text-amber-950">
        PINが設定されている人がいません。代表に「設定 → バイトとPIN」でPINを決めてもらってください。
      </p>
    );
  }

  if (!selected) {
    return (
      <div className="flex flex-col gap-2">
        <p className="font-bold">名前を押してください</p>
        {workers.map((w) => (
          <button
            key={w.id}
            type="button"
            disabled={w.locked}
            onClick={() => {
              setSelected(w);
              setPin("");
            }}
            className="flex h-14 w-full items-center justify-between rounded-md border border-stone-300 bg-white px-4 text-left text-lg font-medium hover:border-blue-700 disabled:bg-stone-100 disabled:text-stone-500"
          >
            {w.name}
            {w.locked && <span className="text-sm font-normal">ロック中（代表に解除を頼む）</span>}
          </button>
        ))}
      </div>
    );
  }

  return (
    <form ref={formRef} action={action} className="flex flex-col items-center gap-4">
      <input type="hidden" name="userId" value={selected.id} />
      <input type="hidden" name="pin" value={pin} />
      <p className="text-lg">
        <span className="font-bold">{selected.name}</span> さんのPIN
      </p>
      <div className="flex gap-3" aria-label={`${pin.length}桁入力済み`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 border-stone-700 ${i < pin.length ? "bg-stone-800" : "bg-white"}`}
          />
        ))}
      </div>
      {state && (
        <p role="alert" className="w-full rounded-md bg-red-100 px-4 py-3 text-center text-red-900">
          {state.message}
        </p>
      )}
      <div className="grid w-full max-w-xs grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Key key={d} onClick={() => press(d)} disabled={pending}>
            {d}
          </Key>
        ))}
        <Key
          onClick={() => {
            setSelected(null);
            setPin("");
          }}
          disabled={pending}
          small
        >
          名前を選び直す
        </Key>
        <Key onClick={() => press("0")} disabled={pending}>
          0
        </Key>
        <Key onClick={() => setPin((p) => p.slice(0, -1))} disabled={pending} small>
          1字消す
        </Key>
      </div>
      {pending && <p className="text-sm text-stone-600">確認中…</p>}
    </form>
  );
}

function Key({
  children,
  onClick,
  disabled,
  small,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-16 rounded-md border border-stone-300 bg-white font-medium active:bg-stone-200 disabled:opacity-50 ${
        small ? "text-sm" : "font-mono text-2xl"
      }`}
    >
      {children}
    </button>
  );
}
