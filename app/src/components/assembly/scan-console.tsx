"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { finishAction, scanAction, undoAction, type ScanState } from "@/app/assembly/actions";

// 組立画面の操作部分。バーコードリーダーは「文字を打ってEnterを押す」キーボードとして動くので、
// 入力欄にカーソルがあれば、読むたびにフォームが送信される。

export function ScanConsole({ mgmtNo, complete }: { mgmtNo: string; complete: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [manual, setManual] = useState(false);

  const [scanState, scan, scanning] = useActionState<ScanState, FormData>(scanAction, null);
  const [undoState, undo, undoing] = useActionState<ScanState, FormData>(undoAction, null);
  const [finishState, finish, finishing] = useActionState<ScanState, FormData>(finishAction, null);

  // いちばん新しい結果を表示する
  const latest = [scanState, undoState, finishState]
    .filter((s): s is NonNullable<ScanState> => s != null)
    .sort((a, b) => b.at - a.at)[0];

  useEffect(() => {
    if (!scanState) return;
    if (scanState.kind === "unit") {
      router.push(`/assembly/${scanState.mgmtNo}`);
      return;
    }
    beep(scanState.kind === "installed");
    inputRef.current?.focus();
  }, [scanState, router]);

  useEffect(() => {
    if (undoState || finishState) inputRef.current?.focus();
  }, [undoState, finishState]);

  const busy = scanning || undoing || finishing;

  return (
    <section aria-label="バーコードの読み取り" className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-4">
      <form action={scan} className="flex flex-col gap-2">
        <input type="hidden" name="mgmtNo" value={mgmtNo} />
        <label htmlFor="scan-code" className="flex items-center justify-between gap-2 text-sm font-medium">
          部品のバーコード
          <span
            className={`rounded px-2 py-0.5 text-xs ${focused ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}
            aria-live="polite"
          >
            {focused ? "読み取りOK" : "ここをタップしてから読む"}
          </span>
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="scan-code"
            name="code"
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode={manual ? "text" : "none"}
            enterKeyHint="go"
            placeholder={manual ? "シリアルを入力してEnter" : "読み取り機で読む"}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className={`h-14 min-w-0 flex-1 rounded-md border-2 px-3 font-mono text-lg ${
              focused ? "border-blue-700" : "border-stone-300"
            }`}
          />
          <button
            type="submit"
            disabled={busy}
            className="h-14 rounded-md bg-blue-700 px-4 text-sm font-bold text-white disabled:bg-stone-400"
          >
            {scanning ? "確認中" : "登録"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setManual((m) => !m);
            inputRef.current?.focus();
          }}
          className="self-start text-sm text-blue-800 underline"
        >
          {manual ? "読み取り機に戻す（画面キーボードを出さない）" : "手で入力する（画面キーボードを出す）"}
        </button>
      </form>

      {latest && latest.kind !== "unit" && (
        <p
          role="status"
          className={`rounded-md px-3 py-3 text-base font-medium ${
            latest.kind === "error" ? "bg-red-100 text-red-900" : "bg-green-100 text-green-900"
          }`}
        >
          {latest.kind === "error" ? "✕ " : "✓ "}
          {latest.message}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <form action={undo}>
          <input type="hidden" name="mgmtNo" value={mgmtNo} />
          <button
            type="submit"
            disabled={busy}
            className="h-12 w-full rounded-md border border-stone-300 bg-white text-sm font-medium disabled:text-stone-400"
          >
            1つ取り消す
          </button>
        </form>
        <form action={finish}>
          <input type="hidden" name="mgmtNo" value={mgmtNo} />
          <button
            type="submit"
            disabled={busy || !complete}
            className="h-12 w-full rounded-md bg-green-700 text-sm font-bold text-white disabled:bg-stone-300 disabled:text-stone-600"
          >
            組立完了 → 検品へ
          </button>
        </form>
      </div>
    </section>
  );
}

/** 読めたら高い音、だめなら低い音（画面を見なくても分かるように） */
function beep(ok: boolean) {
  try {
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = ok ? "sine" : "square";
    osc.frequency.value = ok ? 1320 : 220;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
    osc.onended = () => void ctx.close();
  } catch {
    // 音が出せない環境では何もしない
  }
}
