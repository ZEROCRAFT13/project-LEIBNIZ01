"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { confirmDraftAction, createDraftAction, type DraftFormState } from "@/app/purchases/drafts/actions";
import { yen } from "@/lib/format";
import { partCategoryLabel, paymentMethodLabel } from "@/lib/labels";
import { PAYMENT_METHODS } from "@/lib/purchase-calc";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";

function Problem({ state }: { state: DraftFormState }) {
  if (!state) return null;
  return (
    <div role="alert" className="flex flex-wrap gap-3 rounded-md bg-red-100 px-4 py-3 text-red-900">
      <span>{state.message}</span>
      {state.existingDraftId && (
        <Link href={`/purchases/drafts/${state.existingDraftId}`} className="font-bold underline">
          その下書きを開く
        </Link>
      )}
      {state.existingPurchaseId && (
        <Link href={`/purchases/${state.existingPurchaseId}`} className="font-bold underline">
          その仕入れを開く
        </Link>
      )}
    </div>
  );
}

// 注文確認メールの本文を貼り付ける欄
export function PasteMailForm() {
  const [state, action, pending] = useActionState<DraftFormState, FormData>(createDraftAction, null);
  const [mail, setMail] = useState("");
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium">
        注文確認メールの本文（メールを開いて、全部選んでコピーし、ここに貼り付け）
        <textarea
          name="mail"
          value={mail}
          onChange={(e) => setMail(e.target.value)}
          rows={8}
          spellCheck={false}
          className="rounded-md border border-stone-400 bg-white p-3 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-stone-600">
        貼り付けた本文は保存しません（宛名や住所が入っているため）。読み取った注文番号・明細・金額だけを残します。
      </p>
      <Problem state={state} />
      <button
        type="submit"
        disabled={pending || mail.trim() === ""}
        className="h-12 w-fit rounded-md bg-blue-800 px-5 font-bold text-white disabled:opacity-60"
      >
        {pending ? "読み取り中…" : "読み取って下書きを作る"}
      </button>
    </form>
  );
}

type Model = { id: number; category: string; maker: string; modelNo: string; name: string };
type Line = {
  description: string;
  qty: number;
  unitPrice: number | null;
  lineTotal: number;
  kind: "item" | "fee";
  suggestedModelId: number | null;
};

// 下書きを確かめて確定する。明細ごとに部品の型番を選ぶ（覚えている対応は最初から選ばれている）
export function ConfirmDraftForm({
  draftId,
  suppliers,
  models,
  initial,
  lines,
}: {
  draftId: number;
  suppliers: { id: number; name: string }[];
  models: Model[];
  initial: { supplierId: number | null; orderedOn: string | null; paymentMethod: string | null };
  lines: Line[];
}) {
  const [state, action, pending] = useActionState<DraftFormState, FormData>(confirmDraftAction, null);
  const [head, setHead] = useState({
    supplierId: initial.supplierId ? String(initial.supplierId) : "",
    orderedOn: initial.orderedOn ?? "",
    paymentMethod: initial.paymentMethod ?? "card",
  });
  const [choices, setChoices] = useState(
    lines.map((l) => (l.kind === "fee" ? "other" : l.suggestedModelId ? String(l.suggestedModelId) : "")),
  );
  const categories = [...new Set(models.map((m) => m.category))];
  const ready = head.supplierId !== "" && head.orderedOn !== "" && choices.every((c) => c !== "");

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="lineCount" value={lines.length} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          仕入先
          <select
            name="supplierId"
            value={head.supplierId}
            onChange={(e) => setHead((h) => ({ ...h, supplierId: e.target.value }))}
            className={inputClass}
          >
            <option value="">選んでください</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          注文日
          <input
            name="orderedOn"
            type="date"
            value={head.orderedOn}
            onChange={(e) => setHead((h) => ({ ...h, orderedOn: e.target.value }))}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          支払い方法
          <select
            name="paymentMethod"
            value={head.paymentMethod}
            onChange={(e) => setHead((h) => ({ ...h, paymentMethod: e.target.value }))}
            className={inputClass}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {paymentMethodLabel[m]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-stone-600">
        一覧にない部品・仕入先は{" "}
        <a href="/settings/parts/new" target="_blank" rel="noopener" className="text-blue-800 underline">
          型番を追加
        </a>
        ・
        <a href="/settings/suppliers/new" target="_blank" rel="noopener" className="text-blue-800 underline">
          仕入先を追加
        </a>
        （別のタブで開きます。追加したら、この画面を読み込み直してください。下書きは残っています）
      </p>
      <ol className="flex flex-col gap-3">
        {lines.map((l, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-md border border-stone-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{l.description}</span>
              <span className="font-mono text-sm">
                {l.unitPrice !== null ? `${yen(l.unitPrice)} × ${l.qty}` : `${l.qty}個`} = {yen(l.lineTotal)}
              </span>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="flex items-center gap-2">
                こちらの部品
                {l.suggestedModelId && choices[i] === String(l.suggestedModelId) && (
                  <span className="rounded bg-green-100 px-2 text-xs text-green-900">前に選んだ対応</span>
                )}
              </span>
              <select
                name={`line-${i}`}
                aria-label={`${i + 1}行目の部品`}
                value={choices[i]}
                onChange={(e) => setChoices((cs) => cs.map((c, j) => (j === i ? e.target.value : c)))}
                className={`${inputClass} ${choices[i] === "" ? "border-amber-600 bg-amber-50" : ""}`}
              >
                <option value="">選んでください</option>
                {categories.map((c) => (
                  <optgroup key={c} label={partCategoryLabel[c] ?? c}>
                    {models
                      .filter((m) => m.category === c)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}（{m.maker} {m.modelNo}）
                        </option>
                      ))}
                  </optgroup>
                ))}
                <option value="other">部品以外（送料・手数料など）</option>
              </select>
            </label>
          </li>
        ))}
      </ol>

      <Problem state={state} />
      <button
        type="submit"
        disabled={pending || !ready}
        className="h-14 rounded-md bg-blue-800 text-lg font-bold text-white disabled:opacity-60"
      >
        {pending ? "確定中…" : ready ? "確定して仕入れにする" : "部品をすべて選ぶと確定できます"}
      </button>
      <p className="text-xs text-stone-600">
        選んだ部品は、このショップの商品名と一緒に覚えて、次の下書きから自動で選びます。
      </p>
    </form>
  );
}
