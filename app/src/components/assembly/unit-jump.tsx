"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isMgmtNo, normalizeCode, normalizeSearch } from "@/lib/codes";

// 本体や箱の管理番号シールを読むと、その個体の組立（または検品）の画面に移る
export function UnitJump({
  basePath = "/assembly",
  label = "管理番号のシールを読む（続きから組み立てる）",
}: {
  basePath?: "/assembly" | "/inspection";
  label?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("unit") as HTMLInputElement;
        const code = normalizeSearch(normalizeCode(input.value));
        if (!isMgmtNo(code)) {
          setError(`「${input.value}」は管理番号ではありません（ZB-で始まるシールを読んでください）。`);
          input.select();
          return;
        }
        router.push(`${basePath}/${code}`);
      }}
    >
      <label htmlFor="unit-code" className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="unit-code"
          name="unit"
          autoComplete="off"
          spellCheck={false}
          placeholder="ZB-2610-0045"
          className="h-12 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-3 font-mono text-base"
        />
        <button type="submit" className="h-12 rounded-md bg-blue-700 px-4 text-sm font-bold text-white">
          開く
        </button>
      </div>
      {error && <p className="rounded bg-red-100 px-3 py-2 text-sm text-red-900">{error}</p>}
    </form>
  );
}
