"use client";

import Link from "next/link";
import { useActionState } from "react";
import { importInboxAction, type InboxState } from "@/app/documents/actions";

// 共有の取り込みフォルダにあるファイルをまとめて取り込む
export function InboxButton({ folder }: { folder: string | null }) {
  const [state, action, pending] = useActionState<InboxState, FormData>(importInboxAction, null);
  const added = state?.results.filter((r) => r.status === "added") ?? [];
  const dups = state?.results.filter((r) => r.status === "duplicate") ?? [];
  const rejected = state?.results.filter((r) => r.status === "rejected") ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-stone-700">
        フォルダ：<span className="break-all font-mono">{folder ?? "（未設定）"}</span>
      </p>
      <form action={action}>
        <button
          type="submit"
          disabled={pending || !folder}
          className="h-12 rounded-md bg-blue-800 px-5 font-bold text-white disabled:opacity-60"
        >
          {pending ? "取り込み中…" : "取り込みフォルダから取り込む"}
        </button>
      </form>
      {state && (
        <div role="status" className="flex flex-col gap-1 rounded-md bg-stone-100 px-4 py-3 text-sm">
          {state.error ? (
            <p className="text-red-900">{state.error}</p>
          ) : (
            <p>
              {state.found === 0
                ? "取り込むファイルはありませんでした。"
                : `取り込み ${added.length}件・取り込み済み ${dups.length}件・取り込めなかった ${rejected.length}件`}
              {state.skipped > 0 && `（書き込み中かもしれない ${state.skipped}件は次の回に）`}
            </p>
          )}
          {added.map((r) => (
            <p key={r.id}>
              ✓ {r.name}
              {r.status === "added" && r.linkedPurchaseId ? `（仕入れ #${r.linkedPurchaseId} にひもづけ）` : ""}{" "}
              <Link href={`/documents/${r.id}`} className="font-bold text-blue-800 underline">
                開く
              </Link>
            </p>
          ))}
          {rejected.map((r, i) => (
            <p key={i} className="text-red-900">
              ✗ {r.name}：{r.status === "rejected" ? r.reason : ""}（「取り込めなかった」フォルダへ移しました）
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
