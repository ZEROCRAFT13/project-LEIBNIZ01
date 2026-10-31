"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createPurchaseAction, type CreateState } from "@/app/purchases/actions";
import { yen } from "@/lib/format";
import { partCategoryLabel, paymentMethodLabel } from "@/lib/labels";
import { PAYMENT_METHODS, purchaseTotals } from "@/lib/purchase-calc";

type Supplier = { id: number; name: string };
type Model = { id: number; category: string; maker: string; modelNo: string; name: string };

type Line = { key: number; model: string; description: string; qty: string; unitPrice: string };

const OTHER = "other";

function toInt(s: string): number {
  const t = s.normalize("NFKC").replace(/[,\s円¥]/g, "");
  return /^\d+$/.test(t) ? Number(t) : 0;
}

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";

// 仕入れの登録。領収書や注文確認メールを見ながら、明細を1行ずつ入れる。
// 合計はその場で計算して見せるが、登録するときにサーバーで計算し直す。
export function PurchaseForm({ suppliers, models, today }: { suppliers: Supplier[]; models: Model[]; today: string }) {
  const [state, action, pending] = useActionState<CreateState, FormData>(createPurchaseAction, null);
  const [lines, setLines] = useState<Line[]>([{ key: 1, model: "", description: "", qty: "1", unitPrice: "" }]);
  const [nextKey, setNextKey] = useState(2);
  // 入力欄はすべて state で持つ（エラーで戻ったときに、入れた内容が消えないように）
  const [head, setHead] = useState({ supplierId: "", orderNo: "", orderedOn: today, paymentMethod: "card", tax: "" });
  const setH = (patch: Partial<typeof head>) => setHead((h) => ({ ...h, ...patch }));

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = (preset?: Partial<Line>) => {
    setLines((ls) => [...ls, { key: nextKey, model: "", description: "", qty: "1", unitPrice: "", ...preset }]);
    setNextKey((k) => k + 1);
  };

  const { total, tax } = purchaseTotals(lines.map((l) => ({ qty: toInt(l.qty), unitPrice: toInt(l.unitPrice) })));
  const payload = JSON.stringify(
    lines.map((l) => ({
      partModelId: l.model === OTHER ? null : l.model === "" ? "none" : l.model,
      description: l.model === OTHER ? l.description : "",
      qty: l.qty,
      unitPrice: l.unitPrice,
    })),
  );

  const categories = [...new Set(models.map((m) => m.category))];

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="lines" value={payload} />

      <section className="grid gap-4 rounded-lg border border-stone-300 bg-white p-5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          仕入先
          <select name="supplierId" required value={head.supplierId} onChange={(e) => setH({ supplierId: e.target.value })} className={inputClass}>
            <option value="" disabled>
              選んでください
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          仕入先の注文番号（あれば）
          <input name="orderNo" maxLength={60} autoComplete="off" value={head.orderNo} onChange={(e) => setH({ orderNo: e.target.value })} className={`${inputClass} font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          注文日
          <input name="orderedOn" type="date" required max={today} value={head.orderedOn} onChange={(e) => setH({ orderedOn: e.target.value })} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          支払い方法
          <select name="paymentMethod" required value={head.paymentMethod} onChange={(e) => setH({ paymentMethod: e.target.value })} className={inputClass}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {paymentMethodLabel[m]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-5">
        <h2 className="font-bold">明細（単価は税込）</h2>
        <ol className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <li key={l.key} className="grid gap-2 border-b border-stone-100 pb-3 last:border-0 sm:grid-cols-[1fr_5rem_8rem_auto]">
              <div className="flex flex-col gap-2">
                <label className="sr-only" htmlFor={`model-${l.key}`}>
                  {i + 1}行目の部品
                </label>
                <select
                  id={`model-${l.key}`}
                  value={l.model}
                  onChange={(e) => update(l.key, { model: e.target.value })}
                  className={inputClass}
                >
                  <option value="">部品を選んでください</option>
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
                  <option value={OTHER}>部品以外（送料・手数料など）</option>
                </select>
                {l.model === OTHER && (
                  <input
                    aria-label={`${i + 1}行目の内容`}
                    placeholder="内容（例: 送料）"
                    value={l.description}
                    maxLength={100}
                    onChange={(e) => update(l.key, { description: e.target.value })}
                    className={inputClass}
                  />
                )}
              </div>
              <label className="flex flex-col gap-1 text-xs sm:text-sm">
                <span className="sm:sr-only">数量</span>
                <input
                  aria-label={`${i + 1}行目の数量`}
                  inputMode="numeric"
                  value={l.qty}
                  onChange={(e) => update(l.key, { qty: e.target.value })}
                  className={`${inputClass} text-right`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs sm:text-sm">
                <span className="sm:sr-only">単価（税込）</span>
                <input
                  aria-label={`${i + 1}行目の単価（税込）`}
                  inputMode="numeric"
                  placeholder="円"
                  value={l.unitPrice}
                  onChange={(e) => update(l.key, { unitPrice: e.target.value })}
                  className={`${inputClass} text-right font-mono`}
                />
              </label>
              <button
                type="button"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                disabled={lines.length === 1}
                className="h-11 whitespace-nowrap rounded-md px-3 text-sm text-red-800 disabled:invisible"
              >
                行を消す
              </button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => addLine()} className="h-10 rounded-md border border-stone-400 px-4 text-sm">
            ＋ 部品の行を足す
          </button>
          <button
            type="button"
            onClick={() => addLine({ model: OTHER, description: "送料" })}
            className="h-10 rounded-md border border-stone-400 px-4 text-sm"
          >
            ＋ 送料の行を足す
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <span className="font-bold">合計（税込）</span>
          <span className="font-mono text-2xl font-bold">{yen(total)}</span>
        </div>
        <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            うち消費税（領収書に書いてある額。空なら <span className="font-mono">{yen(tax)}</span> で登録）
          </span>
          <input name="tax" inputMode="numeric" placeholder={String(tax)} value={head.tax} onChange={(e) => setH({ tax: e.target.value })} className={`${inputClass} w-36 text-right font-mono`} />
        </label>
      </section>

      {state && (
        <div role="alert" className="flex flex-col gap-1 rounded-md bg-red-100 px-4 py-3 text-red-900">
          {state.errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
          {state.existingId && (
            <Link href={`/purchases/${state.existingId}`} className="font-bold underline">
              登録済みの仕入れを開く
            </Link>
          )}
        </div>
      )}

      <button type="submit" disabled={pending} className="h-14 rounded-md bg-blue-800 text-lg font-bold text-white disabled:opacity-60">
        {pending ? "登録中…" : "仕入れを登録する（入荷は次の画面で）"}
      </button>
    </form>
  );
}
