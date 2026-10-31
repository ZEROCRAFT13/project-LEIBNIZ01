"use client";

import { useActionState, useState } from "react";
import { saveSupplierAction, savePartModelAction, type MasterState } from "@/app/settings/masters-actions";
import { partCategoryLabel } from "@/lib/labels";
import { PART_CATEGORIES, SUPPLIER_KINDS } from "@/lib/master-calc";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";
const supplierKindLabel: Record<string, string> = { shop: "ショップ", distributor: "代理店", other: "その他" };

function Result({ state }: { state: MasterState }) {
  if (!state) return null;
  return (
    <div
      role={state.ok ? "status" : "alert"}
      className={`flex flex-col gap-1 rounded-md px-4 py-3 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
    >
      {state.messages.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  );
}

function Check({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-stone-200 p-3">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0"
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-stone-600">{hint}</span>
      </span>
    </label>
  );
}

export type PartModelValues = {
  id?: number;
  category: string;
  maker: string;
  modelNo: string;
  name: string;
  janCode: string | null;
  serialRequired: boolean;
  keepBox: boolean;
  makerWarrantyMonths: number | null;
  active: boolean;
};

// 部品の型番の追加・変更
export function PartModelForm({ initial }: { initial?: PartModelValues }) {
  const [state, action, pending] = useActionState<MasterState, FormData>(savePartModelAction, null);
  const [v, setV] = useState({
    category: initial?.category ?? "",
    maker: initial?.maker ?? "",
    modelNo: initial?.modelNo ?? "",
    name: initial?.name ?? "",
    janCode: initial?.janCode ?? "",
    serialRequired: initial?.serialRequired ?? true,
    keepBox: initial?.keepBox ?? false,
    makerWarrantyMonths: initial?.makerWarrantyMonths == null ? "" : String(initial.makerWarrantyMonths),
    active: initial?.active ?? true,
  });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));

  return (
    <form action={action} className="flex flex-col gap-4">
      {initial?.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          種類
          <select
            name="category"
            value={v.category}
            onChange={(e) => set({ category: e.target.value })}
            className={inputClass}
          >
            <option value="">選んでください</option>
            {PART_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {partCategoryLabel[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          メーカー
          <input
            name="maker"
            value={v.maker}
            maxLength={60}
            onChange={(e) => set({ maker: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          型番（箱やメーカーのサイトに書いてあるもの）
          <input
            name="modelNo"
            value={v.modelNo}
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ modelNo: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          名前（画面や帳票に出す名前）
          <input
            name="name"
            value={v.name}
            maxLength={100}
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          JANコード（あれば。箱のバーコードを読んでもよい）
          <input
            name="janCode"
            value={v.janCode}
            inputMode="numeric"
            autoComplete="off"
            onChange={(e) => set({ janCode: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          メーカー保証（月数。分からなければ空）
          <input
            name="makerWarrantyMonths"
            value={v.makerWarrantyMonths}
            inputMode="numeric"
            onChange={(e) => set({ makerWarrantyMonths: e.target.value })}
            className={`${inputClass} w-32`}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Check
          name="serialRequired"
          checked={v.serialRequired}
          onChange={(b) => set({ serialRequired: b })}
          label="シリアルを1個ずつ記録する"
          hint="入荷と組立で箱・本体のシリアルを読む（CPU・GPU・メモリなど）。外すとケースのように数で扱う"
        />
        <Check
          name="keepBox"
          checked={v.keepBox}
          onChange={(b) => set({ keepBox: b })}
          label="元箱を保管する（RMA用）"
          hint="入荷のときに棚番を入れる（GPU・メモリ・電源など高いもの）"
        />
        {initial?.id && (
          <Check
            name="active"
            checked={v.active}
            onChange={(b) => set({ active: b })}
            label="使っている"
            hint="外すと、仕入れや下書きで選べなくなる（記録は残る）"
          />
        )}
      </div>
      {!initial?.id && <input type="hidden" name="active" value="1" />}
      <Result state={state} />
      <button
        type="submit"
        disabled={pending}
        className="h-12 w-fit rounded-md bg-blue-800 px-6 font-bold text-white disabled:opacity-60"
      >
        {pending ? "保存中…" : initial?.id ? "保存する" : "追加する"}
      </button>
    </form>
  );
}

export type SupplierValues = {
  id?: number;
  name: string;
  kind: string;
  invoiceRegNo: string | null;
  website: string | null;
  rmaContact: string | null;
  notes: string | null;
};

// 仕入先の追加・変更
export function SupplierForm({ initial }: { initial?: SupplierValues }) {
  const [state, action, pending] = useActionState<MasterState, FormData>(saveSupplierAction, null);
  const [v, setV] = useState({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "shop",
    invoiceRegNo: initial?.invoiceRegNo ?? "",
    website: initial?.website ?? "",
    rmaContact: initial?.rmaContact ?? "",
    notes: initial?.notes ?? "",
  });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));

  return (
    <form action={action} className="flex flex-col gap-4">
      {initial?.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          名前
          <input
            name="name"
            value={v.name}
            maxLength={60}
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          種類
          <select name="kind" value={v.kind} onChange={(e) => set({ kind: e.target.value })} className={inputClass}>
            {SUPPLIER_KINDS.map((k) => (
              <option key={k} value={k}>
                {supplierKindLabel[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          インボイス登録番号（領収書に書いてある T＋13桁）
          <input
            name="invoiceRegNo"
            value={v.invoiceRegNo}
            placeholder="T1234567890123"
            onChange={(e) => set({ invoiceRegNo: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          サイト（あれば）
          <input
            name="website"
            value={v.website}
            placeholder="https://"
            onChange={(e) => set({ website: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">
          RMAの窓口（代理店の連絡先など）
          <input
            name="rmaContact"
            value={v.rmaContact}
            maxLength={200}
            onChange={(e) => set({ rmaContact: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">
          メモ
          <textarea
            name="notes"
            value={v.notes}
            maxLength={500}
            rows={3}
            onChange={(e) => set({ notes: e.target.value })}
            className="rounded-md border border-stone-400 bg-white p-3"
          />
        </label>
      </div>
      <Result state={state} />
      <button
        type="submit"
        disabled={pending}
        className="h-12 w-fit rounded-md bg-blue-800 px-6 font-bold text-white disabled:opacity-60"
      >
        {pending ? "保存中…" : initial?.id ? "保存する" : "追加する"}
      </button>
    </form>
  );
}
