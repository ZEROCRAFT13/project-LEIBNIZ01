"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { uploadDocumentAction, type UploadResult } from "@/app/documents/actions";

// ファイルを選ぶ・ドラッグして置く・スマホで撮ると、1ファイルずつ取り込む。
// purchaseId を渡すと、その仕入れにひもづける。
export function UploadBox({ purchaseId }: { purchaseId?: number }) {
  const [results, setResults] = useState<UploadResult[]>([]);
  const [pending, startTransition] = useTransition();
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = (files: File[]) => {
    if (files.length === 0) return;
    startTransition(async () => {
      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        if (purchaseId) fd.set("purchaseId", String(purchaseId));
        let r: UploadResult;
        try {
          r = await uploadDocumentAction(fd);
        } catch {
          r = { status: "rejected", name: file.name, reason: "送れませんでした（大きすぎるか、通信が切れました）。" };
        }
        setResults((rs) => [r, ...rs]);
      }
      if (inputRef.current) inputRef.current.value = "";
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload([...e.dataTransfer.files]);
        }}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center ${
          over ? "border-blue-700 bg-blue-50" : "border-stone-400 bg-white"
        }`}
      >
        <span className="font-bold">{pending ? "取り込み中…" : "ここにファイルを置く／押して選ぶ"}</span>
        <span className="text-sm text-stone-600">PDF・写真（スマホならその場で撮れます）。1ファイル20MBまで</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          disabled={pending}
          onChange={(e) => upload([...(e.target.files ?? [])])}
          className="sr-only"
        />
      </label>

      {results.length > 0 && (
        <ul aria-label="取り込んだ結果" className="flex flex-col gap-1 text-sm">
          {results.map((r, i) => (
            <li
              key={i}
              className={`rounded-md px-3 py-2 ${r.status === "rejected" ? "bg-red-100 text-red-900" : "bg-green-100 text-green-950"}`}
            >
              {r.status === "added" && (
                <>
                  ✓ {r.name} を取り込みました
                  {r.linkedPurchaseId ? `（仕入れ #${r.linkedPurchaseId} にひもづけ）` : "（要確認）"}{" "}
                  <Link href={`/documents/${r.id}`} className="font-bold underline">
                    開く
                  </Link>
                </>
              )}
              {r.status === "duplicate" && (
                <>
                  ✓ {r.name} は取り込み済みです（同じファイル）{" "}
                  <Link href={`/documents/${r.id}`} className="font-bold underline">
                    開く
                  </Link>
                </>
              )}
              {r.status === "rejected" && (
                <>
                  ✗ {r.name}：{r.reason}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
